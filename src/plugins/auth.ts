import { FastifyPluginAsync } from 'fastify';
import { FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { AuthService } from '../services/auth.js';
import { AuditService } from '../services/audit.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; organizationId: string; name?: string };
    organization?: { id: string; name: string };
    organizationId?: string;
    apiKey?: { id: string; name: string; keyPrefix: string; permissions: string[]; organizationId: string };
  }
  interface FastifyInstance {
    authService: AuthService;
  }
}

const authPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const authService = new AuthService(fastify.prisma, new AuditService(fastify.prisma));

  fastify.decorate('authService', authService);

  fastify.addHook('onRequest', async (request, reply) => {
    const authHeader = request.headers.authorization;

    if (authHeader) {
      const [scheme, token] = authHeader.split(' ');
      if (scheme === 'Bearer' && token && token.startsWith('pl_')) {
        const result = await authService.validateApiKey(token, request.ip, request.headers['user-agent']);
        if (result) {
          request.apiKey = {
            id: result.apiKey.id,
            name: result.apiKey.name,
            keyPrefix: result.apiKey.keyPrefix,
            permissions: result.apiKey.permissions,
            organizationId: result.apiKey.organizationId,
          };
          request.organizationId = result.organization.id;
          request.organization = { id: result.organization.id, name: result.organization.name };
          return;
        }
      }
    }

    const sessionCookie = request.cookies?.session;
    if (sessionCookie) {
      const user = await validateSession(fastify.prisma, sessionCookie);
      if (user) {
        request.user = { id: user.id, email: user.email, organizationId: user.organizationId, name: user.name };
        request.organizationId = user.organizationId;
        request.organization = user.organization ? { id: user.organization.id, name: user.organization.name } : undefined;
      }
    }
  });
});

async function validateSession(prisma: any, sessionToken: string) {
  const session = await prisma.session.findUnique({
    where: { token: sessionToken },
    include: { user: { include: { organization: true } } },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  return session.user;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user && !request.apiKey) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
  }
}

export async function requireOrganization(request: FastifyRequest, reply: FastifyReply) {
  if (!request.organizationId) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Organization context required' });
  }
}

/**
 * Canonical API scopes. Session users bypass scope checks (interactive use);
 * API keys must hold the required scope. Legacy permission names issued
 * before scopes existed keep working through LEGACY_SCOPE_ALIASES, so no
 * existing key breaks.
 */
export const SCOPES = {
  VERIFICATION_CREATE: 'verification:create',
  VERIFICATION_READ: 'verification:read',
  AUDIT_READ: 'audit:read',
  AGENT_READ: 'agent:read',
  AGENT_WRITE: 'agent:write',
} as const;

export type ApiScope = (typeof SCOPES)[keyof typeof SCOPES];

const LEGACY_SCOPE_ALIASES: Record<string, ApiScope[]> = {
  'verify:email': [SCOPES.VERIFICATION_CREATE, SCOPES.VERIFICATION_READ],
  'read:history': [SCOPES.VERIFICATION_READ, SCOPES.AUDIT_READ, SCOPES.AGENT_READ],
};

export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  return granted.some((permission) => LEGACY_SCOPE_ALIASES[permission]?.includes(required as ApiScope) ?? false);
}

/**
 * Documented default permissions for keys created without an explicit list
 * (mirrors the Zod/OpenAPI default). An empty scope set would produce a
 * key that authenticates yet is authorized for nothing.
 */
export function defaultKeyPermissions(input: unknown): string[] {
  if (Array.isArray(input)) {
    const cleaned = input.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (cleaned.length > 0) return cleaned;
  }
  return ['verify:email', 'read:history'];
}

export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.apiKey && !hasScope(request.apiKey.permissions, permission)) {
      return reply.status(403).send({ error: 'Forbidden', message: `Permission '${permission}' required` });
    }
  };
}

export default authPlugin;