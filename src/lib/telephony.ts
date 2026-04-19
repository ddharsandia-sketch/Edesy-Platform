import twilio from 'twilio'
import { RestClient as SignalWireClient } from '@signalwire/compatibility-api'

export type TelephonyProvider = 'twilio' | 'signalwire' | 'exotel'

export interface OutboundCallParams {
  to: string
  from: string
  url: string
}

export class TelephonyManager {
  private static instance: TelephonyManager
  private provider: TelephonyProvider

  private constructor() {
    this.provider = (process.env.TELEPHONY_PROVIDER as TelephonyProvider) || 'twilio'
  }

  public static getInstance(): TelephonyManager {
    if (!TelephonyManager.instance) {
      TelephonyManager.instance = new TelephonyManager()
    }
    return TelephonyManager.instance
  }

  /**
   * Initiate an outbound call
   */
  async makeCall(params: OutboundCallParams): Promise<{ callSid: string }> {
    console.log(`[TELEPHONY] Making ${this.provider} call to ${params.to}`)

    if (this.provider === 'signalwire') {
      const client = SignalWireClient(
        process.env.SIGNALWIRE_PROJECT_ID!,
        process.env.SIGNALWIRE_API_TOKEN!,
        { signalwireSpaceUrl: process.env.SIGNALWIRE_SPACE_URL! }
      )
      const call = await client.calls.create({
        url: params.url,
        to: params.to,
        from: params.from,
      })
      return { callSid: call.sid }
    } 
    
    if (this.provider === 'exotel') {
      // Exotel integration (API based, not XML compatible like SignalWire)
      const apiKey = process.env.EXOTEL_API_KEY
      const apiToken = process.env.EXOTEL_API_TOKEN
      const sid = process.env.EXOTEL_ACCOUNT_SID
      const subdomain = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com'

      const auth = Buffer.from(`${apiKey}:${apiToken}`).toString('base64')
      const res = await fetch(`https://${subdomain}/v1/Accounts/${sid}/Calls/connect.json`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          From: params.from,
          To: params.to,
          CallerId: params.from,
          Url: params.url,
          StatusCallback: `${process.env.NEXT_PUBLIC_API_URL}/webhooks/exotel/status`
        })
      })
      
      const data = await res.json()
      return { callSid: data.Call.Sid }
    }

    // Default to Twilio
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!)
    const call = await client.calls.create({
      url: params.url,
      to: params.to,
      from: params.from,
    })
    return { callSid: call.sid }
  }

  /**
   * Generate TwiML/compatible XML
   */
  generateConnectXml(roomName: string, token: string): string {
    // Both Twilio and SignalWire support <Connect><Stream>
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${process.env.LIVEKIT_URL?.replace('wss://', '')}/twilio">
      <Parameter name="roomName" value="${roomName}"/>
      <Parameter name="token" value="${token}"/>
    </Stream>
  </Connect>
</Response>`
  }
}
