import 'dotenv/config'
import path from 'node:path'
import { defineConfig } from 'prisma/config'
import { PrismaPg } from '@prisma/adapter-pg'

export default defineConfig({
  earlyAccess: true,
  schema: path.join(__dirname, 'prisma/schema.prisma'),
  datasource: {
    url: process.env.DATABASE_URL || "",
  },
  migrate: {
    adapter: async () => {
      const { Pool } = await import('pg')
      const pool = new Pool({ connectionString: process.env.DATABASE_URL })
      return new PrismaPg(pool)
    }
  }
})
