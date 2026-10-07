import { PrismaClient, AuditLog, User } from '@prisma/client';
import { FastifyRequest } from 'fastify';

export interface AuditLogInput {
  organizationId: string;
  userId?: string;
  agentId?: string;
  apiKeyId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export class AuditService {
  constructor(private prisma: PrismaClient) {}

  async log(input: AuditLogInput): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        agentId: input.agentId,
        apiKeyId: input.apiKeyId,
        action: input.action,
        metadata: (input.metadata ?? {}) as any,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  }

  async logFromRequest(
    request: FastifyRequest,
    action: string,
    metadata?: Record<string, unknown>,
    overrides?: Partial<Pick<AuditLogInput, 'userId' | 'agentId' | 'apiKeyId'>>
  ): Promise<AuditLog> {
    const orgId = (request as any).organizationId;
    const userId = (request as any).user?.id;
    const apiKeyId = (request as any).apiKey?.id;

    return this.log({
      organizationId: orgId,
      userId: overrides?.userId ?? userId,
      agentId: overrides?.agentId,
      apiKeyId: overrides?.apiKeyId ?? apiKeyId,
      action,
      metadata,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  async getAuditLogs(
    organizationId: string,
    options: {
      page?: number;
      limit?: number;
      action?: string;
      userId?: string;
      startDate?: Date;
      endDate?: Date;
    } = {}
  ) {
    const { page = 1, limit = 20, action, userId, startDate, endDate } = options;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { organizationId };
    if (action) where.action = action;
    if (userId) where.userId = userId;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) (where.createdAt as Record<string, Date>).gte = startDate;
      if (endDate) (where.createdAt as Record<string, Date>).lte = endDate;
    }

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, email: true, name: true } },
          agent: { select: { id: true, name: true } },
          apiKey: { select: { id: true, name: true, keyPrefix: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}