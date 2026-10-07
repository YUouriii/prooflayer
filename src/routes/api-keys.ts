import { FastifyPluginAsync } from 'fastify';
import { requireAuth, requireOrganization } from '../plugins/auth.js';
import { requireOrganizationAccess } from '../plugins/authorization.js';
import { defaultKeyPermissions } from '../plugins/auth.js';
import { clampPagination } from '../utils/pagination.js';
import {
  apiKeyPublicSchema,
  badRequest,
  conflict,
  dateTimeOrNull,
  forbidden,
  limitQuery,
  messageSchema,
  notFound,
  ok,
  pageQuery,
  paginationSchema,
  serverError,
  unauthorized,
} from '../utils/openapi.js';

const apiKeyFullSchema = {
  type: 'object',
  required: ['id', 'name', 'keyHash', 'keyPrefix', 'organizationId', 'permissions', 'createdAt'],
  properties: {
    id: { type: 'string', description: 'API key ID (not the secret).' },
    name: { type: 'string' },
    keyHash: { type: 'string', description: 'Argon2 hash of the secret. The raw secret is only ever returned once, in `key`.' },
    keyPrefix: { type: 'string' },
    organizationId: { type: 'string' },
    permissions: { type: 'array', items: { type: 'string' } },
    lastUsedAt: { ...dateTimeOrNull },
    expiresAt: { ...dateTimeOrNull },
    revokedAt: { ...dateTimeOrNull },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const apiKeyRoutes: FastifyPluginAsync = async (fastify) => {
  const authService = fastify.authService;

  fastify.get('/', {
    schema: {
      tags: ['API Keys'],
      summary: 'List active API keys',
      description: 'Revoked keys are excluded. Secrets are never returned; only metadata.',
      querystring: {
        type: 'object',
        properties: { page: { ...pageQuery }, limit: { ...limitQuery } },
      },
      response: {
        200: ok(
          {
            type: 'object',
            required: ['data', 'pagination'],
            properties: { data: { type: 'array', items: apiKeyPublicSchema }, pagination: paginationSchema },
          },
          'Paginated API key metadata (no secrets).'
        ),
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request) => {
    const { page, limit } = clampPagination((request.query as any).page, (request.query as any).limit);
    const skip = (page - 1) * limit;

    const [keys, total] = await Promise.all([
      fastify.prisma.apiKey.findMany({
        where: { organizationId: request.organizationId!, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          permissions: true,
          lastUsedAt: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
      fastify.prisma.apiKey.count({ where: { organizationId: request.organizationId!, revokedAt: null } }),
    ]);

    return {
      data: keys,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  });

  fastify.get('/:id', {
    schema: {
      tags: ['API Keys'],
      summary: 'Get an API key by ID',
      description: 'Metadata only; the secret is never returned after creation.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'API key ID.' } },
      },
      response: {
        200: ok(apiKeyPublicSchema, 'API key metadata.'),
        401: unauthorized,
        403: forbidden,
        404: notFound,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    const { id } = request.params as any;
    await requireOrganizationAccess(request, reply, request.organizationId!);

    const key = await fastify.prisma.apiKey.findFirst({
      where: { id, organizationId: request.organizationId!, revokedAt: null },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        permissions: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    if (!key) {
      return reply.status(404).send({ error: 'Not Found', message: 'API key not found' });
    }
    return key;
  });

  fastify.post('/', {
    schema: {
      tags: ['API Keys'],
      summary: 'Create an API key',
      description: 'The raw secret is returned ONCE in `key`. It is hashed server-side and can never be retrieved again.',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Scopes for this key. Canonical scopes: verification:create, verification:read, ' +
              'audit:read, agent:read, agent:write. Defaults to verify:email and read:history ' +
              '(legacy aliases covering verification and read access) when omitted.',
          },
          expiresAt: { type: 'string', format: 'date-time', description: 'Optional expiry timestamp.' },
        },
      },
      response: {
        201: ok(
          {
            type: 'object',
            required: [...(apiKeyFullSchema.required as string[]), 'key'],
            properties: { ...apiKeyFullSchema.properties, key: { type: 'string', description: 'Raw secret — shown once, never stored.' } },
          },
          'Created key including the one-time raw secret.'
        ),
        400: badRequest,
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    const { name, permissions, expiresAt } = request.body as any;
    const effectivePermissions = defaultKeyPermissions(permissions);
    const result = await authService.createApiKey({
      organizationId: request.organizationId!,
      userId: request.user!.id,
      name,
      permissions: effectivePermissions,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.status(201).send({
      ...result.apiKey,
      key: result.rawKey,
    });
  });

  fastify.delete('/:id', {
    schema: {
      tags: ['API Keys'],
      summary: 'Revoke an API key',
      description: 'Sets revokedAt; the key stops authenticating immediately.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'API key ID.' } },
      },
      response: {
        200: ok(messageSchema, 'Revocation confirmation.'),
        401: unauthorized,
        403: forbidden,
        404: notFound,
        409: conflict,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    const { id } = request.params as any;
    await requireOrganizationAccess(request, reply, request.organizationId!);

    try {
      await authService.revokeApiKey({
        organizationId: request.organizationId!,
        userId: request.user!.id,
        apiKeyId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return { message: 'API key revoked successfully' };
    } catch (error: any) {
      if (error.message === 'API_KEY_NOT_FOUND') {
        return reply.status(404).send({ error: 'Not Found', message: 'API key not found' });
      }
      if (error.message === 'API_KEY_ALREADY_REVOKED') {
        return reply.status(409).send({ error: 'Conflict', message: 'API key already revoked' });
      }
      throw error;
    }
  });
};

export default apiKeyRoutes;
