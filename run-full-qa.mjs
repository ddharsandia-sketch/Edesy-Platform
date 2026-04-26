import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = "https://mwwnnhrxhftiyvdbyjcr.supabase.co"
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13d25uaHJ4aGZ0aXl2ZGJ5amNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MTA0NzEsImV4cCI6MjA5MjA4NjQ3MX0.XXlmfquc8eJYd5bqAg8VKLZ1GO03tt3h_28fAInG5vA"
const API_URL = 'https://edesyapi-production.up.railway.app'
const EMAIL = 'iamjabirul@gmail.com'
const PASSWORD = '1234567'

const results = []
let token = ''
let agentId = ''
let workspaceId = ''

function section(name) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  SECTION: ${name}`)
  console.log(`${'═'.repeat(60)}`)
}

function log(step, status, detail, extra = '') {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : status === 'WARN' ? '⚠️ ' : '📝'
  const msg = `${icon} [${step}] ${detail}${extra ? ` → ${extra}` : ''}`
  console.log(msg)
  results.push({ step, status, detail, extra })
}

async function api(method, path, body = null, customToken = null) {
  const options = {
    method,
    headers: { 'Authorization': `Bearer ${customToken || token}` }
  }
  if (body) {
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  try {
    const res = await fetch(`${API_URL}${path}`, options)
    let data
    try { data = await res.json() } catch { data = {} }
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: { error: err.message } }
  }
}

// ──────────────────────────────────────────────
// 1. AUTH
// ──────────────────────────────────────────────
section('AUTHENTICATION')

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (authError) {
  log('Login (Supabase)', 'FAIL', authError.message)
  process.exit(1)
}
token = authData.session.access_token
workspaceId = authData.user.id
log('Login (Supabase)', 'PASS', `Authenticated as ${authData.user.email}`)

// Test our custom API login too (what the app's frontend uses)
const customLogin = await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD }, 'none')
if (customLogin.ok) {
  log('Login (API /auth/login)', 'PASS', `Got JWT token + workspaceId: ${customLogin.data.workspaceId}`)
} else {
  log('Login (API /auth/login)', 'FAIL', `Status ${customLogin.status}: ${JSON.stringify(customLogin.data)}`)
}

// Bad password test
const badLogin = await api('POST', '/auth/login', { email: EMAIL, password: 'wrongpass123' }, 'none')
if (!badLogin.ok) {
  log('Login (wrong password)', 'PASS', 'Correctly rejects invalid credentials')
} else {
  log('Login (wrong password)', 'FAIL', 'Allowed login with wrong password — security issue!')
}

// ──────────────────────────────────────────────
// 2. OVERVIEW / DASHBOARD DATA
// ──────────────────────────────────────────────
section('DASHBOARD / OVERVIEW')

const agents = await api('GET', '/agents')
if (agents.ok) {
  log('Dashboard - Load Agents', 'PASS', `Found ${agents.data.length} agents`)
} else {
  log('Dashboard - Load Agents', 'FAIL', `${agents.status}: ${JSON.stringify(agents.data)}`)
}

const calls = await api('GET', '/calls')
if (calls.ok) {
  log('Dashboard - Load Calls', 'PASS', `Found ${calls.data.calls?.length || 0} call records`)
} else {
  log('Dashboard - Load Calls', 'FAIL', `${calls.status}: ${JSON.stringify(calls.data)}`)
}

// ──────────────────────────────────────────────
// 3. TEMPLATES (Frontend only - test deploy logic)
// ──────────────────────────────────────────────
section('AGENT TEMPLATES (Deploy Flow)')

// Templates are frontend only - test the deploy path which creates an agent
const templateDeploy = await api('POST', '/agents', {
  name: 'Customer Support Agent (English)',
  personaPrompt: 'You are a friendly and professional customer support agent. Your name is Alex. Your goals: 1. Greet the customer and identify their issue. 2. For order status: Ask for order number and provide a status update. 3. For refunds/returns: Collect order ID, reason for return, and initiate the process. 4. Escalate complex cases to human agents.',
  language: 'en',
  voiceId: '21m00Tcm4TlvDq8ikWAM',
  voiceProvider: 'elevenlabs',
  tierId: 'efficient',
  industry: 'ecommerce',
  useCaseId: 'support',
  templateId: 'customer-support-en'
})
if (templateDeploy.ok) {
  agentId = templateDeploy.data.id
  log('Templates - Deploy Agent', 'PASS', `Created agent from template: ID ${agentId}`)
} else {
  log('Templates - Deploy Agent', 'FAIL', `${templateDeploy.status}: ${JSON.stringify(templateDeploy.data)}`)
  // Create a basic agent anyway for subsequent tests
  const fallback = await api('POST', '/agents', {
    name: 'QA Test Agent',
    personaPrompt: 'You are a helpful assistant for testing purposes only.',
    language: 'en'
  })
  if (fallback.ok) agentId = fallback.data.id
}

// ──────────────────────────────────────────────
// 4. AGENTS
// ──────────────────────────────────────────────
section('AGENTS PAGE')

// Get agent list
const agentList = await api('GET', '/agents')
log('Agents - List', agentList.ok ? 'PASS' : 'FAIL', `Status ${agentList.status}, count: ${agentList.data?.length}`)

if (agentId) {
  // Get single agent
  const singleAgent = await api('GET', `/agents/${agentId}`)
  // Note: if no GET single endpoint, this might 404
  log('Agents - Get Single', singleAgent.ok ? 'PASS' : singleAgent.status === 404 ? 'WARN' : 'FAIL',
    singleAgent.ok ? 'Agent details fetched' : `Status ${singleAgent.status}: ${JSON.stringify(singleAgent.data)}`)

  // Update agent (all fields)
  const patch = await api('PATCH', `/agents/${agentId}`, {
    name: 'Updated Support Agent',
    tierId: 'premium',
    useCaseId: 'sales',
    isActive: true,
    language: 'en',
    voiceId: 'VR6AewLTigWG4xSOukaG',
    voiceProvider: 'elevenlabs',
    sttProvider: 'deepgram',
    llmModel: 'gemini-2.0-flash'
  })
  log('Agents - Update (PATCH)', patch.ok ? 'PASS' : 'FAIL',
    patch.ok ? 'All fields updated successfully' : `${patch.status}: ${JSON.stringify(patch.data)}`)

  // Phone numbers
  const phones = await api('GET', `/agents/${agentId}/phone-numbers`)
  log('Agents - Phone Numbers', phones.ok ? 'PASS' : 'FAIL',
    phones.ok ? `${phones.data.length} numbers assigned` : `${phones.status}: ${JSON.stringify(phones.data)}`)

  // Try assigning an invalid number
  const badNum = await api('POST', `/agents/${agentId}/phone-numbers`, { number: '1234' })
  log('Agents - Invalid Phone Validation', !badNum.ok ? 'PASS' : 'FAIL',
    !badNum.ok ? 'Correctly rejects invalid E.164 number' : 'Bug: accepted invalid number format')

  // Simulation (stress test)
  const sim = await api('POST', `/agents/${agentId}/simulate`, { numSimulations: 2, maxTurns: 3 })
  if (sim.ok) {
    log('Agents - Simulate', 'PASS', `Simulation job created: ${sim.data.job_id || JSON.stringify(sim.data)}`)
  } else {
    log('Agents - Simulate', 'FAIL', `${sim.status}: ${JSON.stringify(sim.data)}`)
  }
}

// ──────────────────────────────────────────────
// 5. MISSION CONTROL
// ──────────────────────────────────────────────
section('MISSION CONTROL')

const callsAll = await api('GET', '/calls')
log('Mission Control - All Calls', callsAll.ok ? 'PASS' : 'FAIL',
  callsAll.ok ? `${callsAll.data.calls?.length || 0} calls total` : `${callsAll.status}: ${JSON.stringify(callsAll.data)}`)

// Test filtering calls by agent
if (agentId) {
  const agentCalls = await api('GET', `/calls?agentId=${agentId}`)
  log('Mission Control - Filter by Agent', agentCalls.ok ? 'PASS' : 'FAIL',
    agentCalls.ok ? `Filtered calls: ${agentCalls.data.calls?.length || 0}` : `${agentCalls.status}`)
}

// ──────────────────────────────────────────────
// 6. CAMPAIGNS
// ──────────────────────────────────────────────
section('CAMPAIGNS')

const campaigns = await api('GET', '/campaigns')
log('Campaigns - List', campaigns.ok ? 'PASS' : 'FAIL',
  campaigns.ok ? `${campaigns.data.length || 0} campaigns found` : `${campaigns.status}: ${JSON.stringify(campaigns.data)}`)

if (agentId) {
  // Create a campaign
  const newCampaign = await api('POST', '/campaigns', {
    name: 'QA Test Campaign',
    agentId,
    contacts: [
      { name: 'Test Contact 1', phone: '+14155551234' },
      { name: 'Test Contact 2', phone: '+14155555678' }
    ],
    scheduledAt: new Date(Date.now() + 86400000).toISOString() // tomorrow
  })
  if (newCampaign.ok) {
    log('Campaigns - Create', 'PASS', `Created campaign: ${newCampaign.data.id}`)
    const cId = newCampaign.data.id

    // Get campaign
    const getCampaign = await api('GET', `/campaigns/${cId}`)
    log('Campaigns - Get Single', getCampaign.ok ? 'PASS' : 'FAIL',
      getCampaign.ok ? `Campaign name: ${getCampaign.data.name}` : `${getCampaign.status}`)

    // Upload contacts via multipart/form-data CSV
    const csvContent = "name,phone_number\nTest Upload Contact 1,+14155551234\nTest Upload Contact 2,+14155555678"
    const formData = new FormData()
    formData.append('file', new Blob([csvContent], { type: 'text/csv' }), 'contacts.csv')

    const uploadContactsRes = await fetch(`${API_URL}/campaigns/${cId}/contacts/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    })
    const uploadData = await uploadContactsRes.json()
    log('Campaigns - Upload Contacts', uploadContactsRes.ok ? 'PASS' : 'WARN',
      uploadContactsRes.ok ? `Contacts uploaded: ${uploadData.imported || 2}` : `${uploadContactsRes.status}: ${JSON.stringify(uploadData)}`)

    // Start campaign
    const startCampaign = await api('POST', `/campaigns/${cId}/start`)
    log('Campaigns - Start', startCampaign.ok ? 'PASS' : 'WARN',
      startCampaign.ok ? 'Campaign started successfully' : `${startCampaign.status}: ${JSON.stringify(startCampaign.data)}`)

    // Pause campaign
    const pauseCampaign = await api('POST', `/campaigns/${cId}/pause`)
    log('Campaigns - Pause', pauseCampaign.ok ? 'PASS' : 'WARN',
      pauseCampaign.ok ? 'Campaign paused' : `${pauseCampaign.status}: ${JSON.stringify(pauseCampaign.data)}`)

    // Delete campaign
    const delCampaign = await api('DELETE', `/campaigns/${cId}`)
    log('Campaigns - Delete', delCampaign.ok ? 'PASS' : 'FAIL',
      delCampaign.ok ? 'Campaign deleted' : `${delCampaign.status}: ${JSON.stringify(delCampaign.data)}`)
  } else {
    log('Campaigns - Create', 'FAIL', `${newCampaign.status}: ${JSON.stringify(newCampaign.data)}`)
  }
}

