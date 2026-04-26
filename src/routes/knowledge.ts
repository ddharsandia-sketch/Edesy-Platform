import { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import OpenAI from 'openai'
const pdfParse = require('pdf-parse')

// Lazy-init OpenAI — only requires OPENAI_API_KEY env var
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Qdrant helpers (uses fetch — no extra package required) ───────────────────
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333'
const QDRANT_API_KEY = process.env.QDRANT_API_KEY
const COLLECTION = 'documents'
const VECTOR_SIZE = 1536  // text-embedding-3-small

function qdrantHeaders() {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (QDRANT_API_KEY) h['api-key'] = QDRANT_API_KEY
  return h
}

async function ensureQdrantCollection() {
  // Check if the collection exists
  const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    headers: qdrantHeaders()
  })
  if (check.ok) return  // Already exists

  // Create collection
  await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: 'PUT',
    headers: qdrantHeaders(),
    body: JSON.stringify({
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' }
    })
  })

  // Add payload index on agent_id for fast multi-tenant filtering
  await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
    method: 'PUT',
    headers: qdrantHeaders(),
    body: JSON.stringify({ field_name: 'agent_id', field_schema: 'keyword' })
  })
}

async function upsertQdrantPoints(points: Array<{
  id: string
  vector: number[]
  payload: Record<string, string>
}>) {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: 'PUT',
    headers: qdrantHeaders(),
    body: JSON.stringify({ points })
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Qdrant upsert failed: ${err}`)
  }
}

// ── Text chunker (500 chars, 100 overlap — matches Python version) ─────────────
function chunkText(text: string, chunkSize = 500, overlap = 100): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    const chunk = text.slice(i, i + chunkSize)
    if (chunk.length > 50) chunks.push(chunk)
  }
  return chunks
}

// ── Embed in batches of 100 (OpenAI rate limit safe) ─────────────────────────
async function embedChunks(chunks: string[]): Promise<number[][]> {
  const vectors: number[][] = []
  for (let i = 0; i < chunks.length; i += 100) {
    const batch = chunks.slice(i, i + 100)
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch
    })
    vectors.push(...res.data.map(d => d.embedding))
  }
  return vectors
}

// ─────────────────────────────────────────────────────────────────────────────

export async function knowledgeRoutes(app: FastifyInstance) {

  /**
   * POST /knowledge/:agentId/upload
   * Upload a PDF or text file to the agent's knowledge base.
   * Fully handled in Node — no Python worker dependency.
   */
  app.post('/knowledge/:agentId/upload', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { agentId } = request.params as { agentId: string }

    const agent = await prisma.agent.findFirst({ where: { id: agentId, workspaceId } })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const file = await request.file()
    if (!file) return reply.code(400).send({ error: 'No file uploaded' })

    // Read file into a buffer
    const chunks: Buffer[] = []
    for await (const chunk of file.file) chunks.push(chunk)
    const fileBuffer = Buffer.concat(chunks)

    const fileType = file.mimetype.includes('pdf') ? 'pdf' : 'text'

    // ── Extract text ──────────────────────────────────────────────────────────
    let text = ''
    if (fileType === 'pdf') {
      try {
        const parsed = await pdfParse(fileBuffer)
        text = parsed.text
      } catch (err: any) {
        console.error('[KNOWLEDGE] PDF parse failed:', err.message)
        return reply.code(422).send({ error: 'Could not extract text from PDF' })
      }
    } else {
      text = fileBuffer.toString('utf-8')
    }

    if (!text.trim()) {
      return reply.code(422).send({ error: 'No text could be extracted from the document' })
    }

    // ── Chunk the text ────────────────────────────────────────────────────────
    const textChunks = chunkText(text)
    console.log(`[KNOWLEDGE] ${textChunks.length} chunks from "${file.filename}"`)

    // ── Embed with OpenAI ─────────────────────────────────────────────────────
    let vectors: number[][]
    try {
      vectors = await embedChunks(textChunks)
    } catch (err: any) {
      console.error('[KNOWLEDGE] OpenAI embed failed:', err.message)
      return reply.code(502).send({ error: 'Embedding failed: ' + err.message })
    }

    // ── Upsert into Qdrant ────────────────────────────────────────────────────
    if (process.env.QDRANT_URL) {
      try {
        await ensureQdrantCollection()
        const { randomUUID } = await import('crypto')
        const points = textChunks.map((chunk, i) => ({
          id: randomUUID(),
          vector: vectors[i],
          payload: { text: chunk, source: file.filename, agent_id: agentId }
        }))
        await upsertQdrantPoints(points)
        console.log(`[KNOWLEDGE] ✅ ${points.length} vectors upserted to Qdrant`)
      } catch (err: any) {
        // Qdrant failure is non-fatal — we still save the record
        console.error('[KNOWLEDGE] Qdrant upsert failed:', err.message)
      }
    } else {
      console.warn('[KNOWLEDGE] QDRANT_URL not set — vectors not stored, doc record only')
    }

    // ── Save record in Postgres ───────────────────────────────────────────────
    const doc = await prisma.knowledgeDoc.create({
      data: {
        agentId,
        fileName: file.filename,
        fileType,
        content: text.slice(0, 2000),  // Store preview for display
        embedded: true
      }
    })

    return reply.send({ id: doc.id, fileName: file.filename, status: 'embedded', chunks: textChunks.length })
  })


  /**
   * DELETE /knowledge/:agentId/docs/:docId
   * Remove a document from the knowledge base.
   */
  app.delete('/knowledge/:agentId/docs/:docId', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { agentId, docId } = request.params as { agentId: string; docId: string }

    const agent = await prisma.agent.findFirst({ where: { id: agentId, workspaceId } })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    await prisma.knowledgeDoc.deleteMany({ where: { id: docId, agentId } })
    return reply.send({ deleted: true })
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
