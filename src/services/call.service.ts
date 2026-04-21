import { prisma } from '../lib/prisma'
import { redis } from '../lib/redis'

/**
 * Call Service - Business logic for call operations
 */
export class CallService {
  /**
   * Get call by ID with relations
   */
  async getCallById(id: string) {
    return prisma.call.findUnique({
      where: { id },
      include: { agent: true }
    })
  }

  /**
   * Get calls by workspace ID with pagination
   */
  async getCallsByWorkspace(workspaceId: string, page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit

    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where: { workspaceId },
        orderBy: { startTime: 'desc' },
        skip,
        take: limit,
        include: { agent: { select: { id: true, name: true } } }
      }),
      prisma.call.count({ where: { workspaceId } })
    ])

    return {
      calls,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  }

  /**
   * Create a new call record
   */
  async createCall(data: {
    agentId: string
    workspaceId: string
    callerNumber: string
    direction: 'inbound' | 'outbound'
    twilioCallSid?: string
    exotelCallSid?: string
  }) {
    return prisma.call.create({
      data: {
        ...data,
        status: 'dialing',
        startTime: new Date(),
        transcript: [],
        artifact: {}
      }
    })
  }

  /**
   * Update call status
   */
  async updateCallStatus(callId: string, status: string, duration?: number) {
    return prisma.call.update({
      where: { id: callId },
      data: {
        status,
        endTime: new Date(),
        duration
      }
    })
  }

  /**
   * Get call metrics for dashboard
   */
  async getCallMetrics(workspaceId: string, days: number = 7) {
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    const calls = await prisma.call.findMany({
      where: {
        workspaceId,
        startTime: { gte: startDate }
      }
    })

    const totalCalls = calls.length
    const completedCalls = calls.filter(c => c.status === 'completed').length
    const totalDuration = calls.reduce((sum, c) => sum + (c.duration || 0), 0)
    const avgDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0
    const avgSentiment = calls.length > 0
      ? calls.reduce((sum, c) => sum + (c.sentiment ?? 0), 0) / calls.length
      : 0

    return {
      totalCalls,
      completedCalls,
      completionRate: totalCalls > 0 ? completedCalls / totalCalls : 0,
      totalDuration,
      avgDuration,
      avgSentiment
    }
  }
}

export const callService = new CallService()
