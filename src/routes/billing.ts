import { FastifyInstance } from 'fastify'
import Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/auth'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-04-22.dahlia' as any,
})

export const PLAN_LIMITS = {
  free:         { minutesPerMonth: 100,    agentsMax: 1,   callsPerMonth: 50,     label: 'Free',        price: 0   },
  starter:      { minutesPerMonth: 2000,   agentsMax: 3,   callsPerMonth: 1000,   label: 'Starter',     price: 49  },
  growth:       { minutesPerMonth: 10000,  agentsMax: 10,  callsPerMonth: 5000,   label: 'Growth',      price: 149 },
  professional: { minutesPerMonth: 10000,  agentsMax: 10,  callsPerMonth: 5000,   label: 'Professional',price: 149 },
  enterprise:   { minutesPerMonth: 999999, agentsMax: 999, callsPerMonth: 999999, label: 'Enterprise',  price: 499 },
} as const
export type PlanTier = keyof typeof PLAN_LIMITS

const PRICE_MAP: Record<string, string> = {
  starter:      process.env.STRIPE_PRICE_ID_STARTER!,
  growth:       process.env.STRIPE_PRICE_ID_GROWTH!,
  professional: process.env.STRIPE_PRICE_ID_GROWTH!,   // alias
  enterprise:   process.env.STRIPE_PRICE_ID_ENTERPRISE!,
}

export async function billingRoutes(app: FastifyInstance) {

  // ── GET /billing/plans — public ───────────────────────────────────────────
  app.get('/billing/plans', async (_req, reply) => {
    return reply.send(
      Object.entries(PLAN_LIMITS).map(([tier, cfg]) => ({ tier, ...cfg }))
    )
  })

  // ── GET /billing/subscription — current plan + usage ─────────────────────
  app.get('/billing/subscription', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { planTier: true, plan: true, planExpiresAt: true, stripeSubscriptionId: true } as any,
      }) as any
      if (!workspace) return reply.code(404).send({ error: 'Workspace not found' })

      const startOfMonth = new Date()
      startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0)

      const usage = await prisma.call.aggregate({
        where: { workspaceId, startTime: { gte: startOfMonth }, status: 'completed' },
        _sum:  { duration: true },
      })
      const minutesUsed = Math.ceil((usage._sum.duration || 0) / 60)
      const tier = (workspace.planTier || workspace.plan || 'free') as PlanTier
      const limits = PLAN_LIMITS[tier] ?? PLAN_LIMITS.free

      return reply.send({
        tier,
        limits,
        usage: {
          minutesUsed,
          minutesRemaining: Math.max(0, limits.minutesPerMonth - minutesUsed),
          pctUsed: Math.min(100, Math.round((minutesUsed / limits.minutesPerMonth) * 100)),
        },
      })
    } catch (err: any) {
      console.error('[billing/subscription]', err.message)
      return reply.code(500).send({ error: err.message })
    }
  })

  // ── POST /billing/checkout — Stripe Checkout session (card, no PayPal) ────
  app.post('/billing/checkout', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      // Accept both "tier" (new) and "plan" (legacy) field names
      const body = request.body as { tier?: string; plan?: string }
      const tier = body.tier ?? body.plan ?? ''

      if (!['starter', 'growth', 'professional', 'enterprise'].includes(tier)) {
        return reply.code(400).send({ error: `Invalid plan tier: ${tier}` })
      }

      const priceId = PRICE_MAP[tier]
      if (!priceId) {
        return reply.code(500).send({ error: `Stripe price not configured for '${tier}'. Add STRIPE_PRICE_ID_${tier.toUpperCase()} to env.` })
      }

      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, stripeCustomerId: true } as any,
      }) as any
      if (!workspace) return reply.code(404).send({ error: 'Workspace not found' })

      let customerId = workspace.stripeCustomerId
      if (!customerId) {
        const customer = await stripe.customers.create({ name: workspace.name, metadata: { workspaceId } })
        customerId = customer.id
        await prisma.workspace.update({ where: { id: workspaceId }, data: { stripeCustomerId: customerId } as any })
      }

      const session = await stripe.checkout.sessions.create({
        customer:                  customerId,
        mode:                      'subscription',
        line_items:                [{ price: priceId, quantity: 1 }],
        payment_method_collection: 'always',
        success_url: `${process.env.FRONTEND_URL}/dashboard/settings?billing=success&plan=${tier}`,
        cancel_url:  `${process.env.FRONTEND_URL}/dashboard/settings?billing=cancelled`,
        metadata:    { workspaceId, tier, plan: tier },
      })

      // Return BOTH field names for forward + backward compat
      return reply.send({ checkoutUrl: session.url, url: session.url })
    } catch (err: any) {
      console.error('[billing/checkout]', err.message)
      return reply.code(500).send({ error: err.message })
    }
  })

  // ── POST /billing/portal — manage existing subscription ───────────────────
  app.post('/billing/portal', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      const workspace = await prisma.workspace.findUnique({
        where:  { id: workspaceId },
        select: { stripeCustomerId: true } as any,
      }) as any

      if (!workspace?.stripeCustomerId) {
        return reply.code(400).send({ error: 'No billing account found. Subscribe first.' })
      }

      const portal = await stripe.billingPortal.sessions.create({
        customer:   workspace.stripeCustomerId,
        return_url: `${process.env.FRONTEND_URL}/dashboard/settings`,
      })
      // Return both field names for compat
      return reply.send({ portalUrl: portal.url, url: portal.url })
    } catch (err: any) {
      console.error('[billing/portal]', err.message)
      return reply.code(500).send({ error: err.message })
    }
  })

  // ── POST /billing/webhook — Stripe events ────────────────────────────────
  app.post('/billing/webhook', async (request, reply) => {
    const sig  = request.headers['stripe-signature'] as string
    const body = (request as any).rawBody ?? JSON.stringify(request.body)

    let event: any
    try {
      event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
    } catch (err: any) {
      return reply.code(400).send({ error: `Webhook error: ${err.message}` })
    }

    if (event.type === 'checkout.session.completed') {
      const s           = event.data.object
      const workspaceId = s.metadata?.workspaceId
      const tier        = s.metadata?.tier ?? s.metadata?.plan
      if (workspaceId && tier) {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data:  { planTier: tier, plan: tier, stripeSubscriptionId: s.subscription as string } as any,
        })
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object
      await prisma.workspace.updateMany({
        where: { stripeSubscriptionId: sub.id } as any,
        data:  { planTier: 'free', plan: 'free' } as any,
      })
    }

    return reply.send({ received: true })
  })
}

