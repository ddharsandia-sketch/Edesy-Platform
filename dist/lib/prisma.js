"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = require("pg");
function createPrismaClient() {
    const pool = new pg_1.Pool({
        connectionString: process.env.DATABASE_URL,
        // ── Neon-optimized pool settings ───────────────────────────────────────
        max: 10, // Max 10 connections (Neon free tier allows 20)
        min: 0, // Allow pool to drain completely when idle
        idleTimeoutMillis: 10000, // Release idle connections after 10s
        // Neon closes them after 5min — 10s is safely under that
        connectionTimeoutMillis: 10000, // Fail fast if can't connect in 10s
        // ── SSL — required for Neon in all environments ────────────────────────
        ssl: process.env.DATABASE_URL?.includes('neon.tech') || process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
    });
    // Log pool errors — silent by default and very hard to debug otherwise
    pool.on('error', (err) => {
        console.error('[PRISMA POOL] Unexpected error on idle client:', err.message);
    });
    if (process.env.NODE_ENV !== 'production') {
        pool.on('connect', () => console.log('[PRISMA POOL] New connection established'));
    }
    const adapter = new adapter_pg_1.PrismaPg(pool);
    return new client_1.PrismaClient({
        adapter: adapter,
        log: process.env.NODE_ENV === 'development'
            ? ['warn', 'error']
            : ['error'],
    });
}
exports.prisma = global.__prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== 'production') {
    global.__prisma = exports.prisma;
}