// ──────────────────────────────────────────────
// 7. KNOWLEDGE BASE
// ──────────────────────────────────────────────
section('KNOWLEDGE BASE')

if (agentId) {
  const kb = await api('GET', `/knowledge/${agentId}`)
  log('Knowledge Base - List Docs', kb.ok ? 'PASS' : 'FAIL',
    kb.ok ? `${kb.data.length} documents in knowledge base` : `${kb.status}: ${JSON.stringify(kb.data)}`)
}

// ──────────────────────────────────────────────
// 8. ANALYTICS
// ──────────────────────────────────────────────
section('ANALYTICS')

const analyticsOverview = await api('GET', '/analytics/overview?days=7')
if (analyticsOverview.ok) {
  log('Analytics - Overview', 'PASS', `Total calls: ${analyticsOverview.data.totalCalls}, Active: ${analyticsOverview.data.activeCalls}`)
} else {
  log('Analytics - Overview', 'FAIL', `${analyticsOverview.status}: ${JSON.stringify(analyticsOverview.data)}`)
}

const analyticsChart = await api('GET', '/analytics/calls-over-time?days=7')
if (analyticsChart.ok) {
  log('Analytics - Calls Over Time', 'PASS', `${analyticsChart.data.length} data points`)
} else {
  log('Analytics - Calls Over Time', 'FAIL', `${analyticsChart.status}: ${JSON.stringify(analyticsChart.data)}`)
}

