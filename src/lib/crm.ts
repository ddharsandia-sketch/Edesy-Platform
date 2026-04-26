import { prisma } from './prisma'

interface CallPayload {
  callId: string
  agentName: string
  callerNumber: string
  direction: string
  status: string
  duration: number
  sentiment: number
  summary: string
  transcript: string
}

/**
 * Fire all configured CRM webhooks for a workspace after a call ends.
 * Each workspace can configure 0-N webhook endpoints in Settings.
 * We attempt all webhooks and log failures individually.
 */
export async function fireCrmWebhooks(workspaceId: string, payload: CallPayload) {
  const webhooks = await prisma.webhook.findMany({
    where: { workspaceId, isActive: true }
  })

  if (webhooks.length === 0) return

  const results = await Promise.allSettled(
    webhooks.map(webhook => fireWebhook(webhook, payload))
  )

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`[CRM] Webhook ${webhooks[i].url} failed:`, result.reason)
    }
  })
}

async function fireWebhook(
  webhook: { id: string; url: string; secret?: string | null },
  payload: CallPayload
) {
  const body = JSON.stringify({
    event: 'call.completed',
    timestamp: new Date().toISOString(),
    data: payload
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'VoiceAI-Platform/1.0',
  }

  // HMAC signature if secret is configured
  if (webhook.secret) {
    const { createHmac } = await import('crypto')
    const signature = createHmac('sha256', webhook.secret)
      .update(body)
      .digest('hex')
    headers['X-VoiceAI-Signature'] = `sha256=${signature}`
  }

  const response = await fetch(webhook.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10000),  // 10 second timeout
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }

  console.log(`[CRM] Webhook ${webhook.url} → ${response.status}`)
}
