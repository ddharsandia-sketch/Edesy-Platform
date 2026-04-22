/**
 * integrations.ts
 * 
 * Core integrations library. Fires after every call to push data to:
 * HubSpot, Google Sheets, Google Calendar, Zapier, Slack, Notion, 
 * Salesforce, WhatsApp (Gupshup), WhatsApp (Twilio)
 */

import { prisma } from './prisma'

export interface CallPayload {
  callId: string
  callerNumber: string
  callerName?: string
  agentName: string
  agentId: string
  durationSeconds: number
  sentiment: string | number
  summary?: string
  transcript?: string
  direction: string
  cost?: number
  language?: string
  startTime: Date
}

type IntegrationType =
  | 'hubspot'
  | 'google_sheets'
  | 'google_calendar'
  | 'zapier'
  | 'slack'
  | 'notion'
  | 'salesforce'
  | 'whatsapp_gupshup'
  | 'whatsapp_twilio'

/** Master dispatcher: loads enabled integrations and fires each handler */
export async function triggerIntegrations(workspaceId: string, payload: CallPayload) {
  let integrations: Array<{
    id: string
    type: string
    apiKey: string
    config: unknown
    enabled: boolean
  }>

  try {
    integrations = await prisma.integration.findMany({
      where: { workspaceId, enabled: true },
      select: { id: true, type: true, apiKey: true, config: true, enabled: true },
    })
  } catch (err) {
    console.warn('[INTEGRATIONS] Failed to load integrations:', err)
    return
  }

  await Promise.allSettled(
    integrations.map(integration =>
      fireIntegration(integration.type as IntegrationType, integration.apiKey, integration.config, payload)
        .then(() => {
          return prisma.integration.update({
            where: { id: integration.id },
            data: { lastTestedAt: new Date(), lastTestOk: true },
          }).catch(() => {})
        })
        .catch((err) => {
          console.warn(`[INTEGRATIONS] ${integration.type} failed:`, err?.message || err)
          return prisma.integration.update({
            where: { id: integration.id },
            data: { lastTestedAt: new Date(), lastTestOk: false },
          }).catch(() => {})
        })
    )
  )
}

async function fireIntegration(
  type: IntegrationType,
  apiKey: string,
  config: unknown,
  payload: CallPayload
) {
  switch (type) {
    case 'hubspot':      return fireHubspot(apiKey, payload)
    case 'google_sheets': return fireGoogleSheets(apiKey, config, payload)
    case 'zapier':       return fireZapier(apiKey, payload)
    case 'slack':        return fireSlack(apiKey, payload)
    case 'notion':       return fireNotion(apiKey, config, payload)
    case 'salesforce':   return fireSalesforce(apiKey, payload)
    case 'whatsapp_gupshup': return fireWhatsappGupshup(apiKey, config, payload)
    case 'whatsapp_twilio':  return fireWhatsappTwilio(apiKey, config, payload)
    default:
      console.warn(`[INTEGRATIONS] Unknown type: ${type}`)
  }
}

// ── HubSpot ───────────────────────────────────────────────────────────────────

