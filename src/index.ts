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
import dotenv from 'dotenv'
import { authRoutes } from './routes/auth'
import { agentRoutes } from './routes/agents'
import { callRoutes } from './routes/calls'
import { knowledgeRoutes } from './routes/knowledge'
import { webhookRoutes } from './routes/webhooks'
import { billingRoutes } from './routes/billing'
import { campaignRoutes } from './routes/campaigns'

dotenv.config({ path: '../../.env' })

const app = Fastify({ logger: true })

// FIX 1: Register raw body BEFORE any routes — required for Stripe webhook signature verification
// global: false means only routes with config: { rawBody: true } capture the raw buffer
await app.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: false,  // Keep as Buffer — Stripe needs Buffer, not string
  runFirst: true,   // Must run before Fastify's JSON body parser
})

app.register(cors, { origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000', credentials: true })
app.register(jwt, { secret: process.env.JWT_SECRET! })
app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }) // 50MB max

// Register all routes
app.register(authRoutes)
app.register(agentRoutes)
app.register(callRoutes)
app.register(knowledgeRoutes)
app.register(billingRoutes)
app.register(campaignRoutes)

// Webhooks: Stripe needs rawBody, Twilio needs no parsing — register last
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
    await app.listen({ port: 3001, host: '0.0.0.0' })
    console.log('API running on port 3001')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
start()
