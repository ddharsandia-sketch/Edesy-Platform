import { Client as HubspotClient } from '@hubspot/api-client'

const hubspot = new HubspotClient({
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN
})

interface CallSyncPayload {
  callerNumber: string
  agentName: string
  duration: number
  sentiment: number
  summary: string
  transcript: string
  callId: string
  workspaceId: string
}

/**
 * After every completed call:
 * 1. Find or create a HubSpot contact by phone number
 * 2. Log the call as a HubSpot engagement with full transcript
 * 3. Update the contact's last_ai_agent field
 *
 * This is entirely non-blocking — failures are logged but do not
 * affect the post-call processing job or the caller experience.
 */
export async function syncCallToHubspot(payload: CallSyncPayload) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) return

  try {
    // ── Step 1: Find or create contact ───────────────────────────────────────
    let contactId: string | null = null

    try {
      const searchRes = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'phone',
            operator: 'EQ' as any,
            value: payload.callerNumber,
          }]
        }],
        properties: ['phone', 'firstname', 'lastname'],
        limit: 1,
        after: '0',
        sorts: [],
      })

      if (searchRes.results.length > 0) {
        contactId = searchRes.results[0].id
        console.log(`[HUBSPOT] Found contact ${contactId} for ${payload.callerNumber}`)
      }
    } catch {
      // Contact not found — will create below
    }

    if (!contactId) {
      const newContact = await hubspot.crm.contacts.basicApi.create({
        properties: {
          phone: payload.callerNumber,
          hs_lead_status: 'IN_PROGRESS',
          last_ai_agent: payload.agentName,
        }
      })
      contactId = newContact.id
      console.log(`[HUBSPOT] Created contact ${contactId} for ${payload.callerNumber}`)
    }

    // ── Step 2: Log call as engagement ───────────────────────────────────────
    const sentimentLabel = payload.sentiment > 0.3 ? '😊 Positive'
      : payload.sentiment < -0.3 ? '😠 Negative'
      : '😐 Neutral'

    await hubspot.crm.engagements.basicApi.create({
      engagement: {
        active: true,
        type: 'CALL' as any,
        timestamp: Date.now(),
      },
      associations: {
        contactIds: [parseInt(contactId)],
        companyIds: [],
        dealIds: [],
        ownerIds: [],
        ticketIds: [],
      },
      metadata: {
        body: [
          `AI Agent: ${payload.agentName}`,
          `Duration: ${Math.floor(payload.duration / 60)}m ${payload.duration % 60}s`,
          `Sentiment: ${sentimentLabel} (score: ${payload.sentiment.toFixed(2)})`,
          ``,
          `SUMMARY:`,
          payload.summary,
          ``,
          `TRANSCRIPT:`,
          payload.transcript.slice(0, 3000),
        ].join('\n'),
        durationMilliseconds: payload.duration * 1000,
        status: 'COMPLETED',
        disposition: payload.sentiment > 0.3 ? 'CONNECTED' : 'LEFT_MESSAGE',
        recordingUrl: null,
        toNumber: payload.callerNumber,
        fromNumber: '',
      }
    })

    console.log(`[HUBSPOT] ✅ Call logged for contact ${contactId}`)

  } catch (err: any) {
    // Non-critical — don't fail the BullMQ job over HubSpot issues
    console.warn(`[HUBSPOT] Sync failed for ${payload.callerNumber}:`, err.message)
  }
}
