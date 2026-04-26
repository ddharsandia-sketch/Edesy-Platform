import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/auth'
import { createSubscription, verifyWebhookSignature } from '../lib/paypal'

export const PLAN_LIMITS = {
  free:         { minutesPerMonth: 100,    agentsMax: 1,   callsPerMonth: 50,     label: 'Free',        price: 0   },
  starter:      { minutesPerMonth: 2000,   agentsMax: 3,   callsPerMonth: 1000,   label: 'Starter',     price: 49  },
  growth:       { minutesPerMonth: 10000,  agentsMax: 10,  callsPerMonth: 5000,   label: 'Growth',      price: 149 },
  professional: { minutesPerMonth: 10000,  agentsMax: 10,  callsPerMonth: 5000,   label: 'Professional',price: 149 },
  enterprise:   { minutesPerMonth: 999999, agentsMax: 999, callsPerMonth: 999999, label: 'Enterprise',  price: 499 },
} as const
export type PlanTier = keyof typeof PLAN_LIMITS

// PayPal plan ID mapping — uses real PayPal subscription plan IDs
const PAYPAL_PLAN_MAP: Record<string, string> = {
  starter:      process.env.PAYPAL_STARTER_PLAN_ID    || 'P-44Y27456J85920417NHSMPCQ',
  growth:       process.env.PAYPAL_GROWTH_PLAN_ID     || 'P-7AE19890VX992554KNHSMPSA',
  professional: process.env.PAYPAL_GROWTH_PLAN_ID     || 'P-7AE19890VX992554KNHSMPSA',
  enterprise:   process.env.PAYPAL_ENTERPRISE_PLAN_ID || 'P-2GX1955558393463KNHSMP7Y',
}

export async function billingRoutes(app: FastifyInstance) {

  // ── GET /billing/plans — public ──────────────────────────────────────────────
  app.get('/billing/plans', async (_req, reply) => {
    return reply.send(
      Object.entries(PLAN_LIMITS).map(([tier, cfg]) => ({ tier, ...cfg }))
    )
  })

  // ── GET /billing/subscription — current plan + usage ─────────────────────────
  // Also aliased as /billing/status for frontend compatibility
  app.get('/billing/subscription', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { planTier: true, plan: true, planExpiresAt: true, paypalSubscriptionId: true } as any,
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
        plan: tier,
        status: workspace.paypalSubscriptionId ? 'active' : (tier === 'free' ? 'free' : 'active'),
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

  // ── GET /billing/status — alias for frontend compatibility ────────────────────
  app.get('/billing/status', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { planTier: true, plan: true, paypalSubscriptionId: true } as any,
      }) as any
      if (!workspace) return reply.code(404).send({ error: 'Workspace not found' })

      const tier = (workspace.planTier || workspace.plan || 'free') as PlanTier
      const limits = PLAN_LIMITS[tier] ?? PLAN_LIMITS.free

      return reply.send({
        tier,
        plan: tier,
        status: workspace.paypalSubscriptionId ? 'active' : 'free',
        limits,
      })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // ── POST /billing/checkout — Create a PayPal Subscription ───────────────────
  app.post('/billing/checkout', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      // Accept tier, plan, or planId — all are valid
      const body = request.body as { tier?: string; plan?: string; planId?: string }
      const tier = body.tier ?? body.plan ?? body.planId ?? ''

      if (!['starter', 'growth', 'professional', 'enterprise'].includes(tier)) {
        return reply.code(400).send({ error: `Invalid plan tier: "${tier}". Must be starter, growth, professional, or enterprise.` })
      }

      const paypalPlanId = PAYPAL_PLAN_MAP[tier]
      if (!paypalPlanId) {
        return reply.code(500).send({ error: `PayPal plan not configured for '${tier}'.` })
      }

      // Create PayPal subscription
      const subscription = await createSubscription(paypalPlanId, workspaceId) as any

      // Extract the approval URL for redirect
      const approvalLink = subscription.links?.find((l: any) => l.rel === 'approve')
      if (!approvalLink) {
        return reply.code(500).send({ error: 'PayPal did not return an approval URL.' })
      }

      return reply.send({
        checkoutUrl: approvalLink.href,
        url: approvalLink.href,
        subscriptionId: subscription.id,
        provider: 'paypal',
      })
    } catch (err: any) {
      console.error('[billing/checkout]', err.message)
      return reply.code(500).send({ error: err.message })
    }
  })

  // ── POST /billing/portal — Redirect to PayPal subscription management ────────
  app.post('/billing/portal', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { paypalSubscriptionId: true } as any,
      }) as any

      if (!workspace?.paypalSubscriptionId) {
        return reply.code(400).send({ error: 'No active PayPal subscription found. Subscribe first.' })
      }

      // PayPal doesn't have a customer portal like Stripe — redirect to PayPal account
      const portalUrl = `https://www.paypal.com/myaccount/autopay/`
      return reply.send({ portalUrl, url: portalUrl })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // ── POST /billing/webhook — PayPal webhook events ─────────────────────────────
  app.post('/billing/webhook', async (request, reply) => {
    const rawBody = (request as any).rawBody ?? Buffer.from(JSON.stringify(request.body))
    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')

    // Verify PayPal webhook signature
    const isValid = await verifyWebhookSignature(bodyStr, request.headers as any).catch(() => false)
    if (!isValid) {
      console.warn('[PAYPAL] Webhook signature verification failed')
      // Still process in dev/when PAYPAL_WEBHOOK_ID is not set
      if (process.env.NODE_ENV === 'production' && process.env.PAYPAL_WEBHOOK_ID) {
        return reply.code(400).send({ error: 'Webhook verification failed' })
      }
    }

    const event = request.body as any
    console.log(`[PAYPAL] Event: ${event.event_type}`)

    // Subscription activated
    if (event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const subscriptionId = event.resource?.id
      const workspaceId = event.resource?.custom_id
      const planId = event.resource?.plan_id

      // Map PayPal plan ID back to our tier
      const tier = Object.entries(PAYPAL_PLAN_MAP).find(([, pid]) => pid === planId)?.[0] || 'starter'

      if (workspaceId) {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: {
            plan: tier,
            planTier: tier,
            paypalSubscriptionId: subscriptionId,
          } as any,
        })
        console.log(`[PAYPAL] Workspace ${workspaceId} activated on '${tier}'`)
      }
    }

    // Payment completed
    if (event.event_type === 'PAYMENT.SALE.COMPLETED') {
      console.log(`[PAYPAL] Payment received: ${event.resource?.amount?.total} ${event.resource?.amount?.currency}`)
    }

    // Subscription cancelled or suspended
    if (
      event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED' ||
      event.event_type === 'BILLING.SUBSCRIPTION.SUSPENDED'
    ) {
      const subscriptionId = event.resource?.id
      if (subscriptionId) {
        await prisma.workspace.updateMany({
          where: { paypalSubscriptionId: subscriptionId } as any,
          data:  { planTier: 'free', plan: 'free' } as any,
        })
        console.log(`[PAYPAL] Subscription ${subscriptionId} cancelled — downgraded to free`)
      }
    }

    return reply.send({ received: true })
  })
}
