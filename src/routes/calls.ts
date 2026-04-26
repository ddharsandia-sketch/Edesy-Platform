import { FastifyInstance } from 'fastify'
import { AccessToken } from 'livekit-server-sdk'
import { TelephonyManager } from '../lib/telephony'
import { v4 as uuid } from 'uuid'
import { requireAuth } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { redis, getPubSub } from '../lib/redis'

const telephony = TelephonyManager.getInstance()

// Internal API key shared with worker
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || 'dev-internal-key'
const WORKER_URL = process.env.VOICE_WORKER_URL || 'http://localhost:8000'

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

    const greetingBytes = await redis.getBuffer(`greeting:${agent.id}`)

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
      })

      if (!response.ok) {
        console.error(`[API] Worker failed to start call ${callId}: ${response.statusText}`)
      }
    } catch (e) {
      console.error(`[API] Failed to reach worker for call ${callId}:`, e)
    }

    // Generate XML using TelephonyManager
    const twiml = telephony.generateConnectXml(roomName, livekitToken)

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

    await telephony.makeCall({
      to: targetNumber,
      from: agent.phoneNumbers[0].number,
      url: `${process.env.NEXT_PUBLIC_API_URL}/calls/inbound-twiml?callId=${callId}&roomName=${roomName}&token=${livekitToken}`
    })

    return reply.send({ callId, status: 'dialing', roomName })
  })

  /**
   * POST /calls/web
   * Public endpoint used by the landing page Demo Widget to connect to the AI via browser.
   * Connects via WebRTC, bypassing standard telephony providers.
   */
  app.post('/calls/web', async (request, reply) => {
    let agent = await prisma.agent.findFirst({
      where: { isActive: true },
      include: { workspace: true }
    })

    if (!agent) {
      const workspace = await prisma.workspace.findFirst() || await prisma.workspace.create({
        data: { name: 'Demo Workspace', ownerId: 'demo-user' }
      })
      agent = await prisma.agent.create({
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
      })
    }

    const callId = uuid()
    const roomName = `webcall-${callId}`

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { identity: `web-user-${callId}`, name: 'Web User' }
    )
    token.addGrant({ roomJoin: true, room: roomName })
    const userToken = await token.toJwt()

    const workerAuthToken = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { identity: `worker-${callId}`, name: 'AI Voice' }
    )
    workerAuthToken.addGrant({ roomJoin: true, room: roomName })
    const workerToken = await workerAuthToken.toJwt()

    await prisma.call.create({
      data: {
        id: callId,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        callerNumber: 'web-browser',
        direction: 'inbound',
        status: 'connected',
        liveKitRoomId: roomName
      }
    })

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
      })

      if (!response.ok) {
        console.error(`[API] Worker failed to start web call ${callId}: ${response.statusText}`)
      }
    } catch (e) {
      console.error(`[API] Failed to reach worker for web call ${callId}:`, e)
    }

    return reply.send({
      callId,
      roomName,
      token: userToken,
      url: process.env.LIVEKIT_URL || 'wss://your-app.livekit.cloud'
    })
  })

  /**
   * PATCH /calls/:id/status
   * Internal-only endpoint called by the Python voice worker.
   */
  app.patch('/calls/:id/status', async (request, reply) => {
    const internalKey = request.headers['x-internal-key']
    if (internalKey !== INTERNAL_KEY) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const { id } = request.params as { id: string }
    const { status } = request.body as { status: string }

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

    if (status === 'completed' || status === 'failed') {
      const { postCallQueue } = await import('../jobs/post-call')
      await postCallQueue.add('process-call', { callId: id }, {
        delay: 2000,
        attempts: 3,
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

    await redis.publish(`supervisor:${id}`, directive)

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

    const pubsub = getPubSub().duplicate()

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
      try {
        await pubsub.unsubscribe()
        pubsub.disconnect()
      } catch (e) {
        // Ignore disconnect errors
      }
    })
  })

  /**
   * GET /analytics/overview
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
   */
  app.get('/analytics/calls-over-time', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { days = '7' } = request.query as { days?: string }

    const since = new Date()
    since.setDate(since.getDate() - Number(days))

    // Build day-by-day data using Prisma ORM (avoids raw SQL UUID type mismatch)
    const allCalls = await prisma.call.findMany({
      where: { workspaceId, startTime: { gte: since } },
      select: { startTime: true },
    })

    // Group by date string in JS
    const grouped: Record<string, number> = {}
    for (const call of allCalls) {
      const date = call.startTime.toISOString().slice(0, 10) // "2026-04-12"
      grouped[date] = (grouped[date] || 0) + 1
    }

    const result = Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }))

    return reply.send(result)
  })

  /**
   * POST /calls/:id/ghost-mode/activate
   */
  app.post('/calls/:id/ghost-mode/activate', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }
    const { agentVoiceId } = request.body as { agentVoiceId: string }

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
      })

      if (!res.ok) {
        const err = await res.json()
        return reply.code(res.status).send(err)
      }

      return reply.send(await res.json())
    } catch (e) {
      return reply.code(502).send({ error: 'Worker unavailable' })
    }
  })

  /**
   * POST /calls/:id/ghost-mode/speak
   */
  app.post('/calls/:id/ghost-mode/speak', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { audioBase64 } = request.body as { audioBase64: string }

    if (!audioBase64) {
      return reply.code(400).send({ error: 'audioBase64 is required' })
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
      })

      if (!res.ok) {
        const err = await res.json()
        return reply.code(res.status).send(err)
      }

      return reply.send(await res.json())
    } catch (e) {
      return reply.code(502).send({ error: 'Worker unavailable' })
    }
  })

  /**
   * POST /calls/:id/ghost-mode/deactivate
   */
  app.post('/calls/:id/ghost-mode/deactivate', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }

    try {
      const res = await fetch(`${WORKER_URL}/ghost-mode/deactivate`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Internal-Key': INTERNAL_KEY
        },
        body: JSON.stringify({ call_id: id }),
        signal: AbortSignal.timeout(5000)
      })

      if (!res.ok) {
        const err = await res.json()
        return reply.code(res.status).send(err)
      }

      return reply.send(await res.json())
    } catch (e) {
      return reply.code(502).send({ error: 'Worker unavailable' })
    }
  })
}
