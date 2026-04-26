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
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiRoutes = aiRoutes;
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const ai_1 = require("../lib/ai");
async function aiRoutes(fastify) {
    // Simple health check for the /ai prefix
    fastify.get('/health', async () => ({ status: 'ai-ok' }));
    // Magic Prompt Generator (Groq)
    const MagicPromptSchema = zod_1.z.object({
        description: zod_1.z.string().min(5)
    });
    fastify.post('/magic-prompt', { preHandler: [auth_1.requireAuth] }, async (request, reply) => {
        try {
            const { workspaceId } = request.user;
            const validation = MagicPromptSchema.safeParse(request.body);
            if (!validation.success) {
                return reply.status(400).send({ success: false, error: 'Invalid description' });
            }
            const { description } = validation.data;
            const enhancedPrompt = await (0, ai_1.generateMagicPrompt)(description, workspaceId);
            return reply.send({ success: true, enhancedPrompt });
        }
        catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
    // Schema Generator (Cerebras)
    const SchemaGeneratorSchema = zod_1.z.object({
        description: zod_1.z.string().min(5)
    });
    fastify.post('/generate-schema', { preHandler: [auth_1.requireAuth] }, async (request, reply) => {
        try {
            const { workspaceId } = request.user;
            const validation = SchemaGeneratorSchema.safeParse(request.body);
            if (!validation.success) {
                return reply.status(400).send({ success: false, error: 'Invalid description' });
            }
            const { description } = validation.data;
            const schema = await (0, ai_1.generateSchema)(description, workspaceId);
            return reply.send({ success: true, schema });
        }
        catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
    // Text-Based Simulation (Groq Streaming)
    const SimulateChatSchema = zod_1.z.object({
        agentId: zod_1.z.string(),
        messages: zod_1.z.array(zod_1.z.object({
            role: zod_1.z.enum(['user', 'assistant', 'system']),
            content: zod_1.z.string()
        }))
    });
    fastify.post('/simulate-chat', { preHandler: [auth_1.requireAuth] }, async (request, reply) => {
        try {
            const { workspaceId } = request.user;
            const validation = SimulateChatSchema.safeParse(request.body);
            if (!validation.success) {
                return reply.status(400).send({ error: 'Invalid body' });
            }
            const { agentId, messages } = validation.data;
            const { prisma } = await Promise.resolve().then(() => __importStar(require('../lib/prisma')));
            const [agent, workspace] = await Promise.all([
                prisma.agent.findUnique({ where: { id: agentId } }),
                prisma.workspace.findUnique({ where: { id: workspaceId } }),
            ]);
            if (!agent) {
                return reply.status(404).send({ error: 'Agent not found' });
            }
            // Pick the best available LLM key in priority order:
            // 1. Workspace Groq key  2. Workspace OpenAI key  3. Global Groq key  4. Error
            const groqKey = workspace?.groqApiKey || process.env.GLOBAL_GROQ_API_KEY;
            const openaiKey = workspace?.openaiApiKey || process.env.OPENAI_API_KEY;
            const anthropicKey = workspace?.anthropicApiKey;
            if (!groqKey && !openaiKey && !anthropicKey) {
                return reply.status(400).send({
                    error: 'No LLM API key found. Please add a Groq or OpenAI key in Settings → API Keys.'
                });
            }
            const OpenAI = (await Promise.resolve().then(() => __importStar(require('openai')))).default;
            let client;
            let model;
            if (groqKey) {
                client = new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' });
                model = 'llama-3.3-70b-versatile';
            }
            else {
                // OpenAI fallback
                client = new OpenAI({ apiKey: openaiKey });
                model = 'gpt-4o-mini';
            }
            // Prepare conversation history
            const conversation = [
                { role: 'system', content: agent.personaPrompt },
                ...messages
            ];
            const stream = await client.chat.completions.create({
                model,
                messages: conversation,
                stream: true,
                temperature: 0.7,
                max_tokens: 500,
            });
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    reply.raw.write(`data: ${JSON.stringify({ text: content })}\n\n`);
                }
            }
            reply.raw.write(`data: [DONE]\n\n`);
            reply.raw.end();
        }
        catch (error) {
            fastify.log.error(error);
            reply.raw.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            reply.raw.end();
        }
    });
}
