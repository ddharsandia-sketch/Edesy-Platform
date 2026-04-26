import dotenv from 'dotenv'
dotenv.config({ path: '../../.env' })

// Validate environment variables before anything else
import './lib/env'

import * as Sentry from '@sentry/node'

// Initialize Sentry before everything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  })
  console.log('[SENTRY] Error tracking initialized')
}

import Fastify from 'fastify'
import rawBody from 'fastify-raw-body'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { authRoutes } from './routes/auth'
import { agentRoutes } from './routes/agents'
import { callRoutes } from './routes/calls'
import { knowledgeRoutes } from './routes/knowledge'
import { webhookRoutes } from './routes/webhooks'
import { billingRoutes } from './routes/billing'
import { campaignRoutes } from './routes/campaigns'
import { settingsRoutes } from './routes/settings'
import { aiRoutes } from './routes/ai'
import { integrationRoutes } from './routes/integrations'
const app = Fastify({ logger: true })

// FIX 1: Register raw body BEFORE any routes — required for Stripe webhook signature verification
// global: false means only routes with config: { rawBody: true } capture the raw buffer
// FIX 1: Register raw body BEFORE any routes — required for Stripe/PayPal signature verification
app.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: false,
  runFirst: true,
})

app.register(cors, {
  origin: (origin, cb) => {
    // Allow local development, any vercel deployment, or explicitly allowed origins
    if (!origin || origin.startsWith('http://localhost') || origin.endsWith('.vercel.app')) {
      return cb(null, true)
    }
    const allowed = process.env.ALLOWED_ORIGINS?.split(',') || []
    if (allowed.includes(origin)) return cb(null, true)
    
    cb(new Error('Not allowed by CORS'), false)
  },
  credentials: true
})
app.register(jwt, { secret: process.env.JWT_SECRET! })
app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }) // 50MB max

// Rate limiting - 100 requests per minute per IP
app.register(rateLimit, {
  max: 100,
  timeWindow: 60000,
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: () => ({
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please try again later.'
  })
})

// Register all routes
app.register(authRoutes)
app.register(agentRoutes)
app.register(callRoutes)
app.register(knowledgeRoutes)
app.register(billingRoutes)
app.register(campaignRoutes)
app.register(settingsRoutes)
app.register(aiRoutes, { prefix: '/ai' })
app.register(integrationRoutes)

// Webhooks: PayPal + Twilio need rawBody — register last
app.register(webhookRoutes)

app.get('/health', async () => ({ status: 'ok' }))

// Start BullMQ post-call worker
import { postCallWorker } from './jobs/post-call'
import { campaignWorker } from './jobs/campaign-dialer'

postCallWorker.on('completed', job => console.log(`[BULLMQ] Post-call job ${job.id} completed`))
postCallWorker.on('failed', (job, err) => console.error(`[BULLMQ] Post-call job ${job?.id} failed:`, err.message))

campaignWorker.on('completed', job => console.log(`[BULLMQ] Campaign job ${job.id} done`))
campaignWorker.on('failed', (job, err) => console.error(`[BULLMQ] Campaign job ${job?.id} failed:`, err.message))

console.log('[BULLMQ] Post-call + Campaign workers started')

const start = async () => {
  try {
    await app.listen({ port: process.env.PORT ? parseInt(process.env.PORT) : 3001, host: '0.0.0.0' })
    console.log(`API running on port ${process.env.PORT || 3001}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
start()

// Keep Railway services warm — ping worker every 4 minutes
// Railway sleeps after 5 min of inactivity on hobby plan
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const url = getWorkerUrl()
      await fetch(`${url}/health`)
    } catch { /* Silent — non-critical */ }
  }, 4 * 60 * 1000)  // Every 4 minutes
}
