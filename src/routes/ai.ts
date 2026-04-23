import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateMagicPrompt, generateSchema } from '../lib/ai';

export async function aiRoutes(fastify: FastifyInstance) {
  // Simple health check for the /ai prefix
  fastify.get('/health', async () => ({ status: 'ai-ok' }));

  // Magic Prompt Generator (Groq)
  const MagicPromptSchema = z.object({
    description: z.string().min(5)
  });

  fastify.post('/magic-prompt', async (request, reply) => {
    try {
      const validation = MagicPromptSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ success: false, error: 'Invalid description' });
      }
      const { description } = validation.data;
      const enhancedPrompt = await generateMagicPrompt(description);
      
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

  fastify.post('/generate-schema', async (request, reply) => {
    try {
      const validation = SchemaGeneratorSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ success: false, error: 'Invalid description' });
      }
      const { description } = validation.data;
      const schema = await generateSchema(description);
      
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

  fastify.post('/simulate-chat', async (request, reply) => {
    try {
      const validation = SimulateChatSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const { agentId, messages } = validation.data;
      const { groqClient } = await import('../lib/ai');
      const { prisma } = await import('../lib/prisma');

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
