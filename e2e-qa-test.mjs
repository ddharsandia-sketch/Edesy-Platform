import fs from 'fs'

const API_URL = 'https://edesyapi-production.up.railway.app'
const EMAIL = 'iamjabirul@gmail.com'
const PASSWORD = '1234567'

async function log(step, success, msg) {
  const symbol = success ? '✅' : '❌'
  console.log(`${symbol} [${step}] ${msg}`)
}

async function runTests() {
  console.log('--- STARTING QA TEST SUITE ---\n')
  
  let token = ''
  let workspaceId = ''
  let agentId = ''

  // 1. Auth Login
  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD })
    })
    
    if (res.ok) {
      const data = await res.json()
      token = data.token
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
      workspaceId = payload.workspaceId
      log('Auth', true, `Logged in successfully. Workspace ID: ${workspaceId}`)
    } else {
      const err = await res.text()
      log('Auth', false, `Login failed: ${res.status} ${err}`)
      return
    }
  } catch (err) {
    log('Auth', false, `Login crash: ${err.message}`)
    return
  }

  const apiCall = async (method, path, body = null) => {
    const options = {
      method,
      headers: { 'Authorization': `Bearer ${token}` }
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
    return fetch(`${API_URL}${path}`, options)
  }

  // 2. Fetch Agents
  try {
    const res = await apiCall('GET', '/agents')
    if (res.ok) {
      const data = await res.json()
      log('Fetch Agents', true, `Fetched ${data.length} agents.`)
    } else {
      log('Fetch Agents', false, `Failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    log('Fetch Agents', false, err.message)
  }

  // 3. Create Agent
  try {
    const res = await apiCall('POST', '/agents', {
      name: 'QA Test Agent ' + Date.now(),
      personaPrompt: 'You are a highly efficient QA testing robot, designed to test system boundaries.',
      language: 'en',
      voiceId: '21m00Tcm4TlvDq8ikWAM',
      voiceProvider: 'elevenlabs',
      tierId: 'efficient',
      industry: 'general',
      useCaseId: 'support'
    })
    if (res.ok) {
      const data = await res.json()
      agentId = data.id
      log('Create Agent', true, `Created agent ${agentId} successfully.`)
    } else {
      log('Create Agent', false, `Failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    log('Create Agent', false, err.message)
  }

  if (!agentId) return

  // 4. Update Agent (PATCH)
  try {
    const res = await apiCall('PATCH', `/agents/${agentId}`, {
      tierId: 'premium',
      useCaseId: 'sales'
    })
    if (res.ok) {
      log('Update Agent', true, `Updated agent tier to premium.`)
    } else {
      log('Update Agent', false, `Failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    log('Update Agent', false, err.message)
  }

  // 5. Test Settings Update
  try {
    const res = await apiCall('PATCH', '/settings', {
      groqApiKey: 'dummy_key_for_testing'
    })
    if (res.ok) {
      log('Settings', true, `Updated Groq API key in workspace settings.`)
    } else {
      log('Settings', false, `Failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    log('Settings', false, err.message)
  }

  // 6. Test Knowledge Base
  try {
    const res = await apiCall('GET', `/knowledge/agent/${agentId}`)
    if (res.ok) {
      log('Knowledge Base', true, `Fetched knowledge base records.`)
    } else {
      log('Knowledge Base', false, `Failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    log('Knowledge Base', false, err.message)
  }

  // 7. Delete Agent
  try {
    const res = await apiCall('DELETE', `/agents/${agentId}`)
    if (res.ok) {
      log('Delete Agent', true, `Deleted agent ${agentId} successfully.`)
    } else {
      log('Delete Agent', false, `Failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    log('Delete Agent', false, err.message)
  }

  console.log('\n--- QA TEST SUITE COMPLETED ---')
}

runTests()
