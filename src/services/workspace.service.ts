import { prisma } from '../lib/prisma'
import { redis } from '../lib/redis'

/**
 * Workspace Service - Business logic for workspace operations
 */
export class WorkspaceService {
  /**
   * Get workspace by ID with usage stats
   */
  async getWorkspaceById(id: string) {
    // Check cache first
    const cached = await redis.get(`workspace:${id}`)
    if (cached) {
      return JSON.parse(cached)
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        _count: {
          select: { agents: true, calls: true, campaigns: true }
        }
      }
    })

    if (workspace) {
      await redis.setex(`workspace:${id}`, 60, JSON.stringify(workspace))
    }

    return workspace
  }

  /**
   * Get workspace usage
   */
  async getWorkspaceUsage(workspaceId: string) {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const callsThisMonth = await prisma.call.count({
      where: {
        workspaceId,
        startTime: { gte: monthStart }
      }
    })

    const totalDurationThisMonth = await prisma.call.aggregate({
      where: {
        workspaceId,
        startTime: { gte: monthStart }
      },
      _sum: { duration: true }
    })

    return {
      callsThisMonth,
      minutesThisMonth: Math.ceil((totalDurationThisMonth._sum.duration || 0) / 60)
    }
  }

  /**
   * Update workspace plan
   */
  async updatePlan(workspaceId: string, planTier: string, planExpiresAt?: Date) {
    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: { planTier, planExpiresAt }
    })

    await this.invalidateWorkspaceCache(workspaceId)
    return workspace
  }

  /**
   * Invalidate workspace cache
   */
  async invalidateWorkspaceCache(workspaceId: string) {
    await redis.del(`workspace:${workspaceId}`)
  }

  /**
   * Check if workspace has quota available
   */
  async hasQuota(workspaceId: string, minutesRequired: number = 1): Promise<boolean> {
    const workspace = await this.getWorkspaceById(workspaceId)
    if (!workspace) return false

    const usage = await this.getWorkspaceUsage(workspaceId)

    const limits: Record<string, number> = {
      free: 100,
      starter: 1000,
      pro: 10000,
      enterprise: 100000
    }

    const limit = limits[workspace.planTier] || 100
    return usage.minutesThisMonth + minutesRequired <= limit
  }
}

export const workspaceService = new WorkspaceService()
