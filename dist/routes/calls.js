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
exports.callRoutes = callRoutes;
const livekit_server_sdk_1 = require("livekit-server-sdk");
const telephony_1 = require("../lib/telephony");
const uuid_1 = require("uuid");
const auth_1 = require("../middleware/auth");
const prisma_1 = require("../lib/prisma");
const redis_1 = require("../lib/redis");
const telephony = telephony_1.TelephonyManager.getInstance();
// Internal API key shared with worker
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || 'dev-internal-key';
const WORKER_URL = process.env.VOICE_WORKER_URL || 'http://localhost:8000';
async function callRoutes(app) {
    /**
     * POST /calls/inbound
     * Called by Twilio webhook when a call arrives on your Twilio number.
     */
    app.post('/calls/inbound', async (request, reply) => {
        const body = request.body;
        const phoneRecord = await prisma_1.prisma.phoneNumber.findUnique({
            where: { number: body.To },
            include: { agent: true }
        });
        if (!phoneRecord) {
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>This number is not configured. Goodbye.</Say><Hangup/></Response>`;
            return reply.header('Content-Type', 'text/xml').send(twiml);
        }
        const agent = phoneRecord.agent;
        const callId = (0, uuid_1.v4)();
        const roomName = `call-${callId}`;
        const token = new livekit_server_sdk_1.AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: `twilio-${callId}` });
        token.addGrant({ roomJoin: true, room: roomName });
        const livekitToken = await token.toJwt();
        const greetingBytes = await redis_1.redis.getBuffer(`greeting:${agent.id}`);
        await prisma_1.prisma.call.create({
            data: {
                id: callId,
                workspaceId: agent.workspaceId,
                agentId: agent.id,
                callerNumber: body.From,
                direction: 'inbound',
                status: 'dialing',
                liveKitRoomId: roomName
            }
        });
        // Spawn Python voice worker
        try {
            const response = await fetch(`${WORKER_URL}/start-call`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Key': INTERNAL_KEY
                },
                body: JSON.stringify({
                    agent_id: agent.id,
                    call_id: callId,
                    livekit_room_name: roomName,
                    livekit_token: livekitToken,
                    persona_prompt: agent.personaPrompt,
                    language: agent.language,
                    voice_id: agent.voiceId,
                    stt_provider: agent.sttProvider,
                    llm_model: agent.llmModel,
                    use_gemini_live: agent.useGeminiLive,
                    greeting_bytes: greetingBytes ? greetingBytes.toString('base64') : null
                }),
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) {
                console.error(`[API] Worker failed to start call ${callId}: ${response.statusText}`);
            }
        }
        catch (e) {
            console.error(`[API] Failed to reach worker for call ${callId}:`, e);
        }
        // Generate XML using TelephonyManager
        const twiml = telephony.generateConnectXml(roomName, livekitToken);
        return reply.header('Content-Type', 'text/xml').send(twiml);
    });
    /**
     * POST /calls/outbound
     * Start an outbound call from your agent to a target number.
     */
    app.post('/calls/outbound', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { agentId, targetNumber } = request.body;
        const agent = await prisma_1.prisma.agent.findFirst({
            where: { id: agentId, workspaceId },
            include: { phoneNumbers: true }
        });
        if (!agent)
            return reply.code(404).send({ error: 'Agent not found' });
        if (agent.phoneNumbers.length === 0) {
            return reply.code(400).send({ error: 'Agent has no phone number assigned. Add one in Settings.' });
        }
        const callId = (0, uuid_1.v4)();
        const roomName = `call-${callId}`;
        const token = new livekit_server_sdk_1.AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: `twilio-${callId}` });
        token.addGrant({ roomJoin: true, room: roomName });
        const livekitToken = await token.toJwt();
        await prisma_1.prisma.call.create({
            data: {
                id: callId,
                workspaceId,
                agentId,
                callerNumber: targetNumber,
                direction: 'outbound',
                status: 'dialing',
                liveKitRoomId: roomName
            }
        });
        await telephony.makeCall({
            to: targetNumber,
            from: agent.phoneNumbers[0].number,
            url: `${process.env.NEXT_PUBLIC_API_URL}/calls/inbound-twiml?callId=${callId}&roomName=${roomName}&token=${livekitToken}`
        });
        return reply.send({ callId, status: 'dialing', roomName });
    });
    /**
     * POST /calls/web
     * Public endpoint used by the landing page Demo Widget to connect to the AI via browser.
     * Connects via WebRTC, bypassing standard telephony providers.
     */
    app.post('/calls/web', async (request, reply) => {
        let agent = await prisma_1.prisma.agent.findFirst({
            where: { isActive: true },
            include: { workspace: true }
        });
        if (!agent) {
            const workspace = await prisma_1.prisma.workspace.findFirst() || await prisma_1.prisma.workspace.create({
                data: { name: 'Demo Workspace', ownerId: 'demo-user' }
            });
            agent = await prisma_1.prisma.agent.create({
                data: {
                    workspaceId: workspace.id,
                    name: 'Sales Assistant',
                    personaPrompt: 'You are a friendly and energetic sales assistant for Edesy Voice AI. Edesy Voice AI provides low-latency, scalable AI voice agents that users can deploy in minutes. Keep your answers brief, engaging, and focus on the ultra-low latency and WebRTC capabilities you are currently demonstrating.',
                    language: 'en',
                    voiceProvider: 'cartesia',
                    voiceId: '71a7ad14-091c-4e8e-a314-022ece01c121',
                    sttProvider: 'deepgram',
                    llmModel: 'gpt-4o-mini',
                    useGeminiLive: false,
                    isActive: true
                },
                include: { workspace: true }
            });
        }
        const callId = (0, uuid_1.v4)();
        const roomName = `webcall-${callId}`;
        const token = new livekit_server_sdk_1.AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: `web-user-${callId}`, name: 'Web User' });
        token.addGrant({ roomJoin: true, room: roomName });
        const userToken = await token.toJwt();
        const workerAuthToken = new livekit_server_sdk_1.AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: `worker-${callId}`, name: 'AI Voice' });
        workerAuthToken.addGrant({ roomJoin: true, room: roomName });
        const workerToken = await workerAuthToken.toJwt();
        await prisma_1.prisma.call.create({
            data: {
                id: callId,
                workspaceId: agent.workspaceId,
                agentId: agent.id,
                callerNumber: 'web-browser',
                direction: 'inbound',
                status: 'connected',
                liveKitRoomId: roomName
            }
        });
        try {
            const response = await fetch(`${WORKER_URL}/start-call`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Key': INTERNAL_KEY
                },
                body: JSON.stringify({
                    agent_id: agent.id,
                    call_id: callId,
                    livekit_room_name: roomName,
                    livekit_token: workerToken,
                    persona_prompt: 'You are a friendly and energetic sales assistant for Edesy Voice AI. Edesy Voice AI provides low-latency, scalable AI voice agents that users can deploy in minutes. Keep your answers brief, engaging, and focus on the ultra-low latency you are currently demonstrating.',
                    language: agent.language,
                    voice_id: agent.voiceId,
                    stt_provider: agent.sttProvider,
                    llm_model: agent.llmModel,
                    use_gemini_live: agent.useGeminiLive,
                    industry: 'general'
                }),
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) {
                console.error(`[API] Worker failed to start web call ${callId}: ${response.statusText}`);
            }
        }
        catch (e) {
            console.error(`[API] Failed to reach worker for web call ${callId}:`, e);
        }
        return reply.send({
            callId,
            roomName,
            token: userToken,
            url: process.env.LIVEKIT_URL || 'wss://your-app.livekit.cloud'
        });
    });
    /**
     * PATCH /calls/:id/status
     * Internal-only endpoint called by the Python voice worker.
     */
    app.patch('/calls/:id/status', async (request, reply) => {
        const internalKey = request.headers['x-internal-key'];
        if (internalKey !== INTERNAL_KEY) {
            return reply.code(403).send({ error: 'Forbidden' });
        }
        const { id } = request.params;
        const { status } = request.body;
        const validStatuses = [
            'dialing', 'connected', 'handling_objection',
            'extracting_data', 'completed', 'failed', 'transferred'
        ];
        if (!validStatuses.includes(status)) {
            return reply.code(400).send({
                error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }
        const updated = await prisma_1.prisma.call.update({
            where: { id },
            data: {
                status,
                ...(status === 'completed' || status === 'failed'
                    ? { endTime: new Date() }
                    : {})
            }
        });
        if (status === 'completed' || status === 'failed') {
            const { postCallQueue } = await Promise.resolve().then(() => __importStar(require('../jobs/post-call')));
            await postCallQueue.add('process-call', { callId: id }, {
                delay: 2000,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 }
            });
        }
        return reply.send({ id, status: updated.status });
    });
    /**
     * GET /calls — List calls for this workspace
     */
    app.get('/calls', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { status, agentId, limit = '50' } = request.query;
        const calls = await prisma_1.prisma.call.findMany({
            where: {
                workspaceId,
                ...(status && { status }),
                ...(agentId && { agentId })
            },
            orderBy: { startTime: 'desc' },
            take: Number(limit),
            include: { agent: { select: { name: true } } }
        });
        return reply.send(calls);
    });
    /**
     * POST /calls/:id/inject — Supervisor injects a real-time directive
     */
    app.post('/calls/:id/inject', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { id } = request.params;
        const { directive } = request.body;
        if (!directive || directive.trim().length < 5) {
            return reply.code(400).send({ error: 'Directive must be at least 5 characters' });
        }
        const call = await prisma_1.prisma.call.findFirst({
            where: { id, workspaceId, status: 'connected' }
        });
        if (!call)
            return reply.code(404).send({ error: 'Active call not found' });
        await redis_1.redis.publish(`supervisor:${id}`, directive);
        await prisma_1.prisma.call.update({
            where: { id },
            data: {
                supervisorNotes: {
                    push: { time: new Date().toISOString(), directive }
                }
            }
        });
        return reply.send({ status: 'injected', directive });
    });
    /**
     * GET /calls/:id/stream — SSE endpoint for live call monitoring
     */
    app.get('/calls/:id/stream', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { id } = request.params;
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.flushHeaders();
        const pubsub = (0, redis_1.getPubSub)().duplicate();
        await pubsub.subscribe(`transcript:${id}`, `artifact:${id}`, `call_status:${id}`);
        pubsub.on('message', (channel, message) => {
            const eventType = channel.split(':')[0];
            reply.raw.write(`event: ${eventType}\ndata: ${message}\n\n`);
        });
        request.raw.on('close', async () => {
            try {
                await pubsub.unsubscribe();
                pubsub.disconnect();
            }
            catch (e) {
                // Ignore disconnect errors
            }
        });
    });
    /**
     * GET /analytics/overview
     */
    app.get('/analytics/overview', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { days = '7' } = request.query;
        const since = new Date();
        since.setDate(since.getDate() - Number(days));
        const [total, active, sentimentData, costData, transferred] = await Promise.all([
            prisma_1.prisma.call.count({
                where: { workspaceId, startTime: { gte: since } }
            }),
            prisma_1.prisma.call.count({
                where: { workspaceId, status: { in: ['dialing', 'connected', 'handling_objection', 'extracting_data'] } }
            }),
            prisma_1.prisma.call.aggregate({
                where: { workspaceId, startTime: { gte: since }, sentiment: { not: null } },
                _avg: { sentiment: true }
            }),
            prisma_1.prisma.call.aggregate({
                where: { workspaceId, startTime: { gte: since } },
                _sum: { costUsd: true, duration: true }
            }),
            prisma_1.prisma.call.count({
                where: { workspaceId, startTime: { gte: since }, status: 'transferred' }
            })
        ]);
        const containmentRate = total > 0
            ? parseFloat((((total - transferred) / total) * 100).toFixed(1))
            : 0;
        return reply.send({
            totalCalls: total,
            activeCalls: active,
            avgSentiment: parseFloat((sentimentData._avg.sentiment || 0).toFixed(2)),
            totalMinutes: Math.round((costData._sum.duration || 0) / 60),
            totalCostUsd: parseFloat((costData._sum.costUsd || 0).toFixed(2)),
            containmentRate,
            periodDays: Number(days)
        });
    });
    /**
     * GET /analytics/calls-over-time
     */
    app.get('/analytics/calls-over-time', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { days = '7' } = request.query;
        const since = new Date();
        since.setDate(since.getDate() - Number(days));
        const result = await prisma_1.prisma.$queryRaw `
      SELECT
        DATE_TRUNC('day', "startTime")::date::text AS date,
        COUNT(*) AS count
      FROM "Call"
      WHERE "workspaceId" = ${workspaceId}::uuid
        AND "startTime" >= ${since}
      GROUP BY DATE_TRUNC('day', "startTime")
      ORDER BY date ASC
    `;
        return reply.send(result.map(r => ({
            date: r.date,
            count: Number(r.count)
        })));
    });
    /**
     * POST /calls/:id/ghost-mode/activate
     */
    app.post('/calls/:id/ghost-mode/activate', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { id } = request.params;
        const { agentVoiceId } = request.body;
        const call = await prisma_1.prisma.call.findFirst({
            where: {
                id,
                workspaceId,
                status: { in: ['connected', 'handling_objection', 'extracting_data'] }
            }
        });
        if (!call) {
            return reply.code(404).send({
                error: 'Active call not found. Ghost Mode requires a connected call.'
            });
        }
        try {
            const res = await fetch(`${WORKER_URL}/ghost-mode/activate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Key': INTERNAL_KEY
                },
                body: JSON.stringify({
                    call_id: id,
                    agent_voice_id: agentVoiceId,
                }),
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) {
                const err = await res.json();
                return reply.code(res.status).send(err);
            }
            return reply.send(await res.json());
        }
        catch (e) {
            return reply.code(502).send({ error: 'Worker unavailable' });
        }
    });
    /**
     * POST /calls/:id/ghost-mode/speak
     */
    app.post('/calls/:id/ghost-mode/speak', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { id } = request.params;
        const { audioBase64 } = request.body;
        if (!audioBase64) {
            return reply.code(400).send({ error: 'audioBase64 is required' });
        }
        try {
            const res = await fetch(`${WORKER_URL}/ghost-mode/speak`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Key': INTERNAL_KEY
                },
                body: JSON.stringify({
                    call_id: id,
                    audio_base64: audioBase64,
                }),
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) {
                const err = await res.json();
                return reply.code(res.status).send(err);
            }
            return reply.send(await res.json());
        }
        catch (e) {
            return reply.code(502).send({ error: 'Worker unavailable' });
        }
    });
    /**
     * POST /calls/:id/ghost-mode/deactivate
     */
    app.post('/calls/:id/ghost-mode/deactivate', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { id } = request.params;
        try {
            const res = await fetch(`${WORKER_URL}/ghost-mode/deactivate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Key': INTERNAL_KEY
                },
                body: JSON.stringify({ call_id: id }),
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) {
                const err = await res.json();
                return reply.code(res.status).send(err);
            }
            return reply.send(await res.json());
        }
        catch (e) {
            return reply.code(502).send({ error: 'Worker unavailable' });
        }
    });
}
