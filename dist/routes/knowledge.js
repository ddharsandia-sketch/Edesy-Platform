"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.knowledgeRoutes = knowledgeRoutes;
const auth_1 = require("../middleware/auth");
const prisma_1 = require("../lib/prisma");
async function knowledgeRoutes(app) {
    /**
     * POST /knowledge/:agentId/upload
     * Upload a PDF or text file to the agent's knowledge base.
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
        const chunks = [];
        for await (const chunk of file.file) {
            chunks.push(chunk);
        }
        const fileBuffer = Buffer.concat(chunks);
        const fileBase64 = fileBuffer.toString('base64');
        const fileType = file.mimetype.includes('pdf') ? 'pdf' : 'text';
        // Send to Python worker — snake_case matches EmbedRequest Pydantic model
        const response = await fetch('http://localhost:8000/embed-document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_id: agentId, // snake_case
                file_name: file.filename, // snake_case
                file_type: fileType, // snake_case
                file_base64: fileBase64 // snake_case
            })
        });
        if (!response.ok) {
            return reply.code(500).send({ error: 'Failed to embed document' });
        }
        const doc = await prisma_1.prisma.knowledgeDoc.create({
            data: {
                agentId,
                fileName: file.filename,
                fileType,
                content: '[embedded]',
                embedded: true
            }
        });
        return reply.send({ id: doc.id, fileName: file.filename, status: 'embedded' });
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
