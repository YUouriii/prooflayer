import { FastifyPluginAsync } from 'fastify';
import { requireAuth, requireOrganization } from '../plugins/auth.js';
import { requireOrganizationAccess } from '../plugins/authorization.js';
import { clampPagination } from '../utils/pagination.js';
import { PrismaClient } from '@prisma/client';
import {
  badRequest,
  forbidden,
  limitQuery,
  notFound,
  ok,
  organizationSchema,
  organizationWithCountSchema,
  pageQuery,
  paginationSchema,
  serverError,
  unauthorized,
  json,
} from '../utils/openapi.js';

const organizationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    schema: {
      tags: ['Organizations'],
      summary: 'List the current organization',
      description: 'Returns the single organization of the authenticated context (users belong to exactly one organization).',
      querystring: {
        type: 'object',
        properties: { page: { ...pageQuery }, limit: { ...limitQuery } },
      },
      response: {
        200: ok(
          {
            type: 'object',
            required: ['data', 'pagination'],
            properties: { data: { type: 'array', items: organizationWithCountSchema }, pagination: paginationSchema },
          },
          'Own organization with resource counts.'
        ),
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request) => {
    const { page, limit } = clampPagination((request.query as any).page, (request.query as any).limit);
    const orgId = request.organizationId!;

    // Users can only see their own organization
    const org = await fastify.prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        _count: { select: { users: true, agents: true, apiKeys: true } },
      },
    });

    if (!org) {
      return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };
    }

    return {
      data: [org],
      pagination: { page, limit, total: 1, totalPages: 1 },
    };
  });

  fastify.get('/:id', {
    schema: {
      tags: ['Organizations'],
      summary: 'Get an organization by ID',
      description: 'Only the caller’s own organization is accessible; other IDs return 403/404.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Organization ID.' } },
      },
      response: {
        200: ok(organizationWithCountSchema, 'Organization with resource counts.'),
        401: unauthorized,
        403: forbidden,
        404: notFound,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    const { id } = request.params as any;
    await requireOrganizationAccess(request, reply, id);

    const org = await fastify.prisma.organization.findUnique({
      where: { id },
      include: {
        _count: { select: { users: true, agents: true, apiKeys: true } },
      },
    });

    if (!org) {
      return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });
    }

    return org;
  });

  fastify.post('/', {
    schema: {
      tags: ['Organizations'],
      summary: 'Create an organization',
      description: 'Creates an organization and moves the calling user into it.',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
      response: {
        201: ok(organizationSchema, 'Created organization.'),
        400: badRequest,
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { name } = request.body as any;
    const userId = request.user!.id;

    const org = await fastify.prisma.organization.create({ data: { name } });

    await fastify.prisma.user.update({
      where: { id: userId },
      data: { organizationId: org.id },
    });

    await fastify.auditService.log({
      organizationId: org.id,
      userId,
      action: 'organization.create',
      metadata: { name },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.status(201).send(org);
  });

  fastify.patch('/:id', {
    schema: {
      tags: ['Organizations'],
      summary: 'Update the own organization',
      description: 'Only the caller’s own organization can be updated.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Organization ID.' } },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
      response: {
        200: ok(organizationSchema, 'Updated organization.'),
        400: badRequest,
        401: unauthorized,
        403: forbidden,
        404: notFound,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    const { id } = request.params as any;
    await requireOrganizationAccess(request, reply, id);

    const { name } = request.body as any;
    const org = await fastify.prisma.organization.update({
      where: { id },
      data: { name },
    });

    await fastify.auditService.log({
      organizationId: id,
      userId: request.user!.id,
      action: 'organization.update',
      metadata: { name },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return org;
  });
};

export default organizationRoutes;
