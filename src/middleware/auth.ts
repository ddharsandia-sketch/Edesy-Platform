import { FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../lib/prisma'
import jwt from 'jsonwebtoken'

interface SupabaseJWTPayload {
  sub:   string   // Supabase user UUID
  email: string
  role:  string
  exp:   number
  iat:   number
}

export async function requireAuth(
  request: FastifyRequest,
  reply:   FastifyReply
): Promise<void> {
  try {
    // 1. Extract token from Authorization header
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing Authorization header' })
    }
    const token = authHeader.slice(7)

    // 2. Verify JWT locally using Supabase JWT secret — NO network call, never times out
    const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET
    if (!SUPABASE_JWT_SECRET) {
      console.error('[requireAuth] SUPABASE_JWT_SECRET not set in Railway env vars!')
      return reply.code(500).send({ error: 'Server auth misconfigured. Contact support.' })
    }

    let payload: SupabaseJWTPayload
    try {
      payload = jwt.verify(token, SUPABASE_JWT_SECRET) as SupabaseJWTPayload
    } catch (jwtErr: any) {
      if (jwtErr.name === 'TokenExpiredError') {
        return reply.code(401).send({ error: 'Token expired. Please refresh the page and try again.' })
      }
      return reply.code(401).send({ error: 'Invalid token' })
    }

    const userId = payload.sub
    if (!userId) {
      return reply.code(401).send({ error: 'Invalid token payload — no user ID' })
    }

    // 3. Get or create workspace for this user (cached after first request)
    let workspace = await prisma.workspace.findFirst({
      where: { ownerId: userId },
      select: { id: true, planTier: true },
    })

    // Auto-create workspace on first login (no more "workspace not found" errors)
    if (!workspace) {
      workspace = await prisma.workspace.create({
        data: {
          ownerId: userId,
          name:    payload.email?.split('@')[0] ?? 'My Workspace',
          planTier: 'free',
        },
        select: { id: true, planTier: true },
      })
      console.log(`[requireAuth] Auto-created workspace for user ${userId}`)
    }

    // 4. Attach to request — available as request.user in all routes
    request.user = {
      id:          userId,
      email:       payload.email,
      workspaceId: workspace.id,
      planTier:    workspace.planTier ?? 'free',
    }
  } catch (err: any) {
    console.error('[requireAuth] Unexpected error:', err.message)
    return reply.code(500).send({ error: 'Auth error. Please try again.' })
  }
}
