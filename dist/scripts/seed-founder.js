"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prisma_1 = require("../lib/prisma");
async function main() {
    const ownerId = 'e83accd0-102b-4369-b3f4-75a98d4ee555';
    let workspace = await prisma_1.prisma.workspace.findFirst({
        where: { ownerId }
    });
    if (workspace) {
        workspace = await prisma_1.prisma.workspace.update({
            where: { id: workspace.id },
            data: {
                plan: 'enterprise',
                planTier: 'enterprise',
                onboardingComplete: true
            }
        });
    }
    else {
        workspace = await prisma_1.prisma.workspace.create({
            data: {
                name: 'VoxPilot Enterprise',
                ownerId: ownerId,
                plan: 'enterprise',
                planTier: 'enterprise',
                onboardingComplete: true,
                providerCredentials: {
                    create: {
                        activeLlm: 'openai',
                        activeTel: 'twilio'
                    }
                }
            }
        });
    }
    console.log('Founder workspace created/updated:', workspace);
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma_1.prisma.$disconnect();
});
