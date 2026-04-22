import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma'

const SUPABASE_URL = process.env.SUPABASE_URL || ''

// Local dev mode when Supabase credentials are placeholders
const isLocalDevMode =
  !SUPABASE_URL || SUPABASE_URL.includes('YOUR_PROJECT') || !SUPABASE_URL.startsWith('https://')

export async function authRoutes(app: FastifyInstance) {

  // POST /auth/register
  app.post('/auth/register', async (request, reply) => {
    const { email, password, workspaceName } = request.body as {
      email: string
      password: string
      workspaceName: string
    }

    let userId: string

    if (isLocalDevMode) {
      // LOCAL DEV: Skip Supabase, generate a UUID as userId
      userId = randomUUID()
      console.log('[LOCAL DEV] Bypassing Supabase — generated userId:', userId)
    } else {
      // PRODUCTION: Create user in Supabase Auth
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      })
      if (authError) return reply.code(400).send({ error: authError.message })
      userId = authData.user.id
    }

    // Idempotent: find or create workspace for this user
    const existingWorkspace = await prisma.workspace.findFirst({
      where: { ownerId: userId }
    })

    const workspace =
      existingWorkspace ??
      (await prisma.workspace.create({
        data: { name: workspaceName, ownerId: userId, plan: 'free' }
      }))

    const token = app.jwt.sign(
      { userId, workspaceId: workspace.id, email },
      { expiresIn: '7d' }
    )

    return reply.send({ token, workspaceId: workspace.id })
  })

  // POST /auth/login
  app.post('/auth/login', async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string }

    if (isLocalDevMode) {
      // LOCAL DEV: Return token for the first existing workspace
      const workspace = await prisma.workspace.findFirst()
      if (!workspace)
        return reply.code(404).send({ error: 'No workspace found. Register first.' })

      const token = app.jwt.sign(
        { userId: workspace.ownerId, workspaceId: workspace.id, email },
        { expiresIn: '7d' }
      )
      return reply.send({ token, workspaceId: workspace.id })
    }

    // PRODUCTION: Verify via Supabase
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return reply.code(401).send({ error: 'Invalid credentials' })

    const workspace = await prisma.workspace.findFirst({ where: { ownerId: data.user.id } })
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' })

    const isFounder = email === 'jabir.islam@gau.edu.ge'
    if (isFounder && workspace.plan !== 'enterprise') {
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { plan: 'enterprise', planTier: 'enterprise', onboardingComplete: true }
      })
    }

    const token = app.jwt.sign(
      { userId: data.user.id, workspaceId: workspace.id, email },
      { expiresIn: '7d' }
    )
    return reply.send({ token, workspaceId: workspace.id })
  })
}
