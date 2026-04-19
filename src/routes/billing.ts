import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { createSubscription } from '../lib/paypal'
import { requireAuth } from '../middleware/auth'

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
        planId: process.env[`PAYPAL_${tier.toUpperCase()}_PLAN_ID`] ?? null,
      }))
    )
  })

  /**
   * GET /billing/subscription
   * Returns the current workspace's subscription status.
   */
  app.get('/billing/subscription', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        paypalPayerId: true,
        paypalSubscriptionId: true,
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
      paypalSubscriptionId: workspace.paypalSubscriptionId,
    })
  })

  /**
   * POST /billing/checkout
   * Create a PayPal Subscription request.
   * Returns approval URL and subscription ID.
   *
   * Body: { tier: "starter" | "growth" | "enterprise" }
   */
  app.post('/billing/checkout', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { tier } = request.body as { tier: PlanTier }

    if (!['starter', 'growth', 'enterprise'].includes(tier)) {
      return reply.code(400).send({ error: 'Invalid tier. Must be: starter, growth, or enterprise' })
    }

    const planId = process.env[`PAYPAL_${tier.toUpperCase()}_PLAN_ID`]
    if (!planId) return reply.code(500).send({ error: `PayPal Plan ID for ${tier} not configured` })

    try {
      const subscription: any = await createSubscription(planId, workspaceId)
      
      // Get the approval link from the response
      const approvalUrl = subscription.links?.find((l: any) => l.rel === 'approve')?.href

      return reply.send({ 
        checkoutUrl: approvalUrl,
        subscriptionId: subscription.id 
      })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  /**
   * POST /billing/portal
   * For PayPal, there is no generic "billing portal" session like Stripe.
   * We redirect users to their PayPal account subscriptions page.
   */
  app.post('/billing/portal', { preHandler: requireAuth }, async (request, reply) => {
    // PayPal Subscriptions are managed directly in the user's PayPal account
    return reply.send({ 
       portalUrl: 'https://www.paypal.com/myaccount/autopay/' 
    })
  })
}
