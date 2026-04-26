"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentService = exports.AgentService = void 0;
const prisma_1 = require("../lib/prisma");
const redis_1 = require("../lib/redis");
/**
 * Agent Service - Business logic for agent operations
 */
class AgentService {
    /**
     * Get agent by phone number
     */
    async getAgentByPhoneNumber(number) {
        // Check cache first
        const cached = await redis_1.redis.get(`agent:phone:${number}`);
        if (cached) {
            return JSON.parse(cached);
        }
        const phoneNumber = await prisma_1.prisma.phoneNumber.findUnique({
            where: { number },
            include: { agent: { include: { workspace: true } } }
        });
        if (phoneNumber) {
            // Cache for 5 minutes
            await redis_1.redis.setex(`agent:phone:${number}`, 300, JSON.stringify(phoneNumber));
        }
        return phoneNumber;
    }
    /**
     * Get agent by ID with relations
     */
    async getAgentById(id) {
        return prisma_1.prisma.agent.findUnique({
            where: { id },
            include: {
                workspace: true,
                phoneNumbers: { orderBy: { createdAt: 'desc' } }
            }
        });
    }
    /**
     * Get agents by workspace ID
     */
    async getAgentsByWorkspace(workspaceId) {
        return prisma_1.prisma.agent.findMany({
            where: { workspaceId, isActive: true },
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { calls: true } } }
        });
    }
    /**
     * Create a new agent
     */
    async createAgent(data) {
        return prisma_1.prisma.agent.create({
            data: {
                ...data,
                language: 'en',
                voiceProvider: 'elevenlabs',
                sttProvider: 'deepgram',
                useGeminiLive: false,
                isActive: true
            }
        });
    }
    /**
     * Invalidate agent cache
     */
    async invalidateAgentCache(agentId) {
        const keys = await redis_1.redis.keys(`agent:*:${agentId}`);
        if (keys.length > 0) {
            await redis_1.redis.del(keys);
        }
    }
}
exports.AgentService = AgentService;
exports.agentService = new AgentService();
