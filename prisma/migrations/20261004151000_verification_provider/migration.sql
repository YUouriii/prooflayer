-- Persist the evidence provider on every verification so idempotency
-- comparison and API responses can distinguish providers.
-- AlterTable
ALTER TABLE "Verification" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'demo';

-- Backfill rows genuinely produced by the Gmail provider, identified via
-- their verification.create audit records. All other rows predate provider
-- selection and were produced by the demo provider (correct default).
UPDATE "Verification" v SET "provider" = 'gmail'
WHERE EXISTS (
  SELECT 1 FROM "AuditLog" a
  WHERE a.action = 'verification.create'
    AND a.metadata->>'verificationId' = v.id
    AND a.metadata->>'provider' = 'gmail'
);
