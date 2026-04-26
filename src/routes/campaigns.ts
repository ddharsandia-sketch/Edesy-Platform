import { FastifyInstance } from 'fastify'
import { parse } from 'csv-parse/sync'
import { prisma } from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { requireAuth } from '../middleware/auth'
import { campaignQueue } from '../jobs/campaign-dialer'

export async function campaignRoutes(app: FastifyInstance) {
  /**
   * GET /campaigns
   * List all campaigns for this workspace with agent name and contact count.
   */
  app.get('/campaigns', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId },
      include: {
        agent: { select: { name: true } },
        _count: { select: { contacts: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    return reply.send(campaigns)
  })

  /**
   * GET /campaigns/:id
   * Get a single campaign by ID with contact stats.
   */
  app.get('/campaigns/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }

    const campaign = await prisma.campaign.findFirst({
      where: { id, workspaceId },
      include: {
        agent: { select: { name: true } },
        _count: { select: { contacts: true } }
      }
    })

    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })
    return reply.send(campaign)
  })

  /**
   * POST /campaigns
   * Create a new campaign in draft state.
   */
  app.post('/campaigns', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const {
      name, agentId, callsPerMinute = 2,
      maxRetries = 1, scheduledAt
    } = request.body as {
      name: string
      agentId: string
      callsPerMinute?: number
      maxRetries?: number
      scheduledAt?: string
    }

    if (!name?.trim()) return reply.code(400).send({ error: 'Campaign name is required' })

    const agent = await prisma.agent.findFirst({ where: { id: agentId, workspaceId } })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const campaign = await prisma.campaign.create({
      data: {
        workspaceId,
        agentId,
        name: name.trim(),
        callsPerMinute: Math.min(Math.max(callsPerMinute, 1), 10), // clamp 1-10
        maxRetries: Math.min(maxRetries, 3),
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        status: 'draft',
      }
    })

    return reply.code(201).send(campaign)
  })

  /**
   * POST /campaigns/:id/contacts/upload
   * Upload a CSV of contacts. Supported columns:
   *   phone_number (required, E.164), name (optional), + any other metadata columns
   */
  app.post('/campaigns/:id/contacts/upload', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }

    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } })
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })
    if (campaign.status !== 'draft') {
      return reply.code(400).send({ error: 'Can only add contacts to draft campaigns' })
    }

    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'No file uploaded' })

    const csvBuffer = await data.toBuffer()
    const csvText = csvBuffer.toString('utf-8')

    let records: Array<Record<string, string>>
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      })
    } catch (err: any) {
      return reply.code(400).send({
        error: `CSV parse error: ${err.message}. Ensure the first row contains column headers.`
      })
    }

    const validContacts: Array<{
      campaignId: string
      phoneNumber: string
      name: string | null
      metadata: Prisma.InputJsonValue | typeof Prisma.JsonNull
    }> = []
    const errors: string[] = []

    for (let i = 0; i < records.length; i++) {
      const row = records[i]
      const phone = row.phone_number || row.phone || row.number || row.Phone

      if (!phone) {
        errors.push(`Row ${i + 2}: Missing phone_number column`)
        continue
      }

      const cleaned = phone.trim().replace(/\s+/g, '')
      if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) {
        errors.push(`Row ${i + 2}: "${phone}" is not valid E.164 format (e.g. +14155551234)`)
        continue
      }

      const { phone_number, phone: p2, number, Phone, name, Name, ...rest } = row
      validContacts.push({
        campaignId: id,
        phoneNumber: cleaned,
        name: name || Name || null,
        metadata: Object.keys(rest).length > 0 ? rest as Prisma.InputJsonValue : Prisma.JsonNull,
      })
    }

    if (validContacts.length > 0) {
      await prisma.campaignContact.createMany({
        data: validContacts,
        skipDuplicates: true,
      })
      await prisma.campaign.update({
        where: { id },
        data: { totalContacts: { increment: validContacts.length } }
      })
    }

    return reply.send({
      imported: validContacts.length,
      skipped: errors.length,
      errors: errors.slice(0, 10),
      message: errors.length > 10 ? `...and ${errors.length - 10} more errors` : undefined,
    })
  })

  /**
   * POST /campaigns/:id/start
   * Launch or schedule the campaign.
   */
  app.post('/campaigns/:id/start', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }

    const campaign = await prisma.campaign.findFirst({
      where: { id, workspaceId },
      include: { _count: { select: { contacts: true } } }
    })
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })
    if (campaign.status === 'running') {
      return reply.code(400).send({ error: 'Campaign is already running' })
    }
    if ((campaign as any)._count.contacts === 0) {
      return reply.code(400).send({ error: 'Upload contacts before starting' })
    }

    const delay = campaign.scheduledAt
      ? Math.max(0, campaign.scheduledAt.getTime() - Date.now())
      : 0

    await campaignQueue.add('run-campaign', { campaignId: id }, {
      delay,
      attempts: 1,
      removeOnComplete: false,
    })

    await prisma.campaign.update({
      where: { id },
      data: { status: campaign.scheduledAt ? 'scheduled' : 'running' }
    })

    return reply.send({
      status: campaign.scheduledAt ? 'scheduled' : 'running',
      message: campaign.scheduledAt
        ? `Campaign scheduled for ${campaign.scheduledAt.toISOString()}`
        : 'Campaign started — calls are being placed now',
    })
  })

  /**
   * POST /campaigns/:id/pause
   * Pause a running campaign.
   */
  app.post('/campaigns/:id/pause', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }

    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } })
    if (!campaign || campaign.status !== 'running') {
      return reply.code(400).send({ error: 'Campaign is not currently running' })
    }

    const { pauseCampaign } = await import('../jobs/campaign-dialer')
    await pauseCampaign(id)

    return reply.send({ status: 'paused' })
  })

  /**
   * GET /campaigns/:id/stats
   * Real-time campaign progress stats — poll every 3-5 seconds from the UI.
   */
  app.get('/campaigns/:id/stats', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }

    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } })
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const contactStats = await prisma.campaignContact.groupBy({
      by: ['status'],
      where: { campaignId: id },
      _count: true,
    })

    const statsMap = Object.fromEntries(contactStats.map(s => [s.status, s._count]))
    const total = campaign.totalContacts
    const answered = statsMap.answered || 0
    const failed = statsMap.failed || 0
    const pending = statsMap.pending || 0

    return reply.send({
      campaignId: id,
      name: campaign.name,
      status: campaign.status,
      progress: {
        total,
        pending,
        calling: statsMap.calling || 0,
        answered,
        failed,
        converted: statsMap.converted || 0,
        pctComplete: total > 0 ? Math.round(((answered + failed) / total) * 100) : 0,
      },
      estimatedMinutesRemaining: campaign.callsPerMinute > 0
        ? Math.ceil(pending / campaign.callsPerMinute)
        : null,
    })
  })

  /**
   * DELETE /campaigns/:id
   * Delete a draft or completed campaign.
   */
  app.delete('/campaigns/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string }
    const { id } = request.params as { id: string }

    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } })
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })
    if (campaign.status === 'running') {
      return reply.code(400).send({ error: 'Pause the campaign before deleting' })
    }

    await prisma.campaign.delete({ where: { id } })
    return reply.code(204).send()
  })
}
