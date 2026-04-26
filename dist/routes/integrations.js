"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationRoutes = integrationRoutes;
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
async function integrationRoutes(fastify) {
    // GET /integrations — list all integrations for workspace
    fastify.get('/integrations', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const integrations = await prisma_1.prisma.integration.findMany({
            where: { workspaceId },
            orderBy: { createdAt: 'asc' },
            select: {
                id: true,
                type: true,
                label: true,
                enabled: true,
                lastTestedAt: true,
                lastTestOk: true,
                createdAt: true,
                // Never expose apiKey in list response
            },
        });
        return reply.send(integrations);
    });
    // POST /integrations — create or update an integration
    fastify.post('/integrations', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { type, label, apiKey, config, enabled } = request.body;
        if (!type || !label || !apiKey) {
            return reply.status(400).send({ error: 'type, label, and apiKey are required' });
        }
        // Upsert by workspaceId + type (one integration per type per workspace)
        const existing = await prisma_1.prisma.integration.findFirst({
            where: { workspaceId, type },
        });
        let integration;
        if (existing) {
            integration = await prisma_1.prisma.integration.update({
                where: { id: existing.id },
                data: { label, apiKey, config: (config ?? undefined), enabled: enabled ?? existing.enabled },
            });
        }
        else {
            integration = await prisma_1.prisma.integration.create({
                data: { workspaceId, type, label, apiKey, config: (config ?? {}), enabled: enabled ?? true },
            });
        }
        return reply.send({ success: true, id: integration.id });
    });
    // PATCH /integrations/:id — toggle enabled / update config
    fastify.patch('/integrations/:id', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { id } = request.params;
        const body = request.body;
        const integration = await prisma_1.prisma.integration.findFirst({
            where: { id, workspaceId },
        });
        if (!integration)
            return reply.status(404).send({ error: 'Integration not found' });
        const updateData = {};
        if (body.enabled !== undefined)
            updateData.enabled = body.enabled;
        if (body.apiKey)
            updateData.apiKey = body.apiKey;
        if (body.config)
            updateData.config = body.config;
        if (body.label)
            updateData.label = body.label;
        const updated = await prisma_1.prisma.integration.update({
            where: { id },
            data: updateData,
        });
        return reply.send({ success: true, enabled: updated.enabled });
    });
    // DELETE /integrations/:id
    fastify.delete('/integrations/:id', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { id } = request.params;
        const integration = await prisma_1.prisma.integration.findFirst({ where: { id, workspaceId } });
        if (!integration)
            return reply.status(404).send({ error: 'Not found' });
        await prisma_1.prisma.integration.delete({ where: { id } });
        return reply.send({ success: true });
    });
    // POST /integrations/:id/test — fire a test payload to validate credentials
    fastify.post('/integrations/:id/test', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { id } = request.params;
        const integration = await prisma_1.prisma.integration.findFirst({ where: { id, workspaceId } });
        if (!integration)
            return reply.status(404).send({ error: 'Not found' });
        const testPayload = {
            callId: 'test-' + Date.now(),
            callerNumber: '+10000000000',
            callerName: 'Test User',
            agentName: 'Test Agent',
            agentId: 'test',
            durationSeconds: 60,
            sentiment: 'positive',
            summary: 'This is a test call fired from VoxPilot integrations page.',
            transcript: 'Agent: Hello! This is a test. Caller: Got it, thanks!',
            direction: 'inbound',
            cost: 0.01,
            language: 'en',
            startTime: new Date(),
        };
        try {
            const { triggerIntegrations } = await Promise.resolve().then(() => __importStar(require('../lib/integrations')));
            await triggerIntegrations(workspaceId, testPayload);
            return reply.send({ success: true, message: 'Test payload sent' });
        }
        catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        }
    });
}
