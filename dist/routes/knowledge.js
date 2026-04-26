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
exports.knowledgeRoutes = knowledgeRoutes;
const auth_1 = require("../middleware/auth");
const prisma_1 = require("../lib/prisma");
const openai_1 = __importDefault(require("openai"));
const pdfParse = require('pdf-parse');
// Lazy-init OpenAI — only requires OPENAI_API_KEY env var
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
// ── Qdrant helpers (uses fetch — no extra package required) ───────────────────
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = 'documents';
const VECTOR_SIZE = 1536; // text-embedding-3-small
function qdrantHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (QDRANT_API_KEY)
        h['api-key'] = QDRANT_API_KEY;
    return h;
}
async function ensureQdrantCollection() {
    // Check if the collection exists
    const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
        headers: qdrantHeaders()
    });
    if (check.ok)
        return; // Already exists
    // Create collection
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
        method: 'PUT',
        headers: qdrantHeaders(),
        body: JSON.stringify({
            vectors: { size: VECTOR_SIZE, distance: 'Cosine' }
        })
    });
    // Add payload index on agent_id for fast multi-tenant filtering
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
        method: 'PUT',
        headers: qdrantHeaders(),
        body: JSON.stringify({ field_name: 'agent_id', field_schema: 'keyword' })
    });
}
async function upsertQdrantPoints(points) {
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
        method: 'PUT',
        headers: qdrantHeaders(),
        body: JSON.stringify({ points })
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Qdrant upsert failed: ${err}`);
    }
}
// ── Text chunker (500 chars, 100 overlap — matches Python version) ─────────────
function chunkText(text, chunkSize = 500, overlap = 100) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
        const chunk = text.slice(i, i + chunkSize);
        if (chunk.length > 50)
            chunks.push(chunk);
    }
    return chunks;
}
// ── Embed in batches of 100 (OpenAI rate limit safe) ─────────────────────────
async function embedChunks(chunks) {
    const vectors = [];
    for (let i = 0; i < chunks.length; i += 100) {
        const batch = chunks.slice(i, i + 100);
        const res = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: batch
        });
        vectors.push(...res.data.map(d => d.embedding));
    }
    return vectors;
}
// ─────────────────────────────────────────────────────────────────────────────
async function knowledgeRoutes(app) {
    /**
     * POST /knowledge/:agentId/upload
     * Upload a PDF or text file to the agent's knowledge base.
     * Fully handled in Node — no Python worker dependency.
     */
    app.post('/knowledge/:agentId/upload', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { agentId } = request.params;
        const agent = await prisma_1.prisma.agent.findFirst({ where: { id: agentId, workspaceId } });
        if (!agent)
            return reply.code(404).send({ error: 'Agent not found' });
        const file = await request.file();
        if (!file)
            return reply.code(400).send({ error: 'No file uploaded' });
        // Read file into a buffer
        const chunks = [];
        for await (const chunk of file.file)
            chunks.push(chunk);
        const fileBuffer = Buffer.concat(chunks);
        const fileType = file.mimetype.includes('pdf') ? 'pdf' : 'text';
        // ── Extract text ──────────────────────────────────────────────────────────
        let text = '';
        if (fileType === 'pdf') {
            try {
                const parsed = await pdfParse(fileBuffer);
                text = parsed.text;
            }
            catch (err) {
                console.error('[KNOWLEDGE] PDF parse failed:', err.message);
                return reply.code(422).send({ error: 'Could not extract text from PDF' });
            }
        }
        else {
            text = fileBuffer.toString('utf-8');
        }
        if (!text.trim()) {
            return reply.code(422).send({ error: 'No text could be extracted from the document' });
        }
        // ── Chunk the text ────────────────────────────────────────────────────────
        const textChunks = chunkText(text);
        console.log(`[KNOWLEDGE] ${textChunks.length} chunks from "${file.filename}"`);
        // ── Embed with OpenAI ─────────────────────────────────────────────────────
        let vectors;
        try {
            vectors = await embedChunks(textChunks);
        }
        catch (err) {
            console.error('[KNOWLEDGE] OpenAI embed failed:', err.message);
            return reply.code(502).send({ error: 'Embedding failed: ' + err.message });
        }
        // ── Upsert into Qdrant ────────────────────────────────────────────────────
        if (process.env.QDRANT_URL) {
            try {
                await ensureQdrantCollection();
                const { randomUUID } = await Promise.resolve().then(() => __importStar(require('crypto')));
                const points = textChunks.map((chunk, i) => ({
                    id: randomUUID(),
                    vector: vectors[i],
                    payload: { text: chunk, source: file.filename, agent_id: agentId }
                }));
                await upsertQdrantPoints(points);
                console.log(`[KNOWLEDGE] ✅ ${points.length} vectors upserted to Qdrant`);
            }
            catch (err) {
                // Qdrant failure is non-fatal — we still save the record
                console.error('[KNOWLEDGE] Qdrant upsert failed:', err.message);
            }
        }
        else {
            console.warn('[KNOWLEDGE] QDRANT_URL not set — vectors not stored, doc record only');
        }
        // ── Save record in Postgres ───────────────────────────────────────────────
        const doc = await prisma_1.prisma.knowledgeDoc.create({
            data: {
                agentId,
                fileName: file.filename,
                fileType,
                content: text.slice(0, 2000), // Store preview for display
                embedded: true
            }
        });
        return reply.send({ id: doc.id, fileName: file.filename, status: 'embedded', chunks: textChunks.length });
    });
    /**
     * DELETE /knowledge/:agentId/docs/:docId
     * Remove a document from the knowledge base.
     */
    app.delete('/knowledge/:agentId/docs/:docId', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { agentId, docId } = request.params;
        const agent = await prisma_1.prisma.agent.findFirst({ where: { id: agentId, workspaceId } });
        if (!agent)
            return reply.code(404).send({ error: 'Agent not found' });
        await prisma_1.prisma.knowledgeDoc.deleteMany({ where: { id: docId, agentId } });
        return reply.send({ deleted: true });
    });
    // GET /knowledge/:agentId — list docs for this agent
    app.get('/knowledge/:agentId', { preHandler: auth_1.requireAuth }, async (request, reply) => {
        const { workspaceId } = request.user;
        const { agentId } = request.params;
        const agent = await prisma_1.prisma.agent.findFirst({ where: { id: agentId, workspaceId } });
        if (!agent)
            return reply.code(404).send({ error: 'Agent not found' });
        const docs = await prisma_1.prisma.knowledgeDoc.findMany({
            where: { agentId },
            orderBy: { createdAt: 'desc' }
        });
        return reply.send(docs);
    });
}