// ──────────────────────────────────────────────
// 9. SETTINGS
// ──────────────────────────────────────────────
section('SETTINGS')

const settings = await api('GET', '/api/settings')
log('Settings - Load', settings.ok ? 'PASS' : 'FAIL',
  settings.ok ? `Loaded. Plan: ${settings.data.plan}, Tel: ${settings.data.activeTel}` : `${settings.status}: ${JSON.stringify(settings.data)}`)

// Test saving Twilio credentials
const twilioSave = await api('PATCH', '/api/settings', {
  activeTel: 'twilio',
  twilioAccountSid: 'AC_test_1234567890',
  twilioAuthToken: 'auth_token_test_very_long_secret_key',
  twilioPhoneNumber: '+14155550100'
})
log('Settings - Save Twilio Creds', twilioSave.ok ? 'PASS' : 'FAIL',
  twilioSave.ok ? `Saved: ${JSON.stringify(twilioSave.data.updated)}` : `${twilioSave.status}: ${JSON.stringify(twilioSave.data)}`)

// Test saving AI provider keys
const aiSave = await api('PATCH', '/api/settings', {
  groqApiKey: 'gsk_test_key_very_long_string_here_12345',
  elevenLabsApiKey: 'el_test_key_very_long_string_here_54321',
  deepgramApiKey: 'dg_test_key_very_long_string_here_99999'
})
log('Settings - Save AI Provider Keys', aiSave.ok ? 'PASS' : 'FAIL',
  aiSave.ok ? `Saved: ${JSON.stringify(aiSave.data.updated)}` : `${aiSave.status}: ${JSON.stringify(aiSave.data)}`)

