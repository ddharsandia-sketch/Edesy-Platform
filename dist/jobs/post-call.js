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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.postCallWorker = exports.postCallQueue = void 0;
const bullmq_1 = require("bullmq");
const prisma_1 = require("../lib/prisma");
const redis_1 = require("../lib/redis");
const openai_1 = __importDefault(require("openai"));
const stripe_1 = __importDefault(require("stripe"));
const crm_1 = require("../lib/crm");
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-03-25.dahlia' });
// Use shared Redis connection for BullMQ
const redisConnection = redis_1.redis.duplicate();
redisConnection.options.maxRetriesPerRequest = null;
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
// ── Queue definition ─────────────────────────────────────────────────────────
exports.postCallQueue = new bullmq_1.Queue('post-call', {
    connection: redisConnection
});
// ── Worker: processes post-call jobs ─────────────────────────────────────────
exports.postCallWorker = new bullmq_1.Worker('post-call', async (job) => {
    const { callId } = job.data;
    console.log(`[POST-CALL] Processing call ${callId}`);
    const call = await prisma_1.prisma.call.findUnique({
        where: { id: callId },
        include: { agent: true }
    });
    if (!call) {
        console.warn(`[POST-CALL] Call ${callId} not found — skipping`);
        return;
    }
    const transcript = call.transcript;
    // Nothing to process if no transcript
    if (!transcript || transcript.length === 0) {
        console.log(`[POST-CALL] No transcript for call ${callId} — skipping`);
        return;
    }
    const transcriptText = transcript
        .map(t => `${t.role.toUpperCase()}: ${t.text}`)
        .join('\n');
    // ── Step 1: Compute sentiment score (-1.0 to 1.0) ────────────────────────
    let sentimentScore = 0.0;
    try {
        const sentimentRes = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [{
                    role: 'system',
                    content: 'Analyze the sentiment of this call transcript. Return JSON: {"score": number between -1.0 (very negative) and 1.0 (very positive), "label": "positive"|"neutral"|"negative", "reason": "one sentence"}'
                }, {
                    role: 'user',
                    content: transcriptText
                }]
        });
        const parsed = JSON.parse(sentimentRes.choices[0].message.content || '{}');
        sentimentScore = parsed.score ?? 0.0;
    }
    catch (err) {
        console.warn(`[POST-CALL] Sentiment scoring failed for ${callId}:`, err);
    }
    // ── Step 2: Compute call duration ─────────────────────────────────────────
    const durationSeconds = call.endTime && call.startTime
        ? Math.round((call.endTime.getTime() - call.startTime.getTime()) / 1000)
        : 0;
    // ── Step 3: Estimate cost (per-minute pricing) ────────────────────────────
    const durationMinutes = durationSeconds / 60;
    // Blended estimate: $0.05/min average across STT + LLM + TTS + Telephony
    const estimatedCostUsd = parseFloat((durationMinutes * 0.05).toFixed(4));
    // ── Step 4: Generate call summary ─────────────────────────────────────────
    let summary = '';
    try {
        const summaryRes = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{
                    role: 'system',
                    content: 'Summarize this call in 2 sentences max. Include: what the caller needed, and how it was resolved (or not).'
                }, {
                    role: 'user',
                    content: transcriptText.slice(0, 3000) // Cap at 3000 chars to save tokens
                }]
        });
        summary = summaryRes.choices[0].message.content || '';
    }
    catch (err) {
        console.warn(`[POST-CALL] Summary generation failed for ${callId}:`, err);
    }
    // ── Step 5: Save everything to DB ─────────────────────────────────────────
    await prisma_1.prisma.call.update({
        where: { id: callId },
        data: {
            sentiment: sentimentScore,
            duration: durationSeconds,
            costUsd: estimatedCostUsd,
            // Store summary inside the artifact JSON field
            artifact: {
                ...(call.artifact || {}),
                summary,
                processedAt: new Date().toISOString()
            }
        }
    });
    // ── Step 6: Report usage to Stripe Meter ──────────────────────────────────
    if (durationSeconds > 0 && call.workspaceId) {
        try {
            // Fetch stripeCustomerId from workspace
            const workspace = await prisma_1.prisma.workspace.findUnique({ where: { id: call.workspaceId } });
            if (workspace?.stripeCustomerId) {
                const minutes = Math.ceil(durationSeconds / 60);
                await stripe.billing.meterEvents.create({
                    event_name: 'call_minute_used',
                    payload: {
                        stripe_customer_id: workspace.stripeCustomerId,
                        value: minutes.toString(),
                    },
                    timestamp: Math.floor(Date.now() / 1000),
                });
                console.log(`[STRIPE] Metered ${minutes} minutes for ${call.workspaceId}`);
            }
        }
        catch (err) {
            console.error(`[STRIPE] Metering failed:`, err.message);
        }
    }
    // ── Step 7: Fire CRM webhooks (if configured for this workspace) ──────────
    try {
        await (0, crm_1.fireCrmWebhooks)(call.workspaceId, {
            callId,
            agentName: call.agent.name,
            callerNumber: call.callerNumber,
            direction: call.direction,
            status: call.status,
            duration: durationSeconds,
            sentiment: sentimentScore,
            summary,
            transcript: transcriptText
        });
    }
    catch (err) {
        console.warn(`[POST-CALL] CRM webhook failed for ${callId}:`, err);
        // Non-critical — don't fail the job over webhook issues
    }
    // ── Step 8: Sync to HubSpot (if token configured) ─────────────────────────
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
        try {
            const { syncCallToHubspot } = await Promise.resolve().then(() => __importStar(require('../lib/hubspot')));
            await syncCallToHubspot({
                callerNumber: call.callerNumber,
                agentName: call.agent.name,
                duration: durationSeconds,
                sentiment: sentimentScore,
                summary,
                transcript: transcriptText,
                callId,
                workspaceId: call.workspaceId,
            });
        }
        catch (err) {
            console.warn('[POST-CALL] HubSpot sync failed (non-blocking):', err.message);
        }
    }
    console.log(`[POST-CALL] ✅ Completed processing call ${callId}: sentiment=${sentimentScore}, duration=${durationSeconds}s, cost=$${estimatedCostUsd}`);
}, { connection: redisConnection });
