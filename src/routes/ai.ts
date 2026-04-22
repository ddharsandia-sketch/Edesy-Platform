import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateMagicPrompt, generateSchema } from '../lib/ai';

export default async function aiRoutes(fastify: FastifyInstance) {
  // Magic Prompt Generator (Groq)
  fastify.post('/magic-prompt', {
    schema: {
      body: z.object({
        description: z.string().min(5)
      })
    }
  }, async (request, reply) => {
    try {
      const { description } = request.body as { description: string };
      const enhancedPrompt = await generateMagicPrompt(description);
      
      return reply.send({ success: true, enhancedPrompt });
    } catch (error: any) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // Schema Generator (Cerebras)
  fastify.post('/generate-schema', {
    schema: {
      body: z.object({
        description: z.string().min(5)
      })
    }
  }, async (request, reply) => {
    try {
      const { description } = request.body as { description: string };
      const schema = await generateSchema(description);
      
      return reply.send({ success: true, schema });
    } catch (error: any) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // Text-Based Simulation (Groq Streaming)
  fastify.post('/simulate-chat', {
    schema: {
      body: z.object({
        agentId: z.string(),
        messages: z.array(z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.string()
        }))
      })
    }
  }, async (request, reply) => {
    try {
      const { agentId, messages } = request.body as any;
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
    } catch (error: any) {
      fastify.log.error(error);
      reply.raw.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      reply.raw.end();
    }
  });
}
