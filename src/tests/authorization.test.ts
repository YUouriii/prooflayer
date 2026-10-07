import { describe, it, expect, vi } from 'vitest';
import { FastifyRequest, FastifyReply } from 'fastify';
import { requireOrganizationAccess, requireOrganizationId } from '../plugins/authorization.js';
import { SCOPES, defaultKeyPermissions, hasScope, requirePermission } from '../plugins/auth.js';

function createMockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    organizationId: 'org-1',
    apiKey: undefined,
    user: undefined,
    ...overrides,
  } as FastifyRequest;
}

function createMockReply(): FastifyReply {
  const reply: any = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

describe('Authorization Middleware', () => {
  describe('requireOrganizationAccess', () => {
    it('should allow access when organization matches user', async () => {
      const request = createMockRequest({ organizationId: 'org-1' });
      const reply = createMockReply();

      await requireOrganizationAccess(request, reply, 'org-1');

      expect(reply.status).not.toHaveBeenCalled();
      expect(reply.send).not.toHaveBeenCalled();
    });

    it('should allow access when organization matches API key', async () => {
      const request = createMockRequest({
        organizationId: undefined,
        apiKey: { organizationId: 'org-1' } as any,
      });
      const reply = createMockReply();

      await requireOrganizationAccess(request, reply, 'org-1');

      expect(reply.status).not.toHaveBeenCalled();
    });

    it('should deny access when organization does not match', async () => {
      const request = createMockRequest({ organizationId: 'org-1' });
      const reply = createMockReply();

      await requireOrganizationAccess(request, reply, 'org-2');

      expect(reply.status).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: "Access denied to this organization's resources",
      });
    });

    it('should deny access when no organization context', async () => {
      const request = createMockRequest({ organizationId: undefined });
      const reply = createMockReply();

      await requireOrganizationAccess(request, reply, 'org-1');

      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'No organization context',
      });
    });
  });

  describe('requireOrganizationId', () => {
    it('should allow when organization ID present from user', async () => {
      const request = createMockRequest({ organizationId: 'org-1' });
      const reply = createMockReply();

      await requireOrganizationId()(request, reply);

      expect(reply.status).not.toHaveBeenCalled();
    });

    it('should allow when organization ID present from API key', async () => {
      const request = createMockRequest({
        organizationId: undefined,
        apiKey: { organizationId: 'org-1' } as any,
      });
      const reply = createMockReply();

      await requireOrganizationId()(request, reply);

      expect(reply.status).not.toHaveBeenCalled();
    });

    it('should deny when no organization context', async () => {
      const request = createMockRequest({ organizationId: undefined });
      const reply = createMockReply();

      await requireOrganizationId()(request, reply);

      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'Organization context required',
      });
    });
  });

  describe('API scopes', () => {
    it('grants exact canonical scopes', () => {
      expect(hasScope(['verification:create'], SCOPES.VERIFICATION_CREATE)).toBe(true);
      expect(hasScope(['verification:read'], SCOPES.VERIFICATION_CREATE)).toBe(false);
    });

    it('honors legacy aliases so existing keys keep working', () => {
      expect(hasScope(['verify:email'], SCOPES.VERIFICATION_CREATE)).toBe(true);
      expect(hasScope(['verify:email'], SCOPES.VERIFICATION_READ)).toBe(true);
      expect(hasScope(['read:history'], SCOPES.AUDIT_READ)).toBe(true);
      expect(hasScope(['read:history'], SCOPES.AGENT_READ)).toBe(true);
      expect(hasScope(['read:history'], SCOPES.AGENT_WRITE)).toBe(false);
      expect(hasScope(['verify:email'], SCOPES.AGENT_WRITE)).toBe(false);
    });

    it('session users bypass scope checks', async () => {
      const request = createMockRequest({ user: { id: 'u', email: 'e', organizationId: 'org-1' } });
      const reply = createMockReply();
      await requirePermission(SCOPES.VERIFICATION_CREATE)(request, reply);
      expect(reply.status).not.toHaveBeenCalled();
    });

    it('scoped-out API keys get 403', async () => {
      const request = createMockRequest({
        apiKey: { permissions: ['verification:read'], organizationId: 'org-1' } as any,
      });
      const reply = createMockReply();
      await requirePermission(SCOPES.VERIFICATION_CREATE)(request, reply);
      expect(reply.status).toHaveBeenCalledWith(403);
    });

    it('omitted permissions fall back to the documented default', () => {
      expect(defaultKeyPermissions(undefined)).toEqual(['verify:email', 'read:history']);
      expect(defaultKeyPermissions([])).toEqual(['verify:email', 'read:history']);
      expect(defaultKeyPermissions(['verification:create'])).toEqual(['verification:create']);
      expect(defaultKeyPermissions(['a', 42, ''])).toEqual(['a']);
    });

    it('scoped-in API keys pass (canonical and legacy)', async () => {
      for (const permissions of [['verification:create'], ['verify:email']]) {
        const request = createMockRequest({ apiKey: { permissions, organizationId: 'org-1' } as any });
        const reply = createMockReply();
        await requirePermission(SCOPES.VERIFICATION_CREATE)(request, reply);
        expect(reply.status).not.toHaveBeenCalled();
      }
    });
  });
});