async function fireHubspot(accessToken: string, payload: CallPayload) {
  const base = 'https://api.hubapi.com'
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  }

  // Search for existing contact
  const searchRes = await fetch(`${base}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filterGroups: [{
        filters: [{ propertyName: 'phone', operator: 'EQ', value: payload.callerNumber }]
      }],
      properties: ['phone', 'firstname', 'lastname'],
    }),
  })
  const searchData = await searchRes.json() as any

  let contactId = searchData.results?.[0]?.id

  if (!contactId) {
    // Create contact
    const createRes = await fetch(`${base}/crm/v3/objects/contacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        properties: {
          phone: payload.callerNumber,
          firstname: payload.callerName || 'Unknown',
          lastname: 'Caller',
        },
      }),
    })
    const createData = await createRes.json() as any
    contactId = createData.id
  }

  if (!contactId) throw new Error('Could not create/find HubSpot contact')

  // Log call
  const sentimentLabel = typeof payload.sentiment === 'number'
    ? payload.sentiment > 0.3 ? 'Positive' : payload.sentiment < -0.3 ? 'Negative' : 'Neutral'
    : String(payload.sentiment)

  await fetch(`${base}/crm/v3/objects/calls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      properties: {
        hs_call_title: `AI Call - ${payload.agentName}`,
        hs_call_body: payload.summary || payload.transcript?.slice(0, 2000) || '',
        hs_call_duration: (payload.durationSeconds * 1000).toString(),
        hs_call_status: 'COMPLETED',
        hs_call_direction: payload.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
        hs_timestamp: payload.startTime.getTime().toString(),
        hs_call_from_number: payload.callerNumber,
      },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }] }],
    }),
  })

  console.log(`[HUBSPOT] Logged call for contact ${contactId}`)
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

async function fireGoogleSheets(apiKey: string, config: unknown, payload: CallPayload) {
  const cfg = config as { spreadsheetId: string; sheetName?: string }
  if (!cfg?.spreadsheetId) throw new Error('Missing spreadsheetId in Google Sheets config')

  const sheetName = cfg.sheetName || 'Calls'
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}/values/${sheetName}!A1:append?valueInputOption=USER_ENTERED&key=${apiKey}`

  const sentimentLabel = typeof payload.sentiment === 'number'
    ? payload.sentiment > 0.3 ? 'positive' : payload.sentiment < -0.3 ? 'negative' : 'neutral'
    : String(payload.sentiment)

  const row = [
    payload.startTime.toISOString(),
    payload.callId,
    payload.callerNumber,
    payload.callerName || '',
    payload.agentName,
    payload.direction,
    payload.durationSeconds,
    sentimentLabel,
    payload.summary || '',
    payload.cost?.toFixed(4) || '',
  ]

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  })

  if (!res.ok) {
    const err = await res.json()
    throw new Error(`Google Sheets API error: ${(err as any).error?.message || res.status}`)
  }

  console.log('[GOOGLE SHEETS] Row appended')
}

// ── Zapier ────────────────────────────────────────────────────────────────────

async function fireZapier(webhookUrl: string, payload: CallPayload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      call_id: payload.callId,
      caller_number: payload.callerNumber,
      caller_name: payload.callerName,
      agent_name: payload.agentName,
      agent_id: payload.agentId,
      direction: payload.direction,
      duration_seconds: payload.durationSeconds,
      sentiment: payload.sentiment,
      summary: payload.summary,
      language: payload.language,
      cost_usd: payload.cost,
      timestamp: payload.startTime.toISOString(),
    }),
  })

  if (!res.ok) throw new Error(`Zapier webhook failed: ${res.status}`)
  console.log('[ZAPIER] Webhook fired')
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function fireSlack(webhookUrl: string, payload: CallPayload) {
  const sentimentEmoji = typeof payload.sentiment === 'number'
    ? payload.sentiment > 0.3 ? '😊' : payload.sentiment < -0.3 ? '😠' : '😐'
    : '📞'

  const mins = Math.floor(payload.durationSeconds / 60)
  const secs = payload.durationSeconds % 60
  const duration = `${mins}m ${secs}s`

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${sentimentEmoji} *New ${payload.direction} call completed*\n*Agent:* ${payload.agentName} | *Duration:* ${duration} | *Caller:* ${payload.callerNumber}`,
          },
        },
        ...(payload.summary ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*Summary:*\n${payload.summary}` },
        }] : []),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Call ID: \`${payload.callId}\` | ${payload.startTime.toUTCString()}` }],
        },
      ],
    }),
  })

  if (!res.ok) throw new Error(`Slack webhook failed: ${res.status}`)
  console.log('[SLACK] Message posted')
}

// ── Notion ────────────────────────────────────────────────────────────────────

