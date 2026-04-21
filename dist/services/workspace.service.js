"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workspaceService = exports.WorkspaceService = void 0;
const prisma_1 = require("../lib/prisma");
const redis_1 = require("../lib/redis");
/**
 * Workspace Service - Business logic for workspace operations
 */
class WorkspaceService {
    /**
     * Get workspace by ID with usage stats
     */
    async getWorkspaceById(id) {
        // Check cache first
        const cached = await redis_1.redis.get(`workspace:${id}`);
        if (cached) {
            return JSON.parse(cached);
        }
        const workspace = await prisma_1.prisma.workspace.findUnique({
            where: { id },
            include: {
                _count: {
                    select: { agents: true, calls: true, campaigns: true }
                }
            }
        });
        if (workspace) {
            await redis_1.redis.setex(`workspace:${id}`, 60, JSON.stringify(workspace));
        }
        return workspace;
    }
    /**
     * Get workspace usage
     */
    async getWorkspaceUsage(workspaceId) {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const callsThisMonth = await prisma_1.prisma.call.count({
            where: {
                workspaceId,
                startTime: { gte: monthStart }
            }
        });
        const totalDurationThisMonth = await prisma_1.prisma.call.aggregate({
            where: {
                workspaceId,
                startTime: { gte: monthStart }
            },
            _sum: { duration: true }
        });
        return {
            callsThisMonth,
            minutesThisMonth: Math.ceil((totalDurationThisMonth._sum.duration || 0) / 60)
        };
    }
    /**
     * Update workspace plan
     */
    async updatePlan(workspaceId, planTier, planExpiresAt) {
        const workspace = await prisma_1.prisma.workspace.update({
            where: { id: workspaceId },
            data: { planTier, planExpiresAt }
        });
        await this.invalidateWorkspaceCache(workspaceId);
        return workspace;
    }
    /**
     * Invalidate workspace cache
     */
    async invalidateWorkspaceCache(workspaceId) {
        await redis_1.redis.del(`workspace:${workspaceId}`);
    }
    /**
     * Check if workspace has quota available
     */
    async hasQuota(workspaceId, minutesRequired = 1) {
        const workspace = await this.getWorkspaceById(workspaceId);
        if (!workspace)
            return false;
        const usage = await this.getWorkspaceUsage(workspaceId);
        const limits = {
            free: 100,
            starter: 1000,
            pro: 10000,
            enterprise: 100000
        };
        const limit = limits[workspace.planTier] || 100;
        return usage.minutesThisMonth + minutesRequired <= limit;
    }
}
exports.WorkspaceService = WorkspaceService;
exports.workspaceService = new WorkspaceService();
