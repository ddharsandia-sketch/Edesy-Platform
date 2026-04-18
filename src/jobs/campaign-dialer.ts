import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import pLimit from 'p-limit'
import { prisma } from '../lib/prisma'

const redisConnection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined,
})

export const campaignQueue = new Queue('campaign-dialer', {
  connection: redisConnection,
})

// ── Campaign Orchestrator Worker ──────────────────────────────────────────────
// Picks up "run-campaign" jobs and dials all contacts in controlled batches.
export const campaignWorker = new Worker('campaign-dialer', async (job) => {
  const { campaignId } = job.data

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      agent: { include: { phoneNumbers: { take: 1 } } },
      contacts: {
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
      }
    }
  })

  if (!campaign) throw new Error(`Campaign ${campaignId} not found`)
  if (campaign.agent.phoneNumbers.length === 0) {
    throw new Error(`Agent ${campaign.agentId} has no phone number assigned. Assign one in Agent Settings first.`)
  }

  console.log(`[CAMPAIGN] Starting "${campaign.name}" — ${campaign.contacts.length} contacts to dial`)

  // Mark as running
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'running' }
  })

  // Concurrency limiter — respect callsPerMinute setting
  const concurrency = Math.min(
    campaign.callsPerMinute,
    parseInt(process.env.CAMPAIGN_MAX_CONCURRENT || '5')
  )
  const limit = pLimit(concurrency)

  // Dial all pending contacts with concurrency control
  const dialTasks = campaign.contacts.map(contact =>
    limit(() => dialContact(campaign, contact))
  )
  await Promise.allSettled(dialTasks)

  // Tally final stats
  const finalStats = await prisma.campaignContact.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: true,
  })
  const answered = finalStats.find(s => s.status === 'answered')?._count || 0
  const converted = finalStats.find(s => s.status === 'converted')?._count || 0

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      answeredCount: answered,
      convertedCount: converted,
    }
  })

  console.log(`[CAMPAIGN] ✅ "${campaign.name}" complete — ${answered} answered, ${converted} converted`)

}, {
  connection: redisConnection,
  concurrency: 1,         // One campaign orchestrator at a time per worker instance
  lockDuration: 3600000,  // 1 hour lock — campaigns can run for hours
})


// ── Individual contact dialer ─────────────────────────────────────────────────
async function dialContact(campaign: any, contact: any) {
  await prisma.campaignContact.update({
    where: { id: contact.id },
    data: { status: 'calling', attempts: { increment: 1 }, lastAttempt: new Date() }
  })

  try {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

    const response = await fetch(`${apiBase}/calls/outbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CAMPAIGN_SERVICE_TOKEN || 'internal'}`,
        'X-Campaign-Id': campaign.id,
        'X-Campaign-Contact-Id': contact.id,
      },
      body: JSON.stringify({
        agentId: campaign.agentId,
        toNumber: contact.phoneNumber,
        // Inject contact name/metadata into persona context for personalized greetings
        contextOverride: contact.name
          ? `The person you're calling is ${contact.name}.${contact.metadata ? ' Context: ' + JSON.stringify(contact.metadata) : ''}`
          : undefined,
      })
    })

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${await response.text()}`)
    }

    const result = await response.json()

    await prisma.campaignContact.update({
      where: { id: contact.id },
      data: { status: 'answered', callId: result.callId }
    })

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { calledCount: { increment: 1 } }
    })

    // Throttle: space calls to respect callsPerMinute
    // e.g., 2/min = sleep 30s between each call
    const delayMs = Math.floor(60000 / campaign.callsPerMinute)
    await new Promise(resolve => setTimeout(resolve, delayMs))

  } catch (err: any) {
    console.error(`[CAMPAIGN] Failed to dial ${contact.phoneNumber}:`, err.message)
    const isFinalAttempt = contact.attempts >= campaign.maxRetries
    await prisma.campaignContact.update({
      where: { id: contact.id },
      data: { status: isFinalAttempt ? 'failed' : 'pending' }
    })
  }
}


// ── Pause helper ──────────────────────────────────────────────────────────────
export async function pauseCampaign(campaignId: string) {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'paused' }
  })
  const jobs = await campaignQueue.getJobs(['active', 'waiting'])
  for (const job of jobs) {
    if (job.data.campaignId === campaignId) {
      await job.moveToFailed(new Error('Paused by user'), '0', false)
    }
  }
}
