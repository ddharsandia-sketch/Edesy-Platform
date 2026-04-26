import Fastify from 'fastify'
import { prisma } from './lib/prisma.js'

const app = Fastify()
app.patch("/settings", async (req, reply) => {
  try {
    const workspaceId = "test-workspace" // mock
    const body = req.body
    
    const ALLOWED = [
      "groqApiKey", "cerebrasApiKey", "geminiApiKey",
      "openaiApiKey", "anthropicApiKey",
      "sarvamApiKey", "deepgramApiKey",
      "elevenLabsApiKey", "cartesiaApiKey",
    ]

    const data = {}
    for (const key of ALLOWED) {
      const val = body[key]
      if (val === undefined) continue
      const isMasked = typeof val === "string" && val.includes("\u2022")
      if (isMasked) continue
      data[key] = (val === "" || val === null) ? null : val
    }
    
    console.log("Data:", data)
    return { success: true }
  } catch (err) {
    return reply.status(500).send({ error: err.message })
  }
})
app.listen({ port: 3001 })
