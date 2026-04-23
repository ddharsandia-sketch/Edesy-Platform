import { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth'
import { prisma } from '../lib/prisma'

export async function knowledgeRoutes(app: FastifyInstance) {

  /**
   * POST /knowledge/:agentId/upload
   * Upload a PDF or text file to the agent's knowledge base.
   */
  app.post('/knowledge/:agentId/upload', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { agentId } = request.params as { agentId: string }

    const agent = await prisma.agent.findFirst({ where: { id: agentId, workspaceId } })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const file = await request.file()
    if (!file) return reply.code(400).send({ error: 'No file uploaded' })

    const chunks: Buffer[] = []
    for await (const chunk of file.file) {
      chunks.push(chunk)
    }
    const fileBuffer = Buffer.concat(chunks)
    const fileBase64 = fileBuffer.toString('base64')
    const fileType = file.mimetype.includes('pdf') ? 'pdf' : 'text'

    // Send to Python worker — snake_case matches EmbedRequest Pydantic model
    const workerUrl = process.env.VOICE_WORKER_URL || 'http://localhost:8000'
    const response = await fetch(`${workerUrl}/embed-document`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || 'dev-internal-key'
      },
      body: JSON.stringify({
        agent_id: agentId,         // snake_case
        file_name: file.filename,  // snake_case
        file_type: fileType,       // snake_case
        file_base64: fileBase64    // snake_case
      })
    })

    if (!response.ok) {
      return reply.code(500).send({ error: 'Failed to embed document' })
    }

    const doc = await prisma.knowledgeDoc.create({
      data: {
        agentId,
        fileName: file.filename,
        fileType,
        content: '[embedded]',
        embedded: true
      }
    })

    return reply.send({ id: doc.id, fileName: file.filename, status: 'embedded' })
  })

  // GET /knowledge/:agentId — list docs for this agent
  app.get('/knowledge/:agentId', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { agentId } = request.params as { agentId: string }

    const agent = await prisma.agent.findFirst({ where: { id: agentId, workspaceId } })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const docs = await prisma.knowledgeDoc.findMany({
      where: { agentId },
      orderBy: { createdAt: 'desc' }
    })
    return reply.send(docs)
  })
}
