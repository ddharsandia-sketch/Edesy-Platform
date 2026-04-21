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
exports.webhookRoutes = webhookRoutes;
const stripe_1 = __importDefault(require("stripe"));
const twilio_1 = __importDefault(require("twilio"));
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const redis_1 = require("../lib/redis");
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-03-25.dahlia' });
async function webhookRoutes(app) {
    /**
     * POST /webhooks/twilio/inbound
     * Triggered by Twilio when someone calls one of your phone numbers.
     * Twilio sends a POST with caller info — we respond with TwiML instructions.
     *
     * Flow:
     *   1. Twilio calls this endpoint with From, To, CallSid
     *   2. We look up which agent owns this phone number
     *   3. We create a Call record in the DB
     *   4. We respond with TwiML to connect to LiveKit via <Stream>
     *   5. Twilio opens a WebSocket to /webhooks/twilio/stream
     *   6. We bridge that WebSocket to the Pipecat pipeline
     */
    const TwilioInboundSchema = zod_1.z.object({
        From: zod_1.z.string(),
        To: zod_1.z.string(),
        CallSid: zod_1.z.string(),
        CallStatus: zod_1.z.string().optional()
    });
    app.post('/webhooks/twilio/inbound', async (request, reply) => {
        const validation = TwilioInboundSchema.safeParse(request.body);
        if (!validation.success) {
            return reply.code(400).send({ error: 'Invalid request body' });
        }
        const body = validation.data;
        console.log(`[TWILIO] Inbound call: ${body.From} → ${body.To} (${body.CallSid})`);
        // Validate Twilio signature (prevents spoofed webhooks)
        const twilioSignature = request.headers['x-twilio-signature'];
        const isValid = twilio_1.default.validateRequest(process.env.TWILIO_AUTH_TOKEN, twilioSignature, `${process.env.NEXT_PUBLIC_API_URL}/webhooks/twilio/inbound`, body);
        // In development, skip signature validation (ngrok changes URL each time)
        if (process.env.NODE_ENV === 'production' && !isValid) {
            return reply.code(403).send('Invalid Twilio signature');
        }
        // Look up which agent owns this phone number
        const phoneNumber = await prisma_1.prisma.phoneNumber.findUnique({
            where: { number: body.To },
            include: { agent: { include: { workspace: true } } }
        });
        if (!phoneNumber) {
            // No agent assigned — play a default message and hang up
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>This number is not yet configured. Please try again later.</Say>
          <Hangup/>
        </Response>`;
            return reply.type('text/xml').send(twiml);
        }
        const agent = phoneNumber.agent;
        // Create call record in DB
        const call = await prisma_1.prisma.call.create({
            data: {
                agentId: agent.id,
                workspaceId: agent.workspaceId,
                callerNumber: body.From,
                direction: 'inbound',
                status: 'dialing',
                startTime: new Date(),
                twilioCallSid: body.CallSid,
                transcript: [],
                artifact: {}, // Use empty object instead of null for Json field
            }
        });
        console.log(`[TWILIO] Created call record ${call.id} for agent ${agent.name}`);
        // Fetch greeting bytes from Redis cache
        const greetingBase64 = await redis_1.redis.get(`greeting:${agent.id}`);
        // Generate LiveKit token for this call
        const { AccessToken } = await Promise.resolve().then(() => __importStar(require('livekit-server-sdk')));
        const roomName = `call-${call.id}`;
        const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: `caller-${call.id}` });
        token.addGrant({ roomJoin: true, room: roomName });
        const livekitToken = await token.toJwt();
        // Fire-and-forget: start voice pipeline on Python worker
        fetch(`${process.env.VOICE_WORKER_URL}/start-call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_id: agent.id,
                call_id: call.id,
                livekit_room_name: roomName,
                livekit_token: livekitToken,
                persona_prompt: agent.personaPrompt,
                language: agent.language,
                voice_id: agent.voiceId,
                stt_provider: agent.sttProvider,
                llm_model: agent.llmModel,
                use_gemini_live: agent.useGeminiLive,
                greeting_bytes: greetingBase64,
                industry: agent.industry ?? 'general',
                handoff_phone: agent.handoffPhone ?? null,
            })
        }).catch(err => console.error('[TWILIO] Failed to start voice worker:', err));
        // TwiML response: connect call to LiveKit room via <Stream>
        // LiveKit handles the WebRTC → SIP bridge
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${process.env.LIVEKIT_URL?.replace('wss://', '')}/twilio">
            <Parameter name="roomName" value="${roomName}"/>
            <Parameter name="token" value="${livekitToken}"/>
          </Stream>
        </Connect>
      </Response>`;
        return reply.type('text/xml').send(twiml);
    });
    /**
     * POST /webhooks/twilio/status
     * Twilio calls this when a call's status changes.
     * We use it to detect call completion and trigger post-processing.
     */
    const TwilioStatusSchema = zod_1.z.object({
        CallSid: zod_1.z.string(),
        CallStatus: zod_1.z.string(),
        CallDuration: zod_1.z.string().optional()
    });
    app.post('/webhooks/twilio/status', async (request, reply) => {
        const validation = TwilioStatusSchema.safeParse(request.body);
        if (!validation.success) {
            return reply.code(400).send({ error: 'Invalid request body' });
        }
        const body = validation.data;
        console.log(`[TWILIO] Status update: ${body.CallSid} → ${body.CallStatus}`);
        // Map Twilio status to our status enum
        const statusMap = {
            'completed': 'completed',
            'failed': 'failed',
            'busy': 'failed',
            'no-answer': 'failed',
            'canceled': 'failed',
        };
        const ourStatus = statusMap[body.CallStatus];
        if (!ourStatus)
            return reply.send({ ok: true }); // Ignore intermediate statuses
        // Look up call by Twilio SID
        const call = await prisma_1.prisma.call.findFirst({
            where: { twilioCallSid: body.CallSid }
        });
        if (!call)
            return reply.send({ ok: true });
        // Update status + duration
        await prisma_1.prisma.call.update({
            where: { id: call.id },
            data: {
                status: ourStatus,
                endTime: new Date(),
                duration: body.CallDuration ? parseInt(body.CallDuration) : undefined,
            }
        });
        // Queue post-call processing (sentiment, cost, summary)
        if (ourStatus === 'completed') {
            const { postCallQueue } = await Promise.resolve().then(() => __importStar(require('../jobs/post-call')));
            await postCallQueue.add('process-call', { callId: call.id }, {
                delay: 2000,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 }
            });
        }
        return reply.send({ ok: true });
    });
    /**
     * POST /webhooks/twilio/outbound-status
     * Status callback for outbound calls we initiate.
     */
    app.post('/webhooks/twilio/outbound-status', async (request, reply) => {
        const body = request.body;
        // Same handling as inbound status
        const call = await prisma_1.prisma.call.findFirst({ where: { twilioCallSid: body.CallSid } });
        if (call && ['completed', 'failed', 'busy', 'no-answer'].includes(body.CallStatus)) {
            await prisma_1.prisma.call.update({
                where: { id: call.id },
                data: {
                    status: body.CallStatus === 'completed' ? 'completed' : 'failed',
                    endTime: new Date(),
                    duration: body.CallDuration ? parseInt(body.CallDuration) : undefined,
                }
            });
        }
        return reply.send({ ok: true });
    });
    /**
     * POST /webhooks/stripe
     * Handles Stripe subscription lifecycle events.
     *
     * CRITICAL: Must read from req.rawBody (Buffer), NOT req.body (parsed object).
     * Stripe signature verification will throw if given a parsed JS object.
     * fastify-raw-body is registered globally in index.ts with global: false,
     * and this route opts in via config: { rawBody: true }.
     */
    app.post('/webhooks/stripe', {
        config: { rawBody: true } // Opts into raw body capture for this route only
    }, async (request, reply) => {
        const sig = request.headers['stripe-signature'];
        // Read raw Buffer — NOT request.body (which is already JSON-parsed)
        const rawPayload = request.rawBody;
        if (!rawPayload) {
            console.error('[STRIPE] rawBody is missing — check fastify-raw-body registration order in index.ts');
            return reply.code(400).send('Missing raw body');
        }
        let event;
        try {
            event = stripe.webhooks.constructEvent(rawPayload, // Buffer — Stripe computes HMAC against this exact byte sequence
            sig, process.env.STRIPE_WEBHOOK_SECRET);
        }
        catch (err) {
            console.error(`[STRIPE] ❌ Signature verification failed: ${err.message}`);
            return reply.code(400).send(`Webhook Error: ${err.message}`);
        }
        console.log(`[STRIPE] Event: ${event.type}`);
        switch (event.type) {
            // ── Subscription started or upgraded ───────────────────────────────────
            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const workspaceId = sub.metadata?.workspaceId;
                const tier = sub.metadata?.tier || 'starter';
                if (workspaceId) {
                    await prisma_1.prisma.workspace.update({
                        where: { id: workspaceId },
                        data: {
                            stripeSubscriptionId: sub.id,
                            planTier: sub.status === 'active' ? tier : 'free',
                            planExpiresAt: new Date(sub.current_period_end * 1000),
                        }
                    });
                    console.log(`[STRIPE] Workspace ${workspaceId} updated to ${tier} (${sub.status})`);
                }
                break;
            }
            // ── Subscription cancelled ─────────────────────────────────────────────
            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const workspaceId = sub.metadata?.workspaceId;
                if (workspaceId) {
                    await prisma_1.prisma.workspace.update({
                        where: { id: workspaceId },
                        data: {
                            planTier: 'free',
                            stripeSubscriptionId: null,
                            planExpiresAt: null,
                        }
                    });
                    console.log(`[STRIPE] Workspace ${workspaceId} downgraded to free`);
                }
                break;
            }
            // ── Payment succeeded ──────────────────────────────────────────────────
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                console.log(`[STRIPE] Payment succeeded: $${(invoice.amount_paid / 100).toFixed(2)}`);
                // You could send a receipt email here via Resend/SendGrid
                break;
            }
            // ── Payment failed ─────────────────────────────────────────────────────
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                console.warn(`[STRIPE] Payment FAILED for customer: ${invoice.customer}`);
                // TODO: Send dunning email to workspace owner
                break;
            }
        }
        return reply.send({ received: true });
    });
    /**
     * POST /webhooks/paypal
     * Handles PayPal billing and subscription events.
     */
    app.post('/webhooks/paypal', {
        config: { rawBody: true }
    }, async (request, reply) => {
        const rawPayload = request.rawBody;
        const headers = request.headers;
        const isValid = await Promise.resolve().then(() => __importStar(require('../lib/paypal'))).then(m => m.verifyWebhookSignature(rawPayload, headers));
        if (!isValid && process.env.NODE_ENV === 'production') {
            console.error('[PAYPAL] Webhook signature verification failed');
            return reply.code(400).send('Invalid PayPal signature');
        }
        const event = JSON.parse(rawPayload);
        console.log(`[PAYPAL] Event: ${event.event_type}`);
        switch (event.event_type) {
            case 'BILLING.SUBSCRIPTION.ACTIVATED': {
                const sub = event.resource;
                const workspaceId = sub.custom_id;
                // Map plan_id to tier (assuming we store this in .env or a map)
                const tier = 'starter'; // Map based on sub.plan_id in real app
                if (workspaceId) {
                    await prisma_1.prisma.workspace.update({
                        where: { id: workspaceId },
                        data: {
                            paypalSubscriptionId: sub.id,
                            planTier: tier,
                            planExpiresAt: new Date(Date.now() + 32 * 24 * 60 * 60 * 1000) // Default to 1 month
                        }
                    });
                    console.log(`[PAYPAL] Workspace ${workspaceId} activated: ${tier}`);
                }
                break;
            }
            case 'BILLING.SUBSCRIPTION.CANCELLED': {
                const sub = event.resource;
                const workspaceId = sub.custom_id;
                if (workspaceId) {
                    await prisma_1.prisma.workspace.update({
                        where: { id: workspaceId },
                        data: {
                            planTier: 'free',
                            paypalSubscriptionId: null,
                            planExpiresAt: null,
                        }
                    });
                    console.log(`[PAYPAL] Workspace ${workspaceId} downgraded to free`);
                }
                break;
            }
            case 'PAYMENT.SALE.COMPLETED': {
                // Log payment for reporting
                console.log(`[PAYPAL] Payment received: ${event.resource.amount.total} ${event.resource.amount.currency}`);
                break;
            }
        }
        return reply.send({ received: true });
    });
    /**
     * POST /webhooks/exotel/passthru
     * Exotel calls this URL when an inbound call arrives on your ExoPhone.
     * We respond with the Exotel "Voicebot Applet" JSON that tells Exotel:
     *   "Stream this call's audio to wss://voice-worker.../exotel-ws"
     *
     * How to configure in Exotel App Bazaar:
     * 1. Create a new App in App Bazaar
     * 2. Add a "Passthru" applet
     * 3. Set the URL to: https://edesyapi-production.up.railway.app/webhooks/exotel/passthru
     */
    const ExotelPassthruSchema = zod_1.z.object({
        CallSid: zod_1.z.string().optional(),
        call_sid: zod_1.z.string().optional(),
        To: zod_1.z.string().optional(),
        to: zod_1.z.string().optional()
    });
    app.post('/webhooks/exotel/passthru', async (request, reply) => {
        // Verify Exotel signature
        const signature = request.headers['x-exotel-signature'];
        const expectedSignature = process.env.EXOTEL_API_KEY;
        if (process.env.NODE_ENV === 'production' && signature !== expectedSignature) {
            console.error('[EXOTEL] Invalid signature');
            return reply.code(403).send('Invalid Exotel signature');
        }
        const validation = ExotelPassthruSchema.safeParse(request.body);
        if (!validation.success) {
            return reply.code(400).send({ error: 'Invalid request body' });
        }
        const body = validation.data;
        const callSid = body?.CallSid || body?.call_sid || 'unknown';
        console.log(`[EXOTEL] Inbound call: ${callSid}`);
        // Look up phone number to find the agent
        const toNumber = body?.To || body?.to;
        const phoneRecord = await prisma_1.prisma.phoneNumber.findUnique({
            where: { number: toNumber },
            include: { agent: true }
        });
        if (!phoneRecord) {
            // No agent configured — play a message and hang up
            return reply.type('application/json').send({
                actions: [
                    { say: { text: 'This number is not configured. Goodbye.', voice: 'female', language: 'en' } },
                    { hangup: {} }
                ]
            });
        }
        const agent = phoneRecord.agent;
        // Store agent prompt in Redis so the WebSocket handler can pick it up
        await redis_1.redis.setex(`agent_prompt:${callSid}`, 3600, agent.personaPrompt);
        // The voice worker WebSocket URL — Exotel will stream audio here
        const workerUrl = process.env.VOICE_WORKER_URL || 'http://edesyworker.railway.internal:8000';
        const wsUrl = workerUrl.replace(/^http/, 'ws') + '/exotel-ws';
        console.log(`[EXOTEL] Routing call ${callSid} → agent "${agent.name}" → ${wsUrl}`);
        // Exotel Voicebot Applet JSON response
        return reply.type('application/json').send({
            actions: [
                {
                    voicebot: {
                        botUrl: wsUrl,
                        provider: 'custom',
                        streamSid: callSid,
                    }
                }
            ]
        });
    });
    /**
     * POST /webhooks/exotel/status
     * Exotel calls this when a call ends.
     * Updates call record and triggers post-call processing.
     */
    app.post('/webhooks/exotel/status', async (request, reply) => {
        const body = request.body;
        const callSid = body?.CallSid || body?.call_sid;
        console.log(`[EXOTEL] Call status: ${callSid} → ${body?.Status || body?.status}`);
        const call = await prisma_1.prisma.call.findFirst({
            where: { twilioCallSid: callSid }
        });
        if (call) {
            const rawStatus = (body?.Status || body?.status || 'completed').toLowerCase();
            const status = ['completed', 'answered'].includes(rawStatus) ? 'completed' : 'failed';
            await prisma_1.prisma.call.update({
                where: { id: call.id },
                data: {
                    status,
                    endTime: new Date(),
                    duration: body?.Duration ? parseInt(body.Duration) : undefined,
                }
            });
            if (status === 'completed') {
                const { postCallQueue } = await Promise.resolve().then(() => __importStar(require('../jobs/post-call')));
                await postCallQueue.add('process-call', { callId: call.id }, {
                    delay: 2000,
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5000 }
                });
            }
        }
        return reply.send({ ok: true });
    });
}
