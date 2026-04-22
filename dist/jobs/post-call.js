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
const ai_1 = require("../lib/ai");
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
    // ── Step 1: Compute Insights with Cerebras (Instant) ────────────────────
    let sentimentScore = 0.0;
    let summary = '';
    let actionItems = [];
    try {
        const insightsRes = await ai_1.cerebrasClient.chat.completions.create({
            model: 'llama3.1-8b',
            messages: [{
                    role: 'system',
                    content: `Analyze this call transcript. Return ONLY a raw JSON object (no markdown, no quotes) with these exact keys:
{
  "score": <number between -1.0 (very negative) and 1.0 (very positive)>,
  "label": <"positive"|"neutral"|"negative">,
  "summary": <"A 2-sentence summary of what happened">,
  "actionItems": [<array of strings of agreed next steps>]
}`
                }, {
                    role: 'user',
                    content: transcriptText.slice(0, 4000) // Cap to save context
                }],
            temperature: 0.1
        });
        const parsed = JSON.parse(insightsRes.choices[0].message.content || '{}');
        sentimentScore = parsed.score ?? 0.0;
        summary = parsed.summary ?? '';
        actionItems = parsed.actionItems ?? [];
    }
    catch (err) {
        console.warn(`[POST-CALL] Cerebras insights generation failed for ${callId}:`, err);
    }
    // ── Step 2: Compute call duration ─────────────────────────────────────────
    const durationSeconds = call.endTime && call.startTime
        ? Math.round((call.endTime.getTime() - call.startTime.getTime()) / 1000)
        : 0;
    // ── Step 3: Estimate cost (per-minute pricing) ────────────────────────────
    const durationMinutes = durationSeconds / 60;
    // Blended estimate: $0.05/min average across STT + LLM + TTS + Telephony
    const estimatedCostUsd = parseFloat((durationMinutes * 0.05).toFixed(4));
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
    // ── Step 7: Fire all workspace integrations (HubSpot, Sheets, Slack, Notion, etc.) ───
    try {
        const { triggerIntegrations } = await Promise.resolve().then(() => __importStar(require('../lib/integrations')));
        await triggerIntegrations(call.workspaceId, {
            callId: call.id,
            callerNumber: call.callerNumber,
            callerName: undefined,
            agentName: call.agent?.name || 'AI Agent',
            agentId: call.agentId,
            durationSeconds: durationSeconds,
            sentiment: sentimentScore,
            summary: summary,
            transcript: transcriptText,
            direction: call.direction,
            cost: estimatedCostUsd,
            language: call.agent?.language || 'en',
            startTime: call.startTime,
        });
    }
    catch (err) {
        console.warn(`[POST-CALL] Integrations trigger failed for ${callId}:`, err);
    }
    // ── Step 8: Fire legacy CRM webhooks (backwards compat) ──────────────────
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
