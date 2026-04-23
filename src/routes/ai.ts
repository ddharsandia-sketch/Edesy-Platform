import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { generateMagicPrompt, generateSchema } from '../lib/ai';

export async function aiRoutes(fastify: FastifyInstance) {
  // Simple health check for the /ai prefix
  fastify.get('/health', async () => ({ status: 'ai-ok' }));

  // Magic Prompt Generator (Groq)
  const MagicPromptSchema = z.object({
    description: z.string().min(5)
  });

  fastify.post('/magic-prompt', { preHandler: [requireAuth] }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const validation = MagicPromptSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ success: false, error: 'Invalid description' });
      }
      const { description } = validation.data;
      const enhancedPrompt = await generateMagicPrompt(description, workspaceId);
      
      return reply.send({ success: true, enhancedPrompt });
    } catch (error: any) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // Schema Generator (Cerebras)
  const SchemaGeneratorSchema = z.object({
    description: z.string().min(5)
  });

  fastify.post('/generate-schema', { preHandler: [requireAuth] }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const validation = SchemaGeneratorSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ success: false, error: 'Invalid description' });
      }
      const { description } = validation.data;
      const schema = await generateSchema(description, workspaceId);
      
      return reply.send({ success: true, schema });
    } catch (error: any) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // Text-Based Simulation (Groq Streaming)
  const SimulateChatSchema = z.object({
    agentId: z.string(),
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string()
    }))
  });

  fastify.post('/simulate-chat', { preHandler: [requireAuth] }, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const validation = SimulateChatSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const { agentId, messages } = validation.data;
      const { prisma } = await import('../lib/prisma');

      const [agent, workspace] = await Promise.all([
        prisma.agent.findUnique({ where: { id: agentId } }),
        prisma.workspace.findUnique({ where: { id: workspaceId } }),
      ]);

      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found' });
      }

      // Pick the best available LLM key in priority order:
      // 1. Workspace Groq key  2. Workspace OpenAI key  3. Global Groq key  4. Error
      const groqKey    = (workspace as any)?.groqApiKey    || process.env.GLOBAL_GROQ_API_KEY;
      const openaiKey  = (workspace as any)?.openaiApiKey  || process.env.OPENAI_API_KEY;
      const anthropicKey = (workspace as any)?.anthropicApiKey;

      if (!groqKey && !openaiKey && !anthropicKey) {
        return reply.status(400).send({
          error: 'No LLM API key found. Please add a Groq or OpenAI key in Settings → API Keys.'
        });
      }

      const OpenAI = (await import('openai')).default;
      let client: InstanceType<typeof OpenAI>;
      let model: string;

      if (groqKey) {
        client = new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' });
        model = 'llama-3.3-70b-versatile';
      } else {
        // OpenAI fallback
        client = new OpenAI({ apiKey: openaiKey! });
        model = 'gpt-4o-mini';
      }

      // Prepare conversation history
      const conversation = [
        { role: 'system', content: agent.personaPrompt },
        ...messages
      ];

      const stream = await client.chat.completions.create({
        model,
        messages: conversation as any,
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
    } catch (error: any) {
      fastify.log.error(error);
      reply.raw.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      reply.raw.end();
    }
  });
}
