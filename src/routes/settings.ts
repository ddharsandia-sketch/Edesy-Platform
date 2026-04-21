import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/auth'

export async function settingsRoutes(app: FastifyInstance) {

  // GET /settings/providers — fetch current provider credentials (keys masked)
  app.get('/settings/providers', { preHandler: [authenticate] }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const creds = await prisma.providerCredentials.findUnique({ where: { workspaceId } })
    if (!creds) return reply.send({ configured: false })

    // Mask keys — only show last 4 chars
    const mask = (s?: string | null) => s ? `${s.slice(0, 4)}${'•'.repeat(12)}` : null

    return reply.send({
      configured: true,
      activeLlm: creds.activeLlm,
      activeTel: creds.activeTel,
      openaiKey:   mask(creds.openaiKey),
      groqKey:     mask(creds.groqKey),
      cerebrasKey: mask(creds.cerebrasKey),
      twilioSid:   mask(creds.twilioSid),
      twilioToken: mask(creds.twilioToken),
      exotelSid:   mask(creds.exotelSid),
      exotelKey:   mask(creds.exotelKey),
      exotelToken: mask(creds.exotelToken),
    })
  })

  // POST /settings/providers — save/update provider credentials
  app.post('/settings/providers', { preHandler: [authenticate] }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const body = request.body as {
      openaiKey?: string
      groqKey?: string
      cerebrasKey?: string
      twilioSid?: string
      twilioToken?: string
      exotelSid?: string
      exotelKey?: string
      exotelToken?: string
      activeLlm?: string
      activeTel?: string
    }

    const creds = await prisma.providerCredentials.upsert({
      where: { workspaceId },
      create: { workspaceId, ...body },
      update: {
        ...(body.openaiKey   !== undefined && { openaiKey:   body.openaiKey }),
        ...(body.groqKey     !== undefined && { groqKey:     body.groqKey }),
        ...(body.cerebrasKey !== undefined && { cerebrasKey: body.cerebrasKey }),
        ...(body.twilioSid   !== undefined && { twilioSid:   body.twilioSid }),
        ...(body.twilioToken !== undefined && { twilioToken: body.twilioToken }),
        ...(body.exotelSid   !== undefined && { exotelSid:   body.exotelSid }),
        ...(body.exotelKey   !== undefined && { exotelKey:   body.exotelKey }),
        ...(body.exotelToken !== undefined && { exotelToken: body.exotelToken }),
        ...(body.activeLlm   !== undefined && { activeLlm:   body.activeLlm }),
        ...(body.activeTel   !== undefined && { activeTel:   body.activeTel }),
      },
    })

    return reply.send({ success: true, activeLlm: creds.activeLlm, activeTel: creds.activeTel })
  })

  // POST /settings/complete-onboarding
  app.post('/settings/complete-onboarding', { preHandler: [authenticate] }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    await prisma.workspace.update({ where: { id: workspaceId }, data: { onboardingComplete: true } })
    return reply.send({ success: true })
  })

  // GET /settings/onboarding-status
  app.get('/settings/onboarding-status', { preHandler: [authenticate] }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { providerCredentials: true }
    })
    return reply.send({
      onboardingComplete: ws?.onboardingComplete ?? false,
      hasLlmKey:  !!(ws?.providerCredentials?.openaiKey || ws?.providerCredentials?.groqKey || ws?.providerCredentials?.cerebrasKey),
      hasTelKey:  !!(ws?.providerCredentials?.twilioSid || ws?.providerCredentials?.exotelKey),
    })
  })
}
