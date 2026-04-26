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
 * 2. Log the call as a HubSpot Call object (v3 CRM API)
 * 3. Associate it with the contact
 *
 * Non-blocking — failures are logged but do not affect the post-call job.
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

    // ── Step 2: Log call using v3 CRM Objects API (crm.objects.calls) ────────
    // Note: crm.engagements was deprecated in HubSpot API v3+
    const sentimentLabel = payload.sentiment > 0.3 ? '😊 Positive'
      : payload.sentiment < -0.3 ? '😠 Negative'
      : '😐 Neutral'

    const callBody = [
      `AI Agent: ${payload.agentName}`,
      `Duration: ${Math.floor(payload.duration / 60)}m ${payload.duration % 60}s`,
      `Sentiment: ${sentimentLabel} (score: ${payload.sentiment.toFixed(2)})`,
      ``,
      `SUMMARY:`,
      payload.summary,
      ``,
      `TRANSCRIPT:`,
      payload.transcript.slice(0, 3000),
    ].join('\n')

    const callObject = await hubspot.crm.objects.calls.basicApi.create({
      properties: {
        hs_call_body: callBody,
        hs_call_duration: String(payload.duration * 1000),
        hs_call_status: 'COMPLETED',
        hs_call_direction: 'INBOUND',
        hs_timestamp: String(Date.now()),
      }
    })

    // Associate call with contact using v4 Associations API
    await hubspot.crm.associations.v4.basicApi.create(
      'calls',
      callObject.id,
      'contacts',
      contactId,
      [{ associationCategory: 'HUBSPOT_DEFINED' as any, associationTypeId: 194 }]
    )

    console.log(`[HUBSPOT] ✅ Call logged for contact ${contactId}`)

  } catch (err: any) {
    // Non-critical — don't fail the BullMQ job over HubSpot issues
    console.warn(`[HUBSPOT] Sync failed for ${payload.callerNumber}:`, err.message)
  }
}
