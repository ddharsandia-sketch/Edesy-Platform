import { Queue, Worker } from 'bullmq'
import { prisma } from '../lib/prisma'
import { redis } from '../lib/redis'
import OpenAI from 'openai'
import Stripe from 'stripe'
import { fireCrmWebhooks } from '../lib/crm'
import { cerebrasClient } from '../lib/ai'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-03-25.dahlia' as any })

// Use shared Redis connection for BullMQ
const redisConnection = redis.duplicate()
redisConnection.options.maxRetriesPerRequest = null

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

// ── Queue definition ─────────────────────────────────────────────────────────
export const postCallQueue = new Queue('post-call', {
  connection: redisConnection
})

// ── Worker: processes post-call jobs ─────────────────────────────────────────
export const postCallWorker = new Worker('post-call', async (job) => {
  const { callId } = job.data
  console.log(`[POST-CALL] Processing call ${callId}`)

  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: { agent: true }
  })

  if (!call) {
    console.warn(`[POST-CALL] Call ${callId} not found — skipping`)
    return
  }

  const transcript = call.transcript as Array<{ role: string; text: string }>

  // Nothing to process if no transcript
  if (!transcript || transcript.length === 0) {
    console.log(`[POST-CALL] No transcript for call ${callId} — skipping`)
    return
  }

  const transcriptText = transcript
    .map(t => `${t.role.toUpperCase()}: ${t.text}`)
    .join('\n')

  // ── Step 1: Compute Insights with Cerebras (Instant) ────────────────────
  let sentimentScore = 0.0
  let summary = ''
  let actionItems: string[] = []
  
  try {
    const insightsRes = await cerebrasClient.chat.completions.create({
      model: 'llama3.1-8b',
      messages: [{
        role: 'system',
        content: `Analyze this call transcript. Return ONLY a raw JSON object (no markdown, no quotes) with these exact keys:
{
  "score": <number between -1.0 (very negative) and 1.0 (very positive)>,
  "label": <"positive"|"neutral"|"negative">,
  "summary": <"A 2-sentence summary of what happened">,
  "actionItems": [<array of strings of agreed next steps>]
}`
      }, {
        role: 'user',
        content: transcriptText.slice(0, 4000) // Cap to save context
      }],
      temperature: 0.1
    })

    const parsed = JSON.parse(insightsRes.choices[0].message.content || '{}')
    sentimentScore = parsed.score ?? 0.0
    summary = parsed.summary ?? ''
    actionItems = parsed.actionItems ?? []
  } catch (err) {
    console.warn(`[POST-CALL] Cerebras insights generation failed for ${callId}:`, err)
  }

  // ── Step 2: Compute call duration ─────────────────────────────────────────
  const durationSeconds = call.endTime && call.startTime
    ? Math.round((call.endTime.getTime() - call.startTime.getTime()) / 1000)
    : 0

  // ── Step 3: Estimate cost (per-minute pricing) ────────────────────────────
  const durationMinutes = durationSeconds / 60
  // Blended estimate: $0.05/min average across STT + LLM + TTS + Telephony
  const estimatedCostUsd = parseFloat((durationMinutes * 0.05).toFixed(4))

  // ── Step 5: Save everything to DB ─────────────────────────────────────────
  await prisma.call.update({
    where: { id: callId },
    data: {
      sentiment: sentimentScore,
      duration: durationSeconds,
      costUsd: estimatedCostUsd,
      // Store summary inside the artifact JSON field
      artifact: {
        ...(call.artifact as object || {}),
        summary,
        processedAt: new Date().toISOString()
      }
    }
  })

  // ── Step 6: Report usage to Stripe Meter ──────────────────────────────────
  if (durationSeconds > 0 && call.workspaceId) {
    try {
      // Fetch stripeCustomerId from workspace
      const workspace = await prisma.workspace.findUnique({ where: { id: call.workspaceId } })
      if (workspace?.stripeCustomerId) {
        const minutes = Math.ceil(durationSeconds / 60)
        await stripe.billing.meterEvents.create({
          event_name: 'call_minute_used',
          payload: {
            stripe_customer_id: workspace.stripeCustomerId,
            value: minutes.toString(),
          },
          timestamp: Math.floor(Date.now() / 1000),
        })
        console.log(`[STRIPE] Metered ${minutes} minutes for ${call.workspaceId}`)
      }
    } catch (err: any) {
      console.error(`[STRIPE] Metering failed:`, err.message)
    }
  }

  // ── Step 7: Fire all workspace integrations (HubSpot, Sheets, Slack, Notion, etc.) ───
  try {
    const { triggerIntegrations } = await import('../lib/integrations')
    await triggerIntegrations(call.workspaceId, {
      callId:          call.id,
      callerNumber:    call.callerNumber,
      callerName:      undefined,
      agentName:       call.agent?.name || 'AI Agent',
      agentId:         call.agentId,
      durationSeconds: durationSeconds,
      sentiment:       sentimentScore,
      summary:         summary,
      transcript:      transcriptText,
      direction:       call.direction,
      cost:            estimatedCostUsd,
      language:        call.agent?.language || 'en',
      startTime:       call.startTime,
    })
  } catch (err) {
    console.warn(`[POST-CALL] Integrations trigger failed for ${callId}:`, err)
  }

  // ── Step 8: Fire legacy CRM webhooks (backwards compat) ──────────────────
  try {
    await fireCrmWebhooks(call.workspaceId, {
      callId,
      agentName: call.agent.name,
      callerNumber: call.callerNumber,
      direction: call.direction,
      status: call.status,
      duration: durationSeconds,
      sentiment: sentimentScore,
      summary,
      transcript: transcriptText
    })
  } catch (err) {
    console.warn(`[POST-CALL] CRM webhook failed for ${callId}:`, err)
    // Non-critical — don't fail the job over webhook issues
  }

  // ── Step 8: Sync to HubSpot (if token configured) ─────────────────────────
  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    try {
      const { syncCallToHubspot } = await import('../lib/hubspot')
      await syncCallToHubspot({
        callerNumber: call.callerNumber,
        agentName: call.agent.name,
        duration: durationSeconds,
        sentiment: sentimentScore,
        summary,
        transcript: transcriptText,
        callId,
        workspaceId: call.workspaceId,
      })
    } catch (err: any) {
      console.warn('[POST-CALL] HubSpot sync failed (non-blocking):', err.message)
    }
  }

  console.log(`[POST-CALL] ✅ Completed processing call ${callId}: sentiment=${sentimentScore}, duration=${durationSeconds}s, cost=$${estimatedCostUsd}`)

}, { connection: redisConnection })

