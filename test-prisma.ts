import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const w = await prisma.workspace.findFirst()
  if (!w) {
    console.log("No workspace")
    return
  }
  console.log("Found workspace", w.id)
  
  try {
    await prisma.workspace.update({
      where: { id: w.id },
      data: {
        groqApiKey: "gsk_test123"
      }
    })
    console.log("Update success")
  } catch (err: any) {
    console.error("Update failed:", err.message)
  }
}
main()
