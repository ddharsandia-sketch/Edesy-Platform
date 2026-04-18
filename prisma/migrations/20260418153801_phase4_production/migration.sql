/*
  Warnings:

  - A unique constraint covering the columns `[stripeCustomerId]` on the table `Workspace` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[stripeSubscriptionId]` on the table `Workspace` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `workspaceId` to the `PhoneNumber` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "PhoneNumber" DROP CONSTRAINT "PhoneNumber_agentId_fkey";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "handoffPhone" TEXT,
ADD COLUMN     "industry" TEXT NOT NULL DEFAULT 'general';

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "twilioCallSid" TEXT;

-- AlterTable
ALTER TABLE "PhoneNumber" ADD COLUMN     "workspaceId" TEXT NOT NULL,
ALTER COLUMN "provider" SET DEFAULT 'twilio',
ALTER COLUMN "region" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "planExpiresAt" TIMESTAMP(3),
ADD COLUMN     "planTier" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT;

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_stripeSubscriptionId_key" ON "Workspace"("stripeSubscriptionId");

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