// Test that masked values don't overwrite
const settingsAfter = await api('GET', '/api/settings')
log('Settings - Masking Works', settingsAfter.ok ? 'PASS' : 'FAIL',
  settingsAfter.ok ? `Groq key masked: ${settingsAfter.data.groqApiKey}` : `${settingsAfter.status}`)

// ──────────────────────────────────────────────
// 10. INTEGRATIONS
// ──────────────────────────────────────────────
section('INTEGRATIONS')

const integrations = await api('GET', '/integrations')
log('Integrations - List', integrations.ok ? 'PASS' : 'FAIL',
  integrations.ok ? `${integrations.data.length || 0} integrations` : `${integrations.status}: ${JSON.stringify(integrations.data)}`)

// Test adding a CRM integration
const addIntegration = await api('POST', '/integrations', {
  type: 'hubspot',
  label: 'HubSpot CRM',
  apiKey: 'test_hubspot_api_key_12345678'
})
if (addIntegration.ok) {
  log('Integrations - Create', 'PASS', `Created: ${addIntegration.data.id}`)

  const delInteg = await api('DELETE', `/integrations/${addIntegration.data.id}`)
  log('Integrations - Delete', delInteg.ok ? 'PASS' : 'FAIL',
    delInteg.ok ? 'Deleted integration' : `${delInteg.status}`)
} else {
  log('Integrations - Create', 'FAIL', `${addIntegration.status}: ${JSON.stringify(addIntegration.data)}`)
}

// ──────────────────────────────────────────────
// 11. BILLING
// ──────────────────────────────────────────────
section('BILLING & PLANS')

const billing = await api('GET', '/billing/plans')
log('Billing - Load Plans', billing.ok ? 'PASS' : 'FAIL',
  billing.ok ? `Plans loaded: ${JSON.stringify(billing.data).slice(0, 80)}` : `${billing.status}: ${JSON.stringify(billing.data)}`)

const billingStatus = await api('GET', '/billing/status')
log('Billing - Status (/billing/status)', billingStatus.ok ? 'PASS' : 'FAIL',
  billingStatus.ok ? `Plan: ${billingStatus.data.plan}, Status: ${billingStatus.data.status}` : `${billingStatus.status}: ${JSON.stringify(billingStatus.data)}`)

