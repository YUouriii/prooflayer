-- Remodel GmailAccount from agent-scoped to organization-scoped (table is empty)
-- DropForeignKey
ALTER TABLE "GmailAccount" DROP CONSTRAINT "GmailAccount_agentId_fkey";

-- DropIndex
DROP INDEX "GmailAccount_agentId_key";

-- AlterTable
ALTER TABLE "GmailAccount" DROP COLUMN "agentId",
DROP COLUMN "scope",
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'gmail',
ADD COLUMN     "scopes" TEXT[],
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'CONNECTED',
ALTER COLUMN "accessToken" DROP NOT NULL,
ALTER COLUMN "refreshToken" DROP NOT NULL,
ALTER COLUMN "expiresAt" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Verification" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE INDEX "GmailAccount_organizationId_idx" ON "GmailAccount"("organizationId");

-- CreateIndex
CREATE INDEX "GmailAccount_status_idx" ON "GmailAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_organizationId_email_key" ON "GmailAccount"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Verification_organizationId_idempotencyKey_key" ON "Verification"("organizationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
