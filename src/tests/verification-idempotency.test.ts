import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { VerificationService } from '../services/verification.js';
import { AuditService } from '../services/audit.js';
import type { EmailSentClaim } from '../verification/types.js';
import { EvidenceProviderRegistry } from '../verification/registry.js';
import { DemoEvidenceProvider } from '../verification/providers.js';
import { testPrisma } from './gmail-fakes.js';

const CLAIM: EmailSentClaim = {
  type: 'email_sent',
  recipient: 'john@example.com',
  subject: 'Invoice #4821',
  attachment: 'invoice.pdf',
};

function verificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ver-1',
    agentId: 'agent-1',
    organizationId: 'org-1',
    actionType: 'email_sent',
    claim: { ...CLAIM },
    status: 'VERIFIED',
    confidence: 0.98,
    provider: 'demo',
    reason: 'All 5 required checks passed.',
    evidence: [],
    gmailMessageId: null,
    idempotencyKey: 'key-1',
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('verification idempotency', () => {
  let prisma: PrismaClient;
  let service: VerificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = testPrisma();
    const registry = new EvidenceProviderRegistry();
    // Stand-in second provider named 'gmail' (evidence behavior irrelevant here).
    class StubGmailProvider extends DemoEvidenceProvider {
      override readonly name = 'gmail';
    }
    registry.register('gmail', () => new StubGmailProvider());
    service = new VerificationService(prisma, new AuditService(prisma), undefined, registry);
    prisma.agent.findFirst.mockResolvedValue({ id: 'agent-1', organizationId: 'org-1' });
    prisma.verification.findFirst.mockResolvedValue(null);
    prisma.verification.create.mockImplementation((args: unknown) =>
      Promise.resolve(verificationRow((args as { data: Record<string, unknown> }).data))
    );
    prisma.auditLog.create.mockResolvedValue({});
  });

  it('stores the idempotency key on create', async () => {
    await service.create({ organizationId: 'org-1', agentId: 'agent-1', claim: CLAIM, idempotencyKey: 'key-1' });
    const args = prisma.verification.create.mock.calls[0][0] as unknown as { data: Record<string, unknown> };
    expect(args.data.idempotencyKey).toBe('key-1');
  });

  it('identical repeat returns the original record without new work', async () => {
    const existing = verificationRow();
    prisma.verification.findFirst.mockResolvedValueOnce(existing);

    const result = await service.create({ organizationId: 'org-1', agentId: 'agent-1', claim: CLAIM, idempotencyKey: 'key-1' });

    expect(result.id).toBe('ver-1');
    expect(result.replayed).toBe(true);
    expect(prisma.verification.create).not.toHaveBeenCalled();
    const actions = prisma.auditLog.create.mock.calls.map(
      (c) => ((c[0] as unknown as { data: { action: string } }).data.action)
    );
    expect(actions).toEqual(['verification.replay']);
  });

  it('replay matches despite reordered claim keys (jsonb normalization)', async () => {
    const stored = verificationRow();
    stored.claim = { type: 'email_sent', subject: 'Invoice #4821', recipient: 'john@example.com', attachment: 'invoice.pdf' };
    prisma.verification.findFirst.mockResolvedValueOnce(stored);

    const result = await service.create({
      organizationId: 'org-1',
      agentId: 'agent-1',
      claim: { attachment: 'invoice.pdf', recipient: 'john@example.com', subject: 'Invoice #4821', type: 'email_sent' },
      idempotencyKey: 'key-1',
    });

    expect(result.id).toBe('ver-1');
    expect(result.replayed).toBe(true);
  });

  it('conflicting reuse of the same key → IDEMPOTENCY_CONFLICT', async () => {
    prisma.verification.findFirst.mockResolvedValueOnce(verificationRow());

    await expect(
      service.create({
        organizationId: 'org-1',
        agentId: 'agent-1',
        claim: { ...CLAIM, subject: 'Different' },
        idempotencyKey: 'key-1',
      })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('same key in another organization is independent', async () => {
    prisma.agent.findFirst.mockImplementation((args: unknown) => {
      const where = (args as { where: { organizationId: string } }).where;
      return Promise.resolve(where.organizationId === 'org-2' ? { id: 'agent-9', organizationId: 'org-2' } : null);
    });

    const result = await service.create({ organizationId: 'org-2', agentId: 'agent-9', claim: CLAIM, idempotencyKey: 'key-1' });

    expect(result.replayed).toBe(false);
    expect(prisma.verification.create).toHaveBeenCalled();
  });

  it('requests without a key create normally', async () => {
    const result = await service.create({ organizationId: 'org-1', agentId: 'agent-1', claim: CLAIM });
    expect(result.replayed).toBe(false);
    const data = prisma.verification.create.mock.calls[0][0] as unknown as { data: Record<string, unknown> };
    expect(data.idempotencyKey).toBeUndefined();
  });

  it('unique-constraint race replays the winner', async () => {
    const winner = verificationRow();
    prisma.verification.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
    );
    prisma.verification.findFirst.mockResolvedValueOnce(winner);

    const result = await service.create({ organizationId: 'org-1', agentId: 'agent-1', claim: CLAIM, idempotencyKey: 'key-1' });

    expect(result.id).toBe('ver-1');
    expect(result.replayed).toBe(true);
  });

  it('same key + different provider → IDEMPOTENCY_CONFLICT', async () => {
    prisma.verification.findFirst.mockResolvedValueOnce(verificationRow({ provider: 'demo' }));

    await expect(
      service.create({
        organizationId: 'org-1',
        agentId: 'agent-1',
        claim: CLAIM,
        providerName: 'gmail',
        idempotencyKey: 'key-1',
      })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('replay and conflict are audited without secrets', async () => {
    const existing = verificationRow();
    prisma.verification.findFirst.mockResolvedValue(existing);

    await service.create({ organizationId: 'org-1', agentId: 'agent-1', claim: CLAIM, idempotencyKey: 'key-1' });
    await expect(
      service.create({
        organizationId: 'org-1',
        agentId: 'agent-1',
        claim: { ...CLAIM, subject: 'Other' },
        idempotencyKey: 'key-1',
      })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');

    const actions = prisma.auditLog.create.mock.calls.map(
      (c) => ((c[0] as unknown as { data: { action: string } }).data.action)
    );
    expect(actions).toContain('verification.replay');
    expect(actions).toContain('verification.idempotency_conflict');
    const blob = JSON.stringify(prisma.auditLog.create.mock.calls).toLowerCase();
    for (const secret of ['password', 'apikey', 'api_key', 'token', 'secret', 'session']) {
      expect(blob).not.toContain(secret);
    }
  });

  it('unknown provider name → UNKNOWN_PROVIDER', async () => {
    await expect(
      service.create({ organizationId: 'org-1', agentId: 'agent-1', claim: CLAIM, providerName: 'nope' })
    ).rejects.toThrow('UNKNOWN_PROVIDER');
  });
});
