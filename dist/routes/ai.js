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
exports.default = aiRoutes;
const zod_1 = require("zod");
const ai_1 = require("../lib/ai");
async function aiRoutes(fastify) {
    // Magic Prompt Generator (Groq)
    fastify.post('/magic-prompt', {
        schema: {
            body: zod_1.z.object({
                description: zod_1.z.string().min(5)
            })
        }
    }, async (request, reply) => {
        try {
            const { description } = request.body;
            const enhancedPrompt = await (0, ai_1.generateMagicPrompt)(description);
            return reply.send({ success: true, enhancedPrompt });
        }
        catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
    // Schema Generator (Cerebras)
    fastify.post('/generate-schema', {
        schema: {
            body: zod_1.z.object({
                description: zod_1.z.string().min(5)
            })
        }
    }, async (request, reply) => {
        try {
            const { description } = request.body;
            const schema = await (0, ai_1.generateSchema)(description);
            return reply.send({ success: true, schema });
        }
        catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
    // Text-Based Simulation (Groq Streaming)
    fastify.post('/simulate-chat', {
        schema: {
            body: zod_1.z.object({
                agentId: zod_1.z.string(),
                messages: zod_1.z.array(zod_1.z.object({
                    role: zod_1.z.enum(['user', 'assistant', 'system']),
                    content: zod_1.z.string()
                }))
            })
        }
    }, async (request, reply) => {
        try {
            const { agentId, messages } = request.body;
            const { groqClient } = await Promise.resolve().then(() => __importStar(require('../lib/ai')));
            const { prisma } = await Promise.resolve().then(() => __importStar(require('../lib/prisma')));
            const agent = await prisma.agent.findUnique({ where: { id: agentId } });
            if (!agent) {
                return reply.status(404).send({ error: 'Agent not found' });
            }
            // Prepare conversation history
            const conversation = [
                { role: 'system', content: agent.personaPrompt },
                ...messages
            ];
            const stream = await groqClient.chat.completions.create({
                model: 'llama3-70b-8192',
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
