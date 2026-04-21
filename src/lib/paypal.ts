// PayPal integration using plain fetch (no SDK) to avoid type declaration issues
// with @paypal/checkout-server-sdk which lacks TypeScript types

/**
 * Generate Access Token for REST API calls
 */
export async function getAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET
  const isProd = process.env.NODE_ENV === 'production'
  const url = isProd
    ? 'https://api-m.paypal.com/v1/oauth2/token'
    : 'https://api-m.sandbox.paypal.com/v1/oauth2/token'

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'en_US',
      'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  })

  const data = await response.json() as { access_token: string }
  return data.access_token
}

/**
 * Create a PayPal Subscription
 */
export async function createSubscription(planId: string, workspaceId: string) {
  const accessToken = await getAccessToken()
  const isProd = process.env.NODE_ENV === 'production'
  const url = isProd
    ? 'https://api-m.paypal.com/v1/billing/subscriptions'
    : 'https://api-m.sandbox.paypal.com/v1/billing/subscriptions'

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'PayPal-Request-Id': `sub_${workspaceId}_${Date.now()}`
    },
    body: JSON.stringify({
      plan_id: planId,
      custom_id: workspaceId,
      application_context: {
        brand_name: 'Edesy Voice AI',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings?billing=success`,
        cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings?billing=cancelled`,
      }
    })
  })

  if (!response.ok) {
    const err = await response.json()
    throw new Error(`PayPal Error: ${JSON.stringify(err)}`)
  }

  return response.json()
}

/**
 * Verify PayPal Webhook Signature
 */
export async function verifyWebhookSignature(body: string, headers: Record<string, string | string[] | undefined>) {
  const accessToken = await getAccessToken()
  const isProd = process.env.NODE_ENV === 'production'
  const url = isProd
    ? 'https://api-m.paypal.com/v1/notifications/verify-webhook-signature'
    : 'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature'

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      transmission_id: headers['paypal-transmission-id'],
      transmission_time: headers['paypal-transmission-time'],
      cert_url: headers['paypal-cert-url'],
      auth_algo: headers['paypal-auth-algo'],
      transmission_sig: headers['paypal-transmission-sig'],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: JSON.parse(body)
    })
  })

  const result = await response.json() as { verification_status: string }
  return result.verification_status === 'SUCCESS'
}
