import { FastifyInstance } from 'fastify'
import { AccessToken } from 'livekit-server-sdk'
import twilio from 'twilio'
import { v4 as uuid } from 'uuid'
import { requireAuth } from '../middleware/auth'
import { prisma } from '../lib/prisma'

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
)

export async function callRoutes(app: FastifyInstance) {

  /**
   * POST /calls/inbound
   * Called by Twilio webhook when a call arrives on your Twilio number.
   */
  app.post('/calls/inbound', async (request, reply) => {
    const body = request.body as {
      CallSid: string
      From: string
      To: string
    }

    const phoneRecord = await prisma.phoneNumber.findUnique({
      where: { number: body.To },
      include: { agent: true }
    })

    if (!phoneRecord) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>This number is not configured. Goodbye.</Say><Hangup/></Response>`
      return reply.header('Content-Type', 'text/xml').send(twiml)
    }

    const agent = phoneRecord.agent
    const callId = uuid()
    const roomName = `call-${callId}`

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { identity: `twilio-${callId}` }
    )
    token.addGrant({ roomJoin: true, room: roomName })
    const livekitToken = await token.toJwt()

    const Redis = (await import('ioredis')).default
    const redis = new Redis(process.env.REDIS_URL!)
    const greetingBytes = await redis.getBuffer(`greeting:${agent.id}`)
    redis.disconnect()

    await prisma.call.create({
      data: {
        id: callId,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        callerNumber: body.From,
        direction: 'inbound',
        status: 'dialing',
        liveKitRoomId: roomName
      }
    })

    // Spawn Python voice worker — snake_case matches StartCallRequest Pydantic model
    await fetch('http://localhost:8000/start-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      })
    })

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${process.env.LIVEKIT_URL?.replace('wss://', '')}/twilio-sip?room=${roomName}&amp;token=${livekitToken}" />
  </Connect>
</Response>`

    return reply.header('Content-Type', 'text/xml').send(twiml)
  })

  /**
   * POST /calls/outbound
   * Start an outbound call from your agent to a target number.
   */
  app.post('/calls/outbound', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { agentId, targetNumber } = request.body as {
      agentId: string
      targetNumber: string
    }

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, workspaceId },
      include: { phoneNumbers: true }
    })

    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    if (agent.phoneNumbers.length === 0) {
      return reply.code(400).send({ error: 'Agent has no phone number assigned. Add one in Settings.' })
    }

    const callId = uuid()
    const roomName = `call-${callId}`

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { identity: `twilio-${callId}` }
    )
    token.addGrant({ roomJoin: true, room: roomName })
    const livekitToken = await token.toJwt()

    await prisma.call.create({
      data: {
        id: callId,
        workspaceId,
        agentId,
        callerNumber: targetNumber,
        direction: 'outbound',
        status: 'dialing',
        liveKitRoomId: roomName
      }
    })

    await twilioClient.calls.create({
      to: targetNumber,
      from: agent.phoneNumbers[0].number,
      url: `${process.env.NEXT_PUBLIC_API_URL}/calls/inbound-twiml?callId=${callId}&roomName=${roomName}&token=${livekitToken}`
    })

    return reply.send({ callId, status: 'dialing', roomName })
  })

  /**
   * PATCH /calls/:id/status
   * Internal-only endpoint called by the Python voice worker.
   * Updates call status in PostgreSQL.
   * Protected by X-Internal-Key header (not JWT — worker has no user token).
   */
  app.patch('/calls/:id/status', async (request, reply) => {
    // Validate internal key — never expose this endpoint publicly
    const internalKey = request.headers['x-internal-key']
    if (internalKey !== (process.env.INTERNAL_API_KEY || 'dev-internal-key')) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const { id } = request.params as { id: string }
    const { status } = request.body as { status: string }

    // Valid status values — reject anything else
    const validStatuses = [
      'dialing', 'connected', 'handling_objection',
      'extracting_data', 'completed', 'failed', 'transferred'
    ]
    if (!validStatuses.includes(status)) {
      return reply.code(400).send({
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      })
    }

    const updated = await prisma.call.update({
      where: { id },
      data: {
        status,
        ...(status === 'completed' || status === 'failed'
          ? { endTime: new Date() }
          : {})
      }
    })

    // If call ended, queue the post-call processing job
    if (status === 'completed' || status === 'failed') {
      const { postCallQueue } = await import('../jobs/post-call')
      await postCallQueue.add('process-call', { callId: id }, {
        delay: 2000,    // Wait 2 seconds after call ends before processing
        attempts: 3,    // Retry up to 3 times on failure
        backoff: { type: 'exponential', delay: 5000 }
      })
    }

    return reply.send({ id, status: updated.status })
  })

  /**
   * GET /calls — List calls for this workspace
   */
  app.get('/calls', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { status, agentId, limit = '50' } = request.query as {
      status?: string
      agentId?: string
      limit?: string
    }

    const calls = await prisma.call.findMany({
      where: {
        workspaceId,
        ...(status && { status }),
        ...(agentId && { agentId })
      },
      orderBy: { startTime: 'desc' },
      take: Number(limit),
      include: { agent: { select: { name: true } } }
    })

    return reply.send(calls)
  })

  /**
   * POST /calls/:id/inject — Supervisor injects a real-time directive
   */
  app.post('/calls/:id/inject', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }
    const { directive } = request.body as { directive: string }

    if (!directive || directive.trim().length < 5) {
      return reply.code(400).send({ error: 'Directive must be at least 5 characters' })
    }

    const call = await prisma.call.findFirst({
      where: { id, workspaceId, status: 'connected' }
    })
    if (!call) return reply.code(404).send({ error: 'Active call not found' })

    const Redis = (await import('ioredis')).default
    const redis = new Redis(process.env.REDIS_URL!)
    await redis.publish(`supervisor:${id}`, directive)
    redis.disconnect()

    await prisma.call.update({
      where: { id },
      data: {
        supervisorNotes: {
          push: { time: new Date().toISOString(), directive }
        }
      }
    })

    return reply.send({ status: 'injected', directive })
  })

  /**
   * GET /calls/:id/stream — SSE endpoint for live call monitoring
   */
  app.get('/calls/:id/stream', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }

    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    const Redis = (await import('ioredis')).default
    const redis = new Redis(process.env.REDIS_URL!)
    const pubsub = redis.duplicate()

    await pubsub.subscribe(
      `transcript:${id}`,
      `artifact:${id}`,
      `call_status:${id}`
    )

    pubsub.on('message', (channel, message) => {
      const eventType = channel.split(':')[0]
      reply.raw.write(`event: ${eventType}\ndata: ${message}\n\n`)
    })

    request.raw.on('close', async () => {
      await pubsub.unsubscribe()
      pubsub.disconnect()
      redis.disconnect()
    })
  })

  /**
   * GET /analytics/overview
   * Returns workspace-level stats for the dashboard header cards.
   */
  app.get('/analytics/overview', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { days = '7' } = request.query as { days?: string }

    const since = new Date()
    since.setDate(since.getDate() - Number(days))

    const [total, active, sentimentData, costData, transferred] = await Promise.all([
      prisma.call.count({
        where: { workspaceId, startTime: { gte: since } }
      }),
      prisma.call.count({
        where: { workspaceId, status: { in: ['dialing', 'connected', 'handling_objection', 'extracting_data'] } }
      }),
      prisma.call.aggregate({
        where: { workspaceId, startTime: { gte: since }, sentiment: { not: null } },
        _avg: { sentiment: true }
      }),
      prisma.call.aggregate({
        where: { workspaceId, startTime: { gte: since } },
        _sum: { costUsd: true, duration: true }
      }),
      prisma.call.count({
        where: { workspaceId, startTime: { gte: since }, status: 'transferred' }
      })
    ])

    const containmentRate = total > 0
      ? parseFloat((((total - transferred) / total) * 100).toFixed(1))
      : 0

    return reply.send({
      totalCalls: total,
      activeCalls: active,
      avgSentiment: parseFloat((sentimentData._avg.sentiment || 0).toFixed(2)),
      totalMinutes: Math.round((costData._sum.duration || 0) / 60),
      totalCostUsd: parseFloat((costData._sum.costUsd || 0).toFixed(2)),
      containmentRate,
      periodDays: Number(days)
    })
  })

  /**
   * GET /analytics/calls-over-time
   * Returns daily call volume for the line chart.
   */
  app.get('/analytics/calls-over-time', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { days = '7' } = request.query as { days?: string }

    const since = new Date()
    since.setDate(since.getDate() - Number(days))

    // Raw query for date grouping (Prisma doesn't have native date bucketing)
    const result = await prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
      SELECT
        DATE_TRUNC('day', "startTime")::date::text AS date,
        COUNT(*) AS count
      FROM "Call"
      WHERE "workspaceId" = CAST(${workspaceId} AS UUID)
        AND "startTime" >= ${since}
      GROUP BY DATE_TRUNC('day', "startTime")
      ORDER BY date ASC
    `

    return reply.send(result.map(r => ({
      date: r.date,
      count: Number(r.count)
    })))
  })

  /**
   * POST /calls/:id/ghost-mode/activate
   * Activate Ghost Mode for a live call.
   * Proxies to Python worker — requires active call + valid ElevenLabs voice ID.
   *
   * Body: { agentVoiceId: string }
   * Example body: { "agentVoiceId": "71a7ad14-091c-4e8e-a314-022ece01c121" }
   */
  app.post('/calls/:id/ghost-mode/activate', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }
    const { agentVoiceId } = request.body as { agentVoiceId: string }

    // Verify the call is active and belongs to this workspace
    const call = await prisma.call.findFirst({
      where: {
        id,
        workspaceId,
        status: { in: ['connected', 'handling_objection', 'extracting_data'] }
      }
    })
    if (!call) {
      return reply.code(404).send({
        error: 'Active call not found. Ghost Mode requires a connected call.'
      })
    }

    // Proxy to Python worker
    const res = await fetch('http://localhost:8000/ghost-mode/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: id,
        agent_voice_id: agentVoiceId,
      })
    })

    if (!res.ok) {
      const err = await res.json()
      return reply.code(res.status).send(err)
    }

    return reply.send(await res.json())
  })

  /**
   * POST /calls/:id/ghost-mode/speak
   * Send supervisor audio chunk to be morphed and injected.
   * Called repeatedly every ~2 seconds while supervisor speaks.
   *
   * Body: { audioBase64: string }  — Base64-encoded raw PCM 16kHz audio
   */
  app.post('/calls/:id/ghost-mode/speak', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { audioBase64 } = request.body as { audioBase64: string }

    if (!audioBase64) {
      return reply.code(400).send({ error: 'audioBase64 is required' })
    }

    const res = await fetch('http://localhost:8000/ghost-mode/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: id,
        audio_base64: audioBase64,
      })
    })

    return reply.send(await res.json())
  })

  /**
   * POST /calls/:id/ghost-mode/deactivate
   * Stop Ghost Mode — agent resumes normal AI-driven responses.
   */
  app.post('/calls/:id/ghost-mode/deactivate', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const res = await fetch('http://localhost:8000/ghost-mode/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: id })
    })

    return reply.send(await res.json())
  })
}
