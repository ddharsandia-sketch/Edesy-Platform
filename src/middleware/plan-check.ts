import { FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../lib/prisma'
import { PLAN_LIMITS, PlanTier } from '../routes/billing'

/**
 * Call this before starting any new call to enforce plan limits.
 * Returns 402 Payment Required if workspace is over their plan limits.
 *
 * Usage in a route:
 *   app.post('/calls/outbound', {
 *     preHandler: [requireAuth, checkCallLimits]
 *   }, ...)
 */
export async function checkCallLimits(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { workspaceId } = request.user as { workspaceId: string }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { planTier: true }
  })

  const tier = (workspace?.planTier as PlanTier) || 'free'
  const limits = PLAN_LIMITS[tier]

  // Check current month's minute usage
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

  if (minutesUsed >= limits.minutesPerMonth) {
    return reply.code(402).send({
      error: `Monthly limit reached. Your ${limits.label} plan includes ${limits.minutesPerMonth} minutes. Upgrade at /dashboard/settings.`,
      minutesUsed,
      minutesAllowed: limits.minutesPerMonth,
      upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings`,
    })
  }

  // Check agent count
  const agentCount = await prisma.agent.count({ where: { workspaceId } })
  if (agentCount >= limits.agentsMax && request.method === 'POST' && request.url.includes('/agents')) {
    return reply.code(402).send({
      error: `Agent limit reached. Your ${limits.label} plan allows ${limits.agentsMax} agent(s). Upgrade to add more.`,
      agentsUsed: agentCount,
      agentsAllowed: limits.agentsMax,
    })
  }
}
