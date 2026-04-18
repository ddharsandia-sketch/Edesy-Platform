import { FastifyInstance } from 'fastify'
import Stripe from 'stripe'
import twilio from 'twilio'
import { prisma } from '../lib/prisma'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

export async function webhookRoutes(app: FastifyInstance) {
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
  app.post('/webhooks/twilio/inbound', async (request, reply) => {
    const body = request.body as {
      From: string
      To: string
      CallSid: string
      CallStatus: string
    }

    console.log(`[TWILIO] Inbound call: ${body.From} → ${body.To} (${body.CallSid})`)

    // Validate Twilio signature (prevents spoofed webhooks)
    const twilioSignature = request.headers['x-twilio-signature'] as string
    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN!,
      twilioSignature,
      `${process.env.NEXT_PUBLIC_API_URL}/webhooks/twilio/inbound`,
      body
    )
    // In development, skip signature validation (ngrok changes URL each time)
    if (process.env.NODE_ENV === 'production' && !isValid) {
      return reply.code(403).send('Invalid Twilio signature')
    }

    // Look up which agent owns this phone number
    const phoneNumber = await prisma.phoneNumber.findUnique({
      where: { number: body.To },
      include: { agent: { include: { workspace: true } } }
    })

    if (!phoneNumber) {
      // No agent assigned — play a default message and hang up
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>This number is not yet configured. Please try again later.</Say>
          <Hangup/>
        </Response>`
      return reply.type('text/xml').send(twiml)
    }

    const agent = phoneNumber.agent

    // Create call record in DB
    const call = await prisma.call.create({
      data: {
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        callerNumber: body.From,
        direction: 'inbound',
        status: 'dialing',
        startTime: new Date(),
        twilioCallSid: body.CallSid,
        transcript: [],
        artifact: null,
      }
    })

    console.log(`[TWILIO] Created call record ${call.id} for agent ${agent.name}`)

    // Fetch greeting bytes from Redis cache (pre-warmed in Phase 1)
    const { createClient } = await import('redis')
    const redis = createClient({ url: process.env.REDIS_URL })
    await redis.connect()
    const greetingBase64 = await redis.get(`greeting:${agent.id}`)
    await redis.disconnect()

    // Generate LiveKit token for this call
    const { AccessToken } = await import('livekit-server-sdk')
    const roomName = `call-${call.id}`
    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { identity: `caller-${call.id}` }
    )
    token.addGrant({ roomJoin: true, room: roomName })
    const livekitToken = await token.toJwt()

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
    }).catch(err => console.error('[TWILIO] Failed to start voice worker:', err))

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
      </Response>`

    return reply.type('text/xml').send(twiml)
  })


  /**
   * POST /webhooks/twilio/status
   * Twilio calls this when a call's status changes.
   * We use it to detect call completion and trigger post-processing.
   */
  app.post('/webhooks/twilio/status', async (request, reply) => {
    const body = request.body as {
      CallSid: string
      CallStatus: string
      CallDuration?: string
    }

    console.log(`[TWILIO] Status update: ${body.CallSid} → ${body.CallStatus}`)

    // Map Twilio status to our status enum
    const statusMap: Record<string, string> = {
      'completed': 'completed',
      'failed':    'failed',
      'busy':      'failed',
      'no-answer': 'failed',
      'canceled':  'failed',
    }

    const ourStatus = statusMap[body.CallStatus]
    if (!ourStatus) return reply.send({ ok: true })  // Ignore intermediate statuses

    // Look up call by Twilio SID
    const call = await prisma.call.findFirst({
      where: { twilioCallSid: body.CallSid }
    })
    if (!call) return reply.send({ ok: true })

    // Update status + duration
    await prisma.call.update({
      where: { id: call.id },
      data: {
        status: ourStatus,
        endTime: new Date(),
        duration: body.CallDuration ? parseInt(body.CallDuration) : undefined,
      }
    })

    // Queue post-call processing (sentiment, cost, summary)
    if (ourStatus === 'completed') {
      const { postCallQueue } = await import('../jobs/post-call')
      await postCallQueue.add('process-call', { callId: call.id }, {
        delay: 2000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
      })
    }

    return reply.send({ ok: true })
  })


  /**
   * POST /webhooks/twilio/outbound-status
   * Status callback for outbound calls we initiate.
   */
  app.post('/webhooks/twilio/outbound-status', async (request, reply) => {
    const body = request.body as { CallSid: string; CallStatus: string; CallDuration?: string }
    // Same handling as inbound status
    const call = await prisma.call.findFirst({ where: { twilioCallSid: body.CallSid } })
    if (call && ['completed', 'failed', 'busy', 'no-answer'].includes(body.CallStatus)) {
      await prisma.call.update({
        where: { id: call.id },
        data: {
          status: body.CallStatus === 'completed' ? 'completed' : 'failed',
          endTime: new Date(),
          duration: body.CallDuration ? parseInt(body.CallDuration) : undefined,
        }
      })
    }
    return reply.send({ ok: true })
  })

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
    config: { rawBody: true }  // Opts into raw body capture for this route only
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature'] as string

    // Read raw Buffer — NOT request.body (which is already JSON-parsed)
    const rawPayload = (request as any).rawBody as Buffer

    if (!rawPayload) {
      console.error('[STRIPE] rawBody is missing — check fastify-raw-body registration order in index.ts')
      return reply.code(400).send('Missing raw body')
    }

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(
        rawPayload,   // Buffer — Stripe computes HMAC against this exact byte sequence
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err: any) {
      console.error(`[STRIPE] ❌ Signature verification failed: ${err.message}`)
      return reply.code(400).send(`Webhook Error: ${err.message}`)
    }

    console.log(`[STRIPE] Event: ${event.type}`)

    switch (event.type) {
      // ── Subscription started or upgraded ───────────────────────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const workspaceId = sub.metadata?.workspaceId
        const tier = sub.metadata?.tier || 'starter'

        if (workspaceId) {
          await prisma.workspace.update({
            where: { id: workspaceId },
            data: {
              stripeSubscriptionId: sub.id,
              planTier: sub.status === 'active' ? tier : 'free',
              planExpiresAt: new Date(sub.current_period_end * 1000),
            }
          })
          console.log(`[STRIPE] Workspace ${workspaceId} updated to ${tier} (${sub.status})`)
        }
        break
      }

      // ── Subscription cancelled ─────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const workspaceId = sub.metadata?.workspaceId
        if (workspaceId) {
          await prisma.workspace.update({
            where: { id: workspaceId },
            data: {
              planTier: 'free',
              stripeSubscriptionId: null,
              planExpiresAt: null,
            }
          })
          console.log(`[STRIPE] Workspace ${workspaceId} downgraded to free`)
        }
        break
      }

      // ── Payment succeeded ──────────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        console.log(`[STRIPE] Payment succeeded: $${(invoice.amount_paid / 100).toFixed(2)}`)
        // You could send a receipt email here via Resend/SendGrid
        break
      }

      // ── Payment failed ─────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        console.warn(`[STRIPE] Payment FAILED for customer: ${invoice.customer}`)
        // TODO: Send dunning email to workspace owner
        break
      }
    }

    return reply.send({ received: true })
  })
}
