import { FastifyInstance } from 'fastify'
import Stripe from 'stripe'
import { prisma } from '../lib/prisma'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
})

// Plan limits — enforced on every call start
export const PLAN_LIMITS = {
  free: {
    minutesPerMonth: 100,
    agentsMax: 1,
    callsPerMonth: 50,
    label: 'Free',
    price: 0,
  },
  starter: {
    minutesPerMonth: 2000,
    agentsMax: 3,
    callsPerMonth: 1000,
    label: 'Starter',
    price: 49,
  },
  growth: {
    minutesPerMonth: 10000,
    agentsMax: 10,
    callsPerMonth: 5000,
    label: 'Growth',
    price: 149,
  },
  enterprise: {
    minutesPerMonth: 999999,  // Unlimited
    agentsMax: 999,
    callsPerMonth: 999999,
    label: 'Enterprise',
    price: 499,
  },
} as const

export type PlanTier = keyof typeof PLAN_LIMITS

export async function billingRoutes(app: FastifyInstance) {
  /**
   * GET /billing/plans
   * Returns all available plans (public — no auth required).
   * Used for the pricing page.
   */
  app.get('/billing/plans', async (request, reply) => {
    return reply.send(
      Object.entries(PLAN_LIMITS).map(([tier, config]) => ({
        tier,
        ...config,
        priceId: process.env[`STRIPE_${tier.toUpperCase()}_PRICE_ID`] ?? null,
      }))
    )
  })

  /**
   * GET /billing/subscription
   * Returns the current workspace's subscription status.
   */
  app.get('/billing/subscription', { preHandler: app.requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        planTier: true,
        planExpiresAt: true,
      }
    })

    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' })

    // Get current month usage
    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)

    const usage = await prisma.call.aggregate({
      where: {
        workspaceId,
        startTime: { gte: startOfMonth },
        status: 'completed',
      },
      _sum: { duration: true }
    })

    const minutesUsed = Math.ceil((usage._sum.duration || 0) / 60)
    const limits = PLAN_LIMITS[workspace.planTier as PlanTier] || PLAN_LIMITS.free

    return reply.send({
      tier: workspace.planTier || 'free',
      limits,
      usage: {
        minutesUsed,
        minutesRemaining: Math.max(0, limits.minutesPerMonth - minutesUsed),
        pctUsed: Math.round((minutesUsed / limits.minutesPerMonth) * 100),
      },
      stripeSubscriptionId: workspace.stripeSubscriptionId,
    })
  })

  /**
   * POST /billing/checkout
   * Create a Stripe Checkout session to upgrade/start a subscription.
   * Returns a checkout URL to redirect the user to.
   *
   * Body: { tier: "starter" | "growth" | "enterprise" }
   */
  app.post('/billing/checkout', { preHandler: app.requireAuth }, async (request, reply) => {
    const { workspaceId, email } = request.user as { workspaceId: string; email: string }
    const { tier } = request.body as { tier: PlanTier }

    if (!['starter', 'growth', 'enterprise'].includes(tier)) {
      return reply.code(400).send({ error: 'Invalid tier. Must be: starter, growth, or enterprise' })
    }

    const priceId = process.env[`STRIPE_${tier.toUpperCase()}_PRICE_ID`]
    if (!priceId) return reply.code(500).send({ error: `Price ID for ${tier} not configured` })

    // Get or create Stripe customer for this workspace
    let workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
    let stripeCustomerId = workspace?.stripeCustomerId

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { workspaceId }
      })
      stripeCustomerId = customer.id
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { stripeCustomerId }
      })
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings?billing=success`,
      cancel_url:  `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings?billing=cancelled`,
      metadata: { workspaceId, tier },
      subscription_data: {
        metadata: { workspaceId, tier }
      },
      allow_promotion_codes: true,
    })

    return reply.send({ checkoutUrl: session.url })
  })

  /**
   * POST /billing/portal
   * Create a Stripe Customer Portal session.
   * Lets users manage their subscription, update payment method, view invoices.
   */
  app.post('/billing/portal', { preHandler: app.requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId }
    })

    if (!workspace?.stripeCustomerId) {
      return reply.code(400).send({
        error: 'No active subscription found. Subscribe first.'
      })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: workspace.stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings`,
    })

    return reply.send({ portalUrl: session.url })
  })
}
