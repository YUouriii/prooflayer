import { Prisma, PrismaClient, Verification } from '@prisma/client';
import { AuditService } from './audit.js';
import type { EvidenceProvider } from '../verification/providers.js';
import { REQUIRED_EMAIL_SENT_CHECKS, evaluateEvidence } from '../verification/engine.js';
import type { Claim, EvidenceItem, VerificationResult, VerificationStatus } from '../verification/types.js';
import { VERIFICATION_STATUSES } from '../verification/types.js';
import { DEMO_PROVIDER_NAME, EvidenceProviderRegistry } from '../verification/registry.js';

export interface CreateVerificationInput {
  organizationId: string;
  userId?: string;
  apiKeyId?: string;
  agentId: string;
  claim: Claim;
  /** Evidence source. Defaults to the demo provider. */
  providerName?: string;
  /** Caller-supplied idempotency key, scoped to the organization. */
  idempotencyKey?: string;
  ipAddress?: string;
  userAgent?: string;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === 'string' && (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

function toResult(record: Verification, organizationId: string): VerificationResult {
  const status: VerificationStatus = isVerificationStatus(record.status) ? record.status : 'INCONCLUSIVE';
  return {
    id: record.id,
    organizationId,
    agentId: record.agentId,
    provider: record.provider,
    actionType: record.actionType,
    claim: record.claim as unknown as Claim,
    status,
    confidence: record.confidence,
    reason: record.reason ?? '',
    evidence: record.evidence as unknown as EvidenceItem[],
    createdAt: record.createdAt,
    verifiedAt: record.verifiedAt,
  };
}

/**
 * Verification orchestration.
 *
 * Organization is always taken from the authenticated context (never from
 * the client body) and the agent is resolved strictly inside that
 * organization — a client-supplied agentId from another org yields
 * AGENT_NOT_FOUND, never cross-org access.
 */
export class VerificationService {
  private readonly defaultProvider: EvidenceProvider | null;

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
    defaultProvider?: EvidenceProvider,
    private registry: EvidenceProviderRegistry = new EvidenceProviderRegistry()
  ) {
    this.defaultProvider = defaultProvider ?? null;
  }

  private resolveProvider(name: string | undefined): EvidenceProvider {
    if (!name || name === DEMO_PROVIDER_NAME) {
      if (this.defaultProvider) return this.defaultProvider;
      return this.registry.resolve(DEMO_PROVIDER_NAME);
    }
    return this.registry.resolve(name);
  }

  /**
   * Order-insensitive claim comparison. PostgreSQL jsonb normalizes object
   * key order on write, so naive JSON.stringify equality breaks across the
   * database round-trip. Canonicalize by sorting keys recursively.
   */
  private static canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => VerificationService.canonicalize(item));
    }
    if (value !== null && typeof value === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = VerificationService.canonicalize((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  }

  private static sameRequest(
    a: { agentId: string; claim: Claim; provider: string },
    b: { agentId: string; claim: Claim; provider: string }
  ): boolean {
    return (
      a.agentId === b.agentId &&
      a.provider === b.provider &&
      JSON.stringify(VerificationService.canonicalize(a.claim)) ===
        JSON.stringify(VerificationService.canonicalize(b.claim))
    );
  }

  private auditBase(input: CreateVerificationInput, agentId: string): {
    organizationId: string;
    userId: string | undefined;
    apiKeyId: string | undefined;
    agentId: string;
    ipAddress: string | undefined;
    userAgent: string | undefined;
  } {
    return {
      organizationId: input.organizationId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      agentId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    };
  }

  async create(input: CreateVerificationInput): Promise<VerificationResult & { replayed: boolean }> {
    const provider = this.resolveProvider(input.providerName);
    const providerName = provider.name;

    if (!provider.supports(input.claim)) {
      throw new Error('UNSUPPORTED_CLAIM');
    }

    if (input.idempotencyKey) {
      const existing = await this.prisma.verification.findFirst({
        where: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        const previous = {
          agentId: existing.agentId,
          claim: existing.claim as unknown as Claim,
          provider: existing.provider,
        };
        if (
          !VerificationService.sameRequest(previous, {
            agentId: input.agentId,
            claim: input.claim,
            provider: providerName,
          })
        ) {
          await this.auditConflict(input, existing.id);
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        await this.auditReplay(input, existing.id);
        return { ...toResult(existing, input.organizationId), replayed: true };
      }
    }

    const agent = await this.prisma.agent.findFirst({
      where: { id: input.agentId, organizationId: input.organizationId },
    });

    if (!agent) {
      throw new Error('AGENT_NOT_FOUND');
    }

    const evidence = await provider.collect(input.claim, { organizationId: input.organizationId });
    const outcome = evaluateEvidence(evidence, REQUIRED_EMAIL_SENT_CHECKS);

    let record: Verification;
    try {
      record = await this.prisma.verification.create({
        data: {
          agentId: agent.id,
          organizationId: input.organizationId,
          actionType: input.claim.type,
          claim: toJson(input.claim),
          status: outcome.status,
          confidence: outcome.confidence,
          reason: outcome.reason,
          evidence: toJson(evidence),
          idempotencyKey: input.idempotencyKey,
          provider: providerName,
        },
      });
    } catch (error) {
      // Lost a create race under the same idempotency key: the winner's
      // row is authoritative — replay it (or reject on conflict).
      if (
        input.idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.verification.findFirst({
          where: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey },
        });
        if (winner) {
          const previous = {
            agentId: winner.agentId,
            claim: winner.claim as unknown as Claim,
            provider: winner.provider,
          };
          if (
            !VerificationService.sameRequest(previous, {
              agentId: input.agentId,
              claim: input.claim,
              provider: providerName,
            })
          ) {
            await this.auditConflict(input, winner.id);
            throw new Error('IDEMPOTENCY_CONFLICT');
          }
          await this.auditReplay(input, winner.id);
          return { ...toResult(winner, input.organizationId), replayed: true };
        }
      }
      throw error;
    }

    // Audit metadata carries only identifiers + verdict. Never include
    // passwords, API keys, session tokens, or provider secrets here.
    await this.auditService.log({
      organizationId: input.organizationId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      agentId: agent.id,
      action: 'verification.create',
      metadata: {
        verificationId: record.id,
        agentId: agent.id,
        status: outcome.status,
        claimType: input.claim.type,
        provider: providerName,
        reason: outcome.reason,
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return { ...toResult(record, input.organizationId), replayed: false };
  }

  private async auditReplay(input: CreateVerificationInput, verificationId: string): Promise<void> {
    await this.auditService.log({
      ...this.auditBase(input, input.agentId),
      action: 'verification.replay',
      metadata: {
        verificationId,
        idempotencyKey: input.idempotencyKey,
        provider: input.providerName ?? DEMO_PROVIDER_NAME,
      },
    });
  }

  private async auditConflict(input: CreateVerificationInput, verificationId: string): Promise<void> {
    await this.auditService.log({
      ...this.auditBase(input, input.agentId),
      action: 'verification.idempotency_conflict',
      metadata: {
        verificationId,
        idempotencyKey: input.idempotencyKey,
        provider: input.providerName ?? DEMO_PROVIDER_NAME,
        reason: 'idempotency key already used for a different request',
      },
    });
  }

  async getById(organizationId: string, verificationId: string): Promise<VerificationResult | null> {
    const record = await this.prisma.verification.findFirst({
      where: { id: verificationId, organizationId },
    });
    return record ? toResult(record, organizationId) : null;
  }
}

