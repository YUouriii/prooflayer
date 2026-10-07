import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AgentService } from '../services/agent.js';
import { AuditService } from '../services/audit.js';

const mockPrisma = {
  agent: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
} as unknown as PrismaClient;

describe('AgentService', () => {
  let agentService: AgentService;
  let auditService: AuditService;

  beforeEach(() => {
    vi.clearAllMocks();
    auditService = new AuditService(mockPrisma);
    agentService = new AgentService(mockPrisma, auditService);
  });

  describe('create', () => {
    it('should create agent and log audit', async () => {
      mockPrisma.agent.create.mockResolvedValue({
        id: 'agent-1',
        name: 'Test Agent',
        description: 'Test Description',
        status: 'active',
        organizationId: 'org-1',
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const agent = await agentService.create({
        organizationId: 'org-1',
        userId: 'user-1',
        name: 'Test Agent',
        description: 'Test Description',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      });

      expect(agent.name).toBe('Test Agent');
      expect(agent.organizationId).toBe('org-1');
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'agent.create',
            organizationId: 'org-1',
            userId: 'user-1',
          }),
        })
      );
    });
  });

  describe('getById', () => {
    it('should return agent if found in organization', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue({
        id: 'agent-1',
        name: 'Test Agent',
        organizationId: 'org-1',
      });

      const agent = await agentService.getById('org-1', 'agent-1');
      expect(agent).not.toBeNull();
      expect(agent!.id).toBe('agent-1');
    });

    it('should return null if agent not in organization', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(null);

      const agent = await agentService.getById('org-1', 'agent-2');
      expect(agent).toBeNull();
    });
  });

  describe('update', () => {
    it('should update agent and log audit', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue({
        id: 'agent-1',
        name: 'Old Name',
        description: 'Old Description',
        status: 'active',
        organizationId: 'org-1',
      });
      mockPrisma.agent.update.mockResolvedValue({
        id: 'agent-1',
        name: 'New Name',
        description: 'New Description',
        status: 'inactive',
        organizationId: 'org-1',
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const agent = await agentService.update({
        organizationId: 'org-1',
        userId: 'user-1',
        agentId: 'agent-1',
        name: 'New Name',
        description: 'New Description',
        status: 'inactive',
      });

      expect(agent.name).toBe('New Name');
      expect(agent.status).toBe('inactive');
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'agent.update',
          }),
        })
      );
    });

    it('should throw if agent not found', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(null);

      await expect(agentService.update({
        organizationId: 'org-1',
        userId: 'user-1',
        agentId: 'agent-2',
      })).rejects.toThrow('AGENT_NOT_FOUND');
    });
  });

  describe('delete', () => {
    it('should delete agent and log audit', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue({
        id: 'agent-1',
        name: 'Test Agent',
        organizationId: 'org-1',
      });
      mockPrisma.agent.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      await agentService.delete('org-1', 'user-1', 'agent-1');

      expect(mockPrisma.agent.delete).toHaveBeenCalledWith({ where: { id: 'agent-1' } });
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'agent.delete',
          }),
        })
      );
    });

    it('should throw if agent not found', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(null);

      await expect(agentService.delete('org-1', 'user-1', 'agent-2')).rejects.toThrow('AGENT_NOT_FOUND');
    });
  });
});