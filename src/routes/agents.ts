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

  // GET /agents/:id — Fetch a single agent
  app.get('/agents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }
    const agent = await prisma.agent.findFirst({
      where: { id, workspaceId },
      include: { phoneNumbers: true, _count: { select: { calls: true } } }
    })
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' })
    }
    return reply.send(agent)
  })

  // POST /agents — Create new agent
  app.post('/agents', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      const body = request.body as Record<string, any>;

      // ── Validate required fields ─────────────────────────────────────────────
      if (!body.name?.trim()) {
        return reply.status(400).send({ error: "Agent name is required" });
      }
      if (!body.personaPrompt?.trim() || body.personaPrompt.trim().length < 10) {
        return reply.status(400).send({ error: "Persona prompt must be at least 10 characters" });
      }

      // ── Resolve provider config from tier/language ────────────────────────────
      const language   = body.language ?? "en";
      const tierId     = body.tierId   ?? "efficient";
      const gender     = body.gender   ?? "female";

      const INDIAN = new Set(["hi","gu","mr","ta","te","kn","bn","ml","pa","or"]);
      const isIndian = INDIAN.has(language);

      // Defaults — never crash on missing provider fields
      const sttProvider = body.sttProvider ?? (isIndian ? "sarvam" : "deepgram");
      const ttsProvider = body.ttsProvider ?? (isIndian ? "sarvam" : "elevenlabs");
      const llmModel    = body.llmModel    ?? "gemini-2.0-flash";

      const SARVAM_VOICES: Record<string, Record<string, string>> = {
        hi: { female: "meera",  male: "arjun"   },
        gu: { female: "diya",   male: "neel"    },
        mr: { female: "priya",  male: "rohan"   },
        ta: { female: "kavya",  male: "karthik" },
        te: { female: "anushka",male: "vikram"  },
      };
      const voiceId = body.voiceId ?? (
        isIndian
          ? (SARVAM_VOICES[language]?.[gender] ?? "meera")
          : (gender === "male" ? "VR6AewLTigWG4xSOukaG" : "21m00Tcm4TlvDq8ikWAM")
      );

      const agent = await prisma.agent.create({
        data: {
          workspaceId,
          name:              body.name.trim(),
          personaPrompt:     body.personaPrompt.trim(),
          language,
          voiceId,
          voiceProvider:     ttsProvider,
          sttProvider,
          llmModel,
          telephonyProvider: body.telephonyProvider ?? (isIndian ? "exotel" : "twilio"),
          tierId,
          useCaseId:         body.useCaseId  ?? "receptionist",
          isActive:          false,   // starts inactive — deploy separately
          industry:          body.industry   ?? "general",
        },
      });

      // Prefetch greeting audio into Redis (non-blocking — failure is safe)
      prefetchGreeting(agent.id, agent.personaPrompt, agent.voiceId, agent.voiceProvider || 'elevenlabs')

      return reply.status(201).send(agent);

    } catch (err: any) {
      console.error("[POST /agents]", err.message);
      if (err.code === "P2002") {
        return reply.status(400).send({ error: "An agent with this name already exists" });
      }
      return reply.status(500).send({ error: err.message ?? "Failed to create agent" });
    }
  })

  // PATCH /agents/:id — Update agent
  app.patch('/agents/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string }
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, any>

      // Verify agent belongs to this workspace
      const existing = await prisma.agent.findFirst({ where: { id, workspaceId } })
      if (!existing) return reply.code(404).send({ error: 'Agent not found' })

      const ALLOWED_AGENT_FIELDS = [
        "name",
        "personaPrompt",
        "language",
        "voiceProvider",
        "voiceId",
        "sttProvider",
        "llmModel",
        "useGeminiLive",
        "industry",
        "templateId",
        "tierId",
        "useCaseId",
        "sttModel",
        "ttsModel",
        "ttsPace",
        "ttsLoudness",
        "isActive",
        "knowledgeBaseId",
      ];

      const dataToUpdate: any = {}
      for (const key of ALLOWED_AGENT_FIELDS) {
        if (body[key] !== undefined) {
          dataToUpdate[key] = body[key];
        }
      }

      // Handle extractionSchema separately due to potential JSON parsing
      if (body.extractionSchema !== undefined) {
        try {
          dataToUpdate.extractionSchema = typeof body.extractionSchema === 'string' 
            ? (body.extractionSchema.trim() ? JSON.parse(body.extractionSchema) : null)
            : body.extractionSchema
        } catch {
          dataToUpdate.extractionSchema = null
        }
      }

      const updated = await prisma.agent.update({ 
        where: { id }, 
        data: dataToUpdate 
      })

      return reply.send(updated)
    } catch (err: any) {
      console.error("[PATCH /api/agents/:id]", err);
      return reply.code(500).send({ error: err.message ?? "Failed to update agent" });
    }
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
    const isProd = process.env.NODE_ENV === 'production'
    const defaultUrl = isProd ? 'http://edesyworker.railway.internal:8000' : 'http://localhost:8000'
    const workerUrl = process.env.VOICE_WORKER_URL || defaultUrl
    
    let res;
    try {
      res = await fetch(`${workerUrl}/simulate/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: id,
          persona_prompt: agent.personaPrompt,
          num_simulations: numSimulations,
          max_turns: maxTurns,
        })
      })
    } catch (err: any) {
      console.error('[SIMULATE START] Worker unreachable:', err.message)
      return reply.code(502).send({ error: 'Voice worker is unreachable. Ensure the Python worker is running.' })
    }

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

    const isProd = process.env.NODE_ENV === 'production'
    const defaultUrl = isProd ? 'http://edesyworker.railway.internal:8000' : 'http://localhost:8000'
    const workerUrl = process.env.VOICE_WORKER_URL || defaultUrl

    const res = await fetch(`${workerUrl}/simulate/status/${jobId}`)
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

    // Find the active telephony provider from workspace settings
    const workspaceSettings = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    const telephonyProvider = (workspaceSettings as any)?.activeTel || 'twilio';

    if (telephonyProvider === 'twilio') {
      // Configure Twilio webhook for this number automatically
      const twilioClient = twilio(
        (workspaceSettings as any)?.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID!,
        (workspaceSettings as any)?.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN!
      );

      try {
        const twilioNumbers = await twilioClient.incomingPhoneNumbers.list({ phoneNumber: number });
        if (twilioNumbers.length > 0) {
          await twilioClient.incomingPhoneNumbers(twilioNumbers[0].sid).update({
            voiceUrl: `${process.env.NEXT_PUBLIC_API_URL}/webhooks/twilio/inbound`,
            voiceMethod: 'POST',
            statusCallback: `${process.env.NEXT_PUBLIC_API_URL}/webhooks/twilio/status`,
            statusCallbackMethod: 'POST',
          });
          console.log(`[TWILIO] Configured webhook for ${number}`);
        }
      } catch (err) {
        console.warn(`[TWILIO] Could not auto-configure webhook for ${number}:`, err);
      }
    } else if (telephonyProvider === 'exotel') {
      // For Exotel, webhooks are configured via the App Bazaar in the Exotel dashboard
      const exotelPassthruUrl = `${process.env.NEXT_PUBLIC_API_URL}/webhooks/exotel/passthru`;
      console.log(`[EXOTEL] Webhook configuration required for ${number}. Please set your Exotel App Bazaar "Passthru" URL to: ${exotelPassthruUrl}`);
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
    const isProd = process.env.NODE_ENV === 'production'
    const defaultUrl = isProd ? 'http://edesyworker.railway.internal:8000' : 'http://localhost:8000'
    const workerUrl = process.env.VOICE_WORKER_URL || defaultUrl
    const response = await fetch(`${workerUrl}/prefetch-greeting`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || 'dev-internal-key'
      },
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