async function fireNotion(apiKey: string, config: unknown, payload: CallPayload) {
  const cfg = config as { databaseId: string }
  if (!cfg?.databaseId) throw new Error('Missing databaseId in Notion config')

  const sentimentLabel = typeof payload.sentiment === 'number'
    ? payload.sentiment > 0.3 ? 'positive' : payload.sentiment < -0.3 ? 'negative' : 'neutral'
    : String(payload.sentiment)

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { database_id: cfg.databaseId },
      properties: {
        'Call ID': { title: [{ text: { content: payload.callId } }] },
        'Caller': { rich_text: [{ text: { content: payload.callerNumber } }] },
        'Agent': { rich_text: [{ text: { content: payload.agentName } }] },
        'Direction': { select: { name: payload.direction } },
        'Duration (s)': { number: payload.durationSeconds },
        'Sentiment': { select: { name: sentimentLabel } },
        'Summary': { rich_text: [{ text: { content: (payload.summary || '').slice(0, 2000) } }] },
        'Date': { date: { start: payload.startTime.toISOString() } },
      },
    }),
  })

  if (!res.ok) {
    const err = await res.json()
    throw new Error(`Notion API error: ${(err as any).message}`)
  }
  console.log('[NOTION] Page created')
}

// ── Salesforce ────────────────────────────────────────────────────────────────

async function fireSalesforce(accessToken: string, payload: CallPayload) {
  // Salesforce instance URL should be in apiKey as `instanceUrl::accessToken`
  const [instanceUrl, token] = accessToken.split('::')
  if (!instanceUrl || !token) throw new Error('Salesforce apiKey format: instanceUrl::accessToken')

  const res = await fetch(`${instanceUrl}/services/data/v57.0/sobjects/Lead`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      LastName: payload.callerName || 'AI Call Lead',
      Company: 'Inbound Lead',
      Phone: payload.callerNumber,
      Description: `AI Agent Call\nAgent: ${payload.agentName}\nDirection: ${payload.direction}\nSummary: ${payload.summary || 'No summary'}`,
      LeadSource: 'AI Voice Agent',
    }),
  })

  if (!res.ok) {
    const err = await res.json()
    throw new Error(`Salesforce error: ${(err as any)?.[0]?.message || res.status}`)
  }
  console.log('[SALESFORCE] Lead created')
}

// ── WhatsApp via Gupshup ──────────────────────────────────────────────────────

async function fireWhatsappGupshup(apiKey: string, config: unknown, payload: CallPayload) {
  const cfg = config as { appName: string; phone: string; sourcePhone: string }
  if (!cfg?.appName || !cfg?.sourcePhone) throw new Error('Gupshup config needs appName and sourcePhone')

  const to = cfg.phone || payload.callerNumber
  const message = `Hi${payload.callerName ? ` ${payload.callerName}` : ''}! Thank you for your call with ${payload.agentName}. ${payload.summary ? `Summary: ${payload.summary}` : 'We hope we could help!'} If you have any questions, feel free to reply here.`

  const res = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      apikey: apiKey,
    },
    body: new URLSearchParams({
      channel: 'whatsapp',
      source: cfg.sourcePhone,
      destination: to.replace('+', ''),
      message: JSON.stringify({ type: 'text', text: message }),
      'src.name': cfg.appName,
    }).toString(),
  })

  if (!res.ok) throw new Error(`Gupshup API error: ${res.status}`)
  console.log('[WHATSAPP/GUPSHUP] Message sent')
}

// ── WhatsApp via Twilio ───────────────────────────────────────────────────────

async function fireWhatsappTwilio(apiKey: string, config: unknown, payload: CallPayload) {
  // apiKey format: accountSid:authToken
  const [accountSid, authToken] = apiKey.split(':')
  if (!accountSid || !authToken) throw new Error('Twilio WhatsApp apiKey format: accountSid:authToken')

  const cfg = config as { fromNumber: string; toNumber?: string }
  if (!cfg?.fromNumber) throw new Error('Twilio WhatsApp config needs fromNumber')

  const to = cfg.toNumber || payload.callerNumber
  const message = `Hi${payload.callerName ? ` ${payload.callerName}` : ''}! Thank you for speaking with ${payload.agentName}. ${payload.summary || 'We hope we could help!'}`

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64')

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      From: `whatsapp:${cfg.fromNumber}`,
      To: `whatsapp:${to}`,
      Body: message,
    }).toString(),
  })

  if (!res.ok) {
    const err = await res.json()
    throw new Error(`Twilio WhatsApp error: ${(err as any).message || res.status}`)
  }
  console.log('[WHATSAPP/TWILIO] Message sent')
}
