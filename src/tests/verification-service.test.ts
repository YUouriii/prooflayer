import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { VerificationService } from '../services/verification.js';
import { AuditService } from '../services/audit.js';
import type { EmailSentClaim } from '../verification/types.js';

const mockPrisma = {
  agent: {
    findFirst: vi.fn(),
  },
  verification: {
    create: vi.fn(),
    findFirst: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
} as unknown as PrismaClient;

const CLAIM: EmailSentClaim = {
  type: 'email_sent',
  recipient: 'john@example.com',
  subject: 'Invoice #4821',
  attachment: 'invoice.pdf',
};

describe('VerificationService', () => {
  let service: VerificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VerificationService(mockPrisma, new AuditService(mockPrisma));
  });

  function agentRow(org = 'org-1') {
    return { id: 'agent-1', name: 'A', organizationId: org, status: 'active' };
  }

  function mockCreate(status: string) {
    mockPrisma.verification.create.mockImplementation((args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      return Promise.resolve({
        id: 'ver-1',
        agentId: data.agentId,
        organizationId: data.organizationId,
        actionType: data.actionType,
        claim: data.claim,
        status: data.status,
        confidence: data.confidence,
        reason: data.reason,
        evidence: data.evidence,
        gmailMessageId: null,
        verifiedAt: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        _status: status,
      });
    });
    mockPrisma.auditLog.create.mockResolvedValue({});
  }

  it('VERIFIED claim persists record with org from context + audit', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(agentRow());
    mockCreate('VERIFIED');

    const result = await service.create({
      organizationId: 'org-1',
      userId: 'user-1',
      agentId: 'agent-1',
      claim: CLAIM,
    });

    expect(result.status).toBe('VERIFIED');
    expect(result.confidence).toBe(0.98);
    expect(result.organizationId).toBe('org-1');
    expect(result.agentId).toBe('agent-1');
    expect(result.evidence).toHaveLength(5);

    const created = mockPrisma.verification.create.mock.calls[0][0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(created.data.organizationId).toBe('org-1');
    expect(created.data.actionType).toBe('email_sent');
    expect(created.data.status).toBe('VERIFIED');

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'verification.create', organizationId: 'org-1' }),
      })
    );
  });

  it('FAILED claim is persisted and audited', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(agentRow());
    mockCreate('FAILED');

    const result = await service.create({
      organizationId: 'org-1',
      agentId: 'agent-1',
      claim: { ...CLAIM, recipient: 'jane@example.com' },
    });

    expect(result.status).toBe('FAILED');
    const logged = mockPrisma.auditLog.create.mock.calls[0][0] as unknown as {
      data: { metadata: Record<string, unknown> };
    };
    expect(logged.data.metadata.status).toBe('FAILED');
  });

  it('INCONCLUSIVE claim is persisted and audited', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(agentRow());
    mockCreate('INCONCLUSIVE');

    const result = await service.create({
      organizationId: 'org-1',
      agentId: 'agent-1',
      claim: { ...CLAIM, recipient: 'ghost@example.com' },
    });

    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.confidence).toBe(0.5);
  });

  it('unknown agent → AGENT_NOT_FOUND and nothing persisted', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    await expect(
      service.create({ organizationId: 'org-1', agentId: 'nope', claim: CLAIM })
    ).rejects.toThrow('AGENT_NOT_FOUND');
    expect(mockPrisma.verification.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('agent from another organization → AGENT_NOT_FOUND (isolation)', async () => {
    // findFirst is always scoped by (id, organizationId); a foreign agent resolves to null
    mockPrisma.agent.findFirst.mockImplementation((args: unknown) => {
      const where = (args as { where: { id: string; organizationId: string } }).where;
      if (where.id === 'agent-1' && where.organizationId === 'org-1') {
        return Promise.resolve(agentRow('org-1'));
      }
      return Promise.resolve(null);
    });

    await expect(
      service.create({ organizationId: 'org-2', agentId: 'agent-1', claim: CLAIM })
    ).rejects.toThrow('AGENT_NOT_FOUND');
    expect(mockPrisma.verification.create).not.toHaveBeenCalled();
  });

  it('unsupported claim type → UNSUPPORTED_CLAIM', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(agentRow());
    await expect(
      service.create({
        organizationId: 'org-1',
        agentId: 'agent-1',
        claim: { type: 'sms_sent' } as unknown as EmailSentClaim,
      })
    ).rejects.toThrow('UNSUPPORTED_CLAIM');
  });

  it('getById returns own-org verification, null for foreign org', async () => {
    const row = {
      id: 'ver-1',
      agentId: 'agent-1',
      organizationId: 'org-1',
      actionType: 'email_sent',
      claim: CLAIM,
      status: 'VERIFIED',
      confidence: 0.98,
      reason: 'All 5 required checks passed.',
      evidence: [],
      gmailMessageId: null,
      verifiedAt: new Date(),
      createdAt: new Date(),
    };
    mockPrisma.verification.findFirst.mockImplementation((args: unknown) => {
      const where = (args as { where: { id: string; organizationId: string } }).where;
      return Promise.resolve(where.organizationId === 'org-1' ? row : null);
    });

    const own = await service.getById('org-1', 'ver-1');
    expect(own?.id).toBe('ver-1');
    expect(own?.organizationId).toBe('org-1');

    const foreign = await service.getById('org-2', 'ver-1');
    expect(foreign).toBeNull();
  });

  it('audit metadata contains no secrets', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(agentRow());
    mockCreate('VERIFIED');

    await service.create({
      organizationId: 'org-1',
      userId: 'user-1',
      apiKeyId: 'key-1',
      agentId: 'agent-1',
      claim: CLAIM,
    });

    const logged = mockPrisma.auditLog.create.mock.calls[0][0] as unknown as {
      data: { metadata: Record<string, unknown> };
    };
    const blob = JSON.stringify(logged.data.metadata).toLowerCase();
    for (const secret of ['password', 'apikey', 'api_key', 'token', 'secret', 'session']) {
      expect(blob).not.toContain(secret);
    }
    expect(Object.keys(logged.data.metadata).sort()).toEqual(
      ['agentId', 'claimType', 'provider', 'reason', 'status', 'verificationId'].sort()
    );
  });
});
