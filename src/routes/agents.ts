import { FastifyInstance } from 'fastify'
import twilio from 'twilio'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/auth'

export async function agentRoutes(app: FastifyInstance) {

  // GET /agents — List all agents for this workspace
  app.get('/agents', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const agents = await prisma.agent.findMany({
      where: { workspaceId },
      include: { phoneNumbers: true, _count: { select: { calls: true } } }
    })
    return reply.send(agents)
  })

  // POST /agents — Create new agent
  app.post('/agents', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const body = request.body as {
      name: string
      personaPrompt: string
      language: string
      voiceProvider: string
      voiceId: string
      sttProvider: string
      llmModel: string
      useGeminiLive: boolean
      extractionSchema?: string | object
    }

    // Validate: personaPrompt must be at least 50 characters
    if (body.personaPrompt.length < 50) {
      return reply.code(400).send({
        error:
          'personaPrompt must be at least 50 characters. Describe the agent persona in detail.'
      })
    }

    let parsedSchema = null
    if (body.extractionSchema) {
      try {
        parsedSchema = typeof body.extractionSchema === 'string' 
          ? JSON.parse(body.extractionSchema) 
          : body.extractionSchema
      } catch {
        // Invalid JSON in schema — ignore it and save without schema
        parsedSchema = null
      }
    }

    const agent = await prisma.agent.create({
      data: { 
        ...body, 
        workspaceId,
        extractionSchema: parsedSchema ?? undefined
      }
    })

    // Prefetch greeting audio into Redis (non-blocking — failure is safe)
    prefetchGreeting(agent.id, agent.personaPrompt, agent.voiceId, agent.voiceProvider)

    return reply.code(201).send(agent)
  })

  // PATCH /agents/:id — Update agent
  app.patch('/agents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }
    const body = request.body as Partial<{
      name: string
      personaPrompt: string
      language: string
      voiceId: string
      extractionSchema: string | object
    }>

    const existing = await prisma.agent.findFirst({ where: { id, workspaceId } })
    if (!existing) return reply.code(404).send({ error: 'Agent not found' })

    let parsedSchema = undefined
    if (body.extractionSchema) {
      try {
        parsedSchema = typeof body.extractionSchema === 'string' 
          ? JSON.parse(body.extractionSchema) 
          : body.extractionSchema
      } catch {
        // Invalid JSON in schema — ignore and save without schema
        parsedSchema = undefined
      }
    }

    const dataToUpdate: any = { ...body }
    if (parsedSchema !== undefined) {
      dataToUpdate.extractionSchema = parsedSchema
    }

    const updated = await prisma.agent.update({ where: { id }, data: dataToUpdate })
    return reply.send(updated)
  })

  // DELETE /agents/:id
  app.delete('/agents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }

    const existing = await prisma.agent.findFirst({ where: { id, workspaceId } })
    if (!existing) return reply.code(404).send({ error: 'Agent not found' })

    await prisma.agent.delete({ where: { id } })
    return reply.code(204).send()
  })

  /**
   * POST /agents/:id/simulate
   * Start a stress test simulation for this agent.
   * Returns a job_id — poll /agents/:id/simulate/:jobId for results.
   *
   * Body: { numSimulations: number, maxTurns: number }
   * Example: { "numSimulations": 10, "maxTurns": 8 }
   */
  app.post('/agents/:id/simulate', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }
    const { numSimulations = 10, maxTurns = 8 } = request.body as {
      numSimulations?: number
      maxTurns?: number
    }

    // Fetch full agent (need persona_prompt)
    const agent = await prisma.agent.findFirst({
      where: { id, workspaceId }
    })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    // Start simulation job on Python worker
    const res = await fetch('http://localhost:8000/simulate/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: id,
        persona_prompt: agent.personaPrompt,
        num_simulations: numSimulations,
        max_turns: maxTurns,
      })
    })

    if (!res.ok) {
      const err = await res.json()
      return reply.code(res.status).send(err)
    }

    return reply.send(await res.json())
  })

  /**
   * GET /agents/:id/simulate/:jobId
   * Poll for simulation results.
   * When status === "completed", results contains full report.
   */
  app.get('/agents/:id/simulate/:jobId', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId } = request.params as { id: string; jobId: string }

    const res = await fetch(`http://localhost:8000/simulate/status/${jobId}`)
    if (!res.ok) return reply.code(404).send({ error: 'Job not found' })

    return reply.send(await res.json())
  })

  /**
   * GET /agents/:id/phone-numbers
   * List phone numbers assigned to this agent.
   */
  app.get('/agents/:id/phone-numbers', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }

    const agent = await prisma.agent.findFirst({ where: { id, workspaceId } })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const numbers = await prisma.phoneNumber.findMany({ where: { agentId: id } })
    return reply.send(numbers)
  })

  /**
   * POST /agents/:id/phone-numbers
   * Assign a Twilio phone number to an agent.
   * Body: { number: string }  — E.164 format
   *
   * Also configures the number's webhook URL in Twilio automatically.
   */
  app.post('/agents/:id/phone-numbers', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }
    const { number } = request.body as { number: string }

    if (!/^\+[1-9]\d{6,14}$/.test(number)) {
      return reply.code(400).send({ error: 'Invalid E.164 format. Example: +14155551234' })
    }

    const agent = await prisma.agent.findFirst({ where: { id, workspaceId } })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    // Check if number is already assigned to another agent
    const existing = await prisma.phoneNumber.findUnique({ where: { number } })
    if (existing) {
      return reply.code(409).send({
        error: 'This number is already assigned to another agent.'
      })
    }

    // Configure Twilio webhook for this number automatically
    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!
    )

    try {
      // Find the number in Twilio account
      const twilioNumbers = await twilioClient.incomingPhoneNumbers.list({ phoneNumber: number })
      if (twilioNumbers.length > 0) {
        // Update webhook URL
        await twilioClient.incomingPhoneNumbers(twilioNumbers[0].sid).update({
          voiceUrl: `${process.env.NEXT_PUBLIC_API_URL}/webhooks/twilio/inbound`,
          voiceMethod: 'POST',
          statusCallback: `${process.env.NEXT_PUBLIC_API_URL}/webhooks/twilio/status`,
          statusCallbackMethod: 'POST',
        })
        console.log(`[TWILIO] Configured webhook for ${number}`)
      }
    } catch (err) {
      console.warn(`[TWILIO] Could not auto-configure webhook for ${number}:`, err)
      // Non-blocking — user can configure manually in Twilio console
    }

    const phoneNumber = await prisma.phoneNumber.create({
      data: { number, agentId: id, workspaceId }
    })

    return reply.code(201).send(phoneNumber)
  })

  /**
   * DELETE /agents/:id/phone-numbers/:numberId
   * Unassign a phone number from an agent.
   */
  app.delete('/agents/:id/phone-numbers/:numberId', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { numberId } = request.params as { id: string; numberId: string }

    const number = await prisma.phoneNumber.findFirst({
      where: { id: numberId, workspaceId }
    })
    if (!number) return reply.code(404).send({ error: 'Phone number not found' })

    await prisma.phoneNumber.delete({ where: { id: numberId } })
    return reply.send({ deleted: true })
  })
}


// Helper: prefetch greeting audio into Redis via Python worker
async function prefetchGreeting(
  agentId: string,
  prompt: string,
  voiceId: string,
  voiceProvider: string
) {
  try {
    const workerUrl = process.env.VOICE_WORKER_URL || 'http://localhost:8000'
    const response = await fetch(`${workerUrl}/prefetch-greeting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,        // snake_case — matches Python Pydantic model
        prompt,
        voice_id: voiceId,        // snake_case
        voice_provider: voiceProvider  // snake_case
      })
    })
    if (!response.ok) {
      console.error('[WARN] Failed to prefetch greeting for agent', agentId)
    } else {
      console.log('[OK] Greeting prefetched for agent', agentId)
    }
  } catch (err) {
    // Non-critical — call still works without a pre-cached greeting
    console.warn('[WARN] Voice worker not reachable for prefetch:', (err as Error).message)
  }
}
