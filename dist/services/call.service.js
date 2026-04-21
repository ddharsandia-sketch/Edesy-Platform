"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callService = exports.CallService = void 0;
const prisma_1 = require("../lib/prisma");
/**
 * Call Service - Business logic for call operations
 */
class CallService {
    /**
     * Get call by ID with relations
     */
    async getCallById(id) {
        return prisma_1.prisma.call.findUnique({
            where: { id },
            include: { agent: true }
        });
    }
    /**
     * Get calls by workspace ID with pagination
     */
    async getCallsByWorkspace(workspaceId, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [calls, total] = await Promise.all([
            prisma_1.prisma.call.findMany({
                where: { workspaceId },
                orderBy: { startTime: 'desc' },
                skip,
                take: limit,
                include: { agent: { select: { id: true, name: true } } }
            }),
            prisma_1.prisma.call.count({ where: { workspaceId } })
        ]);
        return {
            calls,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        };
    }
    /**
     * Create a new call record
     */
    async createCall(data) {
        return prisma_1.prisma.call.create({
            data: {
                ...data,
                status: 'dialing',
                startTime: new Date(),
                transcript: [],
                artifact: {}
            }
        });
    }
    /**
     * Update call status
     */
    async updateCallStatus(callId, status, duration) {
        return prisma_1.prisma.call.update({
            where: { id: callId },
            data: {
                status,
                endTime: new Date(),
                duration
            }
        });
    }
    /**
     * Get call metrics for dashboard
     */
    async getCallMetrics(workspaceId, days = 7) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const calls = await prisma_1.prisma.call.findMany({
            where: {
                workspaceId,
                startTime: { gte: startDate }
            }
        });
        const totalCalls = calls.length;
        const completedCalls = calls.filter(c => c.status === 'completed').length;
        const totalDuration = calls.reduce((sum, c) => sum + (c.duration || 0), 0);
        const avgDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;
        const avgSentiment = calls.length > 0
            ? calls.reduce((sum, c) => sum + (c.sentiment ?? 0), 0) / calls.length
            : 0;
        return {
            totalCalls,
            completedCalls,
            completionRate: totalCalls > 0 ? completedCalls / totalCalls : 0,
            totalDuration,
            avgDuration,
            avgSentiment
        };
    }
}
exports.CallService = CallService;
exports.callService = new CallService();
