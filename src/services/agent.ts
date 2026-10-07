import { PrismaClient, Agent } from '@prisma/client';
import { AuditService } from './audit.js';

export interface CreateAgentInput {
  organizationId: string;
  userId: string;
  name: string;
  description?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface UpdateAgentInput {
  organizationId: string;
  userId: string;
  agentId: string;
  name?: string;
  description?: string;
  status?: 'active' | 'inactive';
  ipAddress?: string;
  userAgent?: string;
}

export class AgentService {
  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService
  ) {}

  async create(input: CreateAgentInput): Promise<Agent> {
    const agent = await this.prisma.agent.create({
      data: {
        name: input.name,
        description: input.description,
        organizationId: input.organizationId,
        status: 'active',
      },
    });

    await this.auditService.log({
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: agent.id,
      action: 'agent.create',
      metadata: { name: input.name, description: input.description },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return agent;
  }

  async getById(organizationId: string, agentId: string): Promise<Agent | null> {
    return this.prisma.agent.findFirst({
      where: { id: agentId, organizationId },
    });
  }

  async getAll(organizationId: string, options: { page?: number; limit?: number } = {}): Promise<{ data: Agent[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.agent.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.agent.count({ where: { organizationId } }),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async update(input: UpdateAgentInput): Promise<Agent> {
    const existing = await this.prisma.agent.findFirst({
      where: { id: input.agentId, organizationId: input.organizationId },
    });

    if (!existing) {
      throw new Error('AGENT_NOT_FOUND');
    }

    const agent = await this.prisma.agent.update({
      where: { id: input.agentId },
      data: {
        name: input.name ?? existing.name,
        description: input.description ?? existing.description,
        status: input.status ?? existing.status,
      },
    });

    await this.auditService.log({
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: input.agentId,
      action: 'agent.update',
      metadata: {
        name: input.name,
        description: input.description,
        status: input.status,
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return agent;
  }

  async delete(organizationId: string, userId: string, agentId: string, ipAddress?: string, userAgent?: string): Promise<void> {
    const existing = await this.prisma.agent.findFirst({
      where: { id: agentId, organizationId },
    });

    if (!existing) {
      throw new Error('AGENT_NOT_FOUND');
    }

    // Audit BEFORE delete: AuditLog.agentId is a FK to Agent, so logging
    // after the delete violates referential integrity (P2003).
    await this.auditService.log({
      organizationId,
      userId,
      agentId,
      action: 'agent.delete',
      metadata: { name: existing.name },
      ipAddress,
      userAgent,
    });

    await this.prisma.agent.delete({ where: { id: agentId } });
  }
}