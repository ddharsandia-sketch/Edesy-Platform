import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'

export async function integrationRoutes(fastify: FastifyInstance) {
  // Auth helper
  async function getWorkspaceId(request: any, reply: any): Promise<string | null> {
    try {
      await request.jwtVerify()
      const workspace = await prisma.workspace.findFirst({
        where: { ownerId: request.user.id },
        select: { id: true },
      })
      if (!workspace) {
        reply.status(403).send({ error: 'No workspace found' })
        return null
      }
      return workspace.id
    } catch {
      reply.status(401).send({ error: 'Unauthorized' })
      return null
    }
  }

  // GET /integrations — list all integrations for workspace
  fastify.get('/integrations', async (request, reply) => {
    const workspaceId = await getWorkspaceId(request, reply)
    if (!workspaceId) return

    const integrations = await prisma.integration.findMany({
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
    })

    return reply.send(integrations)
  })

  // POST /integrations — create or update an integration
  fastify.post('/integrations', async (request, reply) => {
    const workspaceId = await getWorkspaceId(request, reply)
    if (!workspaceId) return

    const { type, label, apiKey, config, enabled } = request.body as {
      type: string
      label: string
      apiKey: string
      config?: Record<string, unknown>
      enabled?: boolean
    }

    if (!type || !label || !apiKey) {
      return reply.status(400).send({ error: 'type, label, and apiKey are required' })
    }

    // Upsert by workspaceId + type (one integration per type per workspace)
    const existing = await prisma.integration.findFirst({
      where: { workspaceId, type },
    })

    let integration
    if (existing) {
      integration = await prisma.integration.update({
        where: { id: existing.id },
        data: { label, apiKey, config: (config ?? undefined) as any, enabled: enabled ?? existing.enabled },
      })
    } else {
      integration = await prisma.integration.create({
        data: { workspaceId, type, label, apiKey, config: (config ?? {}) as any, enabled: enabled ?? true },
      })
    }

    return reply.send({ success: true, id: integration.id })
  })

  // PATCH /integrations/:id — toggle enabled / update config
  fastify.patch('/integrations/:id', async (request, reply) => {
    const workspaceId = await getWorkspaceId(request, reply)
    if (!workspaceId) return

    const { id } = request.params as { id: string }
    const body = request.body as Partial<{ enabled: boolean; apiKey: string; config: unknown; label: string }>

    const integration = await prisma.integration.findFirst({
      where: { id, workspaceId },
    })
    if (!integration) return reply.status(404).send({ error: 'Integration not found' })

    const updateData: Record<string, unknown> = {}
    if (body.enabled !== undefined) updateData.enabled = body.enabled
    if (body.apiKey) updateData.apiKey = body.apiKey
    if (body.config) updateData.config = body.config
    if (body.label) updateData.label = body.label

    const updated = await prisma.integration.update({
      where: { id },
      data: updateData as any,
    })

    return reply.send({ success: true, enabled: updated.enabled })
  })

  // DELETE /integrations/:id
  fastify.delete('/integrations/:id', async (request, reply) => {
    const workspaceId = await getWorkspaceId(request, reply)
    if (!workspaceId) return

    const { id } = request.params as { id: string }
    const integration = await prisma.integration.findFirst({ where: { id, workspaceId } })
    if (!integration) return reply.status(404).send({ error: 'Not found' })

    await prisma.integration.delete({ where: { id } })
    return reply.send({ success: true })
  })

  // POST /integrations/:id/test — fire a test payload to validate credentials
  fastify.post('/integrations/:id/test', async (request, reply) => {
    const workspaceId = await getWorkspaceId(request, reply)
    if (!workspaceId) return

    const { id } = request.params as { id: string }
    const integration = await prisma.integration.findFirst({ where: { id, workspaceId } })
    if (!integration) return reply.status(404).send({ error: 'Not found' })

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
    }

    try {
      const { triggerIntegrations } = await import('../lib/integrations')
      // Only fire this specific integration
      await triggerIntegrations(workspaceId, testPayload)
      return reply.send({ success: true, message: 'Test payload sent' })
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message })
    }
  })
}