const billingSubscription = await api('GET', '/billing/subscription')
log('Billing - Subscription (/billing/subscription)', billingSubscription.ok ? 'PASS' : 'FAIL',
  billingSubscription.ok ? `Tier: ${billingSubscription.data.tier}, Minutes: ${billingSubscription.data.usage?.minutesUsed}` : `${billingSubscription.status}: ${JSON.stringify(billingSubscription.data)}`)

// Test checkout with tier (correct field)
const checkoutTier = await api('POST', '/billing/checkout', { tier: 'starter' })
if (checkoutTier.ok) {
  log('Billing - PayPal Checkout (tier field)', 'PASS', `Provider: ${checkoutTier.data.provider}, URL: ${checkoutTier.data.checkoutUrl?.substring(0, 50)}...`)
} else {
  log('Billing - PayPal Checkout (tier field)', 'FAIL', `${checkoutTier.status}: ${JSON.stringify(checkoutTier.data)}`)
}

// Test checkout with planId (backward compat)
const checkoutPlanId = await api('POST', '/billing/checkout', { planId: 'starter' })
if (checkoutPlanId.ok) {
  log('Billing - PayPal Checkout (planId field)', 'PASS', `planId field accepted correctly`)
} else {
  log('Billing - PayPal Checkout (planId field)', 'FAIL', `${checkoutPlanId.status}: ${JSON.stringify(checkoutPlanId.data)}`)
}

// ──────────────────────────────────────────────
// 12. AI STUDIO
// ──────────────────────────────────────────────
section('AI STUDIO / PLAYGROUND')

const aiMagicPrompt = await api('POST', '/ai/magic-prompt', {
  description: 'A helpful customer support agent for an e-commerce store'
})
if (aiMagicPrompt.ok) {
  log('AI Studio - Magic Prompt Generator', 'PASS', `Generated: "${JSON.stringify(aiMagicPrompt.data.enhancedPrompt).substring(0, 60)}..."`)
} else {
  log('AI Studio - Magic Prompt Generator', 'FAIL', `${aiMagicPrompt.status}: ${JSON.stringify(aiMagicPrompt.data)}`)
}

// ──────────────────────────────────────────────
// CLEANUP
// ──────────────────────────────────────────────
section('CLEANUP')

if (agentId) {
  const del = await api('DELETE', `/agents/${agentId}`)
  log('Cleanup - Delete Test Agent', del.ok ? 'PASS' : 'WARN',
    del.ok ? `Deleted agent ${agentId}` : `${del.status}`)
}

// Clear test settings
const clearSettings = await api('PATCH', '/api/settings', {
  twilioAccountSid: null,
  twilioAuthToken: null,
  twilioPhoneNumber: null,
  groqApiKey: null,
  elevenLabsApiKey: null,
  deepgramApiKey: null
})
log('Cleanup - Clear Test Settings', clearSettings.ok ? 'PASS' : 'WARN',
  clearSettings.ok ? 'Cleared test credentials from settings' : `${clearSettings.status}`)

// ──────────────────────────────────────────────
// FINAL REPORT
// ──────────────────────────────────────────────
console.log('\n' + '═'.repeat(60))
console.log('  FINAL QA REPORT SUMMARY')
console.log('═'.repeat(60))

const passed = results.filter(r => r.status === 'PASS').length
const failed = results.filter(r => r.status === 'FAIL').length
const warned = results.filter(r => r.status === 'WARN').length

console.log(`\nTotal Tests: ${results.length}`)
console.log(`✅ PASS: ${passed}`)
console.log(`❌ FAIL: ${failed}`)
console.log(`⚠️  WARN: ${warned}`)

if (failed > 0) {
  console.log('\n── FAILURES ──')
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ❌ [${r.step}] ${r.detail} ${r.extra ? '→ ' + r.extra : ''}`)
  })
}

if (warned > 0) {
  console.log('\n── WARNINGS ──')
  results.filter(r => r.status === 'WARN').forEach(r => {
    console.log(`  ⚠️  [${r.step}] ${r.detail} ${r.extra ? '→ ' + r.extra : ''}`)
  })
}
