import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

// Singleton pattern — prevents connection pool exhaustion on hot reload
declare global {
  var __prisma: PrismaClient | undefined
}

function createPrismaClient() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // ── Neon-optimized pool settings ───────────────────────────────────────
    max: 10,                   // Max 10 connections (Neon free tier allows 20)
    min: 0,                    // Allow pool to drain completely when idle
    idleTimeoutMillis: 10000,  // Release idle connections after 10s
                               // Neon closes them after 5min — 10s is safely under that
    connectionTimeoutMillis: 10000, // Fail fast if can't connect in 10s
    // ── SSL — required for Neon in all environments ────────────────────────
    ssl: process.env.DATABASE_URL?.includes('neon.tech') || process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  })

  // Log pool errors — silent by default and very hard to debug otherwise
  pool.on('error', (err) => {
    console.error('[PRISMA POOL] Unexpected error on idle client:', err.message)
  })

  if (process.env.NODE_ENV !== 'production') {
    pool.on('connect', () => console.log('[PRISMA POOL] New connection established'))
  }

  const adapter = new PrismaPg(pool)
  return new PrismaClient({
    adapter: adapter as any,
    log: process.env.NODE_ENV === 'development'
      ? ['warn', 'error']
      : ['error'],
  })
}

export const prisma: PrismaClient =
  global.__prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma
}
