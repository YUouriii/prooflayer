/*
  Warnings:

  - Added the required column `organizationId` to the `Verification` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Verification" ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "reason" TEXT;

-- CreateIndex
CREATE INDEX "Verification_organizationId_idx" ON "Verification"("organizationId");

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
