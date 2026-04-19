import Redis from 'ioredis'

// Singleton pattern to prevent exhaust connection pool on hot-reloads
declare global {
  var __redis: Redis | undefined
  var __redisPubSub: Redis | undefined
}

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is strictly required for the API service.")
}

export const redis = global.__redis ?? new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
})

// Used for SSE subscriptions without blocking the main client
export function getPubSub() {
  if (!global.__redisPubSub) {
    global.__redisPubSub = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 3,
    })
  }
  return global.__redisPubSub
}

if (process.env.NODE_ENV !== 'production') {
  global.__redis = redis
}
