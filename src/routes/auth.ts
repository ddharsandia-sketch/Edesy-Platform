import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma'
import { google } from 'googleapis'
import { requireAuth } from '../middleware/auth'
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

    let workspace = await prisma.workspace.findFirst({ where: { ownerId: data.user.id } })
    if (!workspace) {
      // Auto-create workspace if missing (fixes UI signup disconnect)
      const workspaceName = data.user.user_metadata?.workspace_name || `${email}'s Workspace`
      workspace = await prisma.workspace.create({
        data: { name: workspaceName, ownerId: data.user.id, plan: 'free' }
      })
    }

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

  // GET /auth/google?state=workspaceId
  app.get('/auth/google', async (request, reply) => {
    const { state } = request.query as { state?: string }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return reply.code(500).send({ error: 'Google OAuth not configured. GOOGLE_CLIENT_ID is missing.' })
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar.events'],
      prompt: 'consent',
      ...(state && { state }), // pass workspaceId through to callback
    });

    return reply.redirect(url);
  });

  // GET /auth/google/callback
  // In a real app we'd pass state (workspaceId) to Google and get it back, 
  // but to simplify, if the user logs in and gets redirected back we can update their workspace.
  // We'll require auth for this or assume state passed back has workspaceId.
  app.get('/auth/google/callback', async (request, reply) => {
    const { code, state } = request.query as { code: string, state?: string };

    if (!code) return reply.code(400).send({ error: 'No code provided' });

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const { tokens } = await oauth2Client.getToken(code);
    const { access_token, refresh_token } = tokens;

    // Ideally, state = workspaceId. If not, we would decode JWT from cookie or similar.
    // Assuming state is the workspaceId for this demo integration
    if (state) {
      await prisma.workspace.update({
        where: { id: state },
        data: {
          googleAccessToken:  access_token,
          googleRefreshToken: refresh_token ?? undefined,
          googleTokenExpiry:  new Date(Date.now() + 3600 * 1000), // 1 hour
        } as any,
      });

      // Also create integration record so frontend sees it
      const existing = await prisma.integration.findFirst({
        where: { workspaceId: state, type: 'google_calendar' },
      });
      if (!existing) {
        await prisma.integration.create({
          data: {
            workspaceId: state,
            type: 'google_calendar',
            label: 'Google Calendar',
            apiKey: 'oauth_token',
            enabled: true,
          }
        });
      }
    }

    // APP_FRONTEND_URL or FRONTEND_URL must be set in Railway env vars to:
    // https://voxpilot-app.vercel.app
    const frontendUrl = process.env.APP_FRONTEND_URL
      || process.env.FRONTEND_URL
      || 'https://voxpilot-app.vercel.app';
    return reply.redirect(`${frontendUrl}/dashboard/settings/integrations?google=success`);
  });
}

