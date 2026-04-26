import { prisma } from '../lib/prisma'
import { redis } from '../lib/redis'

/**
 * Agent Service - Business logic for agent operations
 */
export class AgentService {
  /**
   * Get agent by phone number
   */
  async getAgentByPhoneNumber(number: string) {
    // Check cache first
    const cached = await redis.get(`agent:phone:${number}`)
    if (cached) {
      return JSON.parse(cached)
    }

    const phoneNumber = await prisma.phoneNumber.findUnique({
      where: { number },
      include: { agent: { include: { workspace: true } } }
    })

    if (phoneNumber) {
      // Cache for 5 minutes
      await redis.setex(`agent:phone:${number}`, 300, JSON.stringify(phoneNumber))
    }

    return phoneNumber
  }

  /**
   * Get agent by ID with relations
   */
  async getAgentById(id: string) {
    return prisma.agent.findUnique({
      where: { id },
      include: {
        workspace: true,
        phoneNumbers: { orderBy: { createdAt: 'desc' } }
      }
    })
  }

  /**
   * Get agents by workspace ID
   */
  async getAgentsByWorkspace(workspaceId: string) {
    return prisma.agent.findMany({
      where: { workspaceId, isActive: true },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { calls: true } } }
    })
  }

  /**
   * Create a new agent
   */
  async createAgent(data: {
    workspaceId: string
    name: string
    personaPrompt: string
    voiceId: string
    llmModel: string
  }) {
    return prisma.agent.create({
      data: {
        ...data,
        language: 'en',
        voiceProvider: 'elevenlabs',
        sttProvider: 'deepgram',
        useGeminiLive: false,
        isActive: true
      }
    })
  }

  /**
   * Invalidate agent cache
   */
  async invalidateAgentCache(agentId: string) {
    const keys = await redis.keys(`agent:*:${agentId}`)
    if (keys.length > 0) {
      await redis.del(keys)
    }
  }
}

export const agentService = new AgentService()
