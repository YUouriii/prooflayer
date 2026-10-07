import { FastifyPluginAsync } from 'fastify';
import { requireAuth, requireOrganization } from '../plugins/auth.js';
import { requireOrganizationAccess } from '../plugins/authorization.js';
import { AgentService } from '../services/agent.js';
import { clampPagination } from '../utils/pagination.js';
import {
  agentSchema,
  badRequest,
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

const agentRoutes: FastifyPluginAsync = async (fastify) => {
  const agentService = new AgentService(fastify.prisma, fastify.auditService);

  fastify.get('/', {
    schema: {
      tags: ['Agents'],
      summary: 'List agents of the current organization',
      querystring: {
        type: 'object',
        properties: { page: { ...pageQuery }, limit: { ...limitQuery } },
      },
      response: {
        200: ok(
          {
            type: 'object',
            required: ['data', 'pagination'],
            properties: { data: { type: 'array', items: agentSchema }, pagination: paginationSchema },
          },
          'Paginated agents scoped to the caller’s organization.'
        ),
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request) => {
    const { page, limit } = clampPagination((request.query as any).page, (request.query as any).limit);
    return agentService.getAll(request.organizationId!, { page, limit });
  });

  fastify.get('/:id', {
    schema: {
      tags: ['Agents'],
      summary: 'Get an agent by ID',
      description: 'Only agents of the caller’s organization are visible.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Agent ID.' } },
      },
      response: {
        200: ok(agentSchema, 'Agent.'),
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

    const agent = await agentService.getById(request.organizationId!, id);
    if (!agent) {
      return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
    }
    return agent;
  });

  fastify.post('/', {
    schema: {
      tags: ['Agents'],
      summary: 'Register an agent',
      description: 'Creates an agent in the caller’s organization.',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
        },
      },
      response: {
        201: ok(agentSchema, 'Created agent.'),
        400: badRequest,
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    const { name, description } = request.body as any;
    const agent = await agentService.create({
      organizationId: request.organizationId!,
      userId: request.user!.id,
      name,
      description,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return reply.status(201).send(agent);
  });

  fastify.patch('/:id', {
    schema: {
      tags: ['Agents'],
      summary: 'Update an agent',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Agent ID.' } },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
      },
      response: {
        200: ok(agentSchema, 'Updated agent.'),
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
    await requireOrganizationAccess(request, reply, request.organizationId!);

    const { name, description, status } = request.body as any;
    try {
      const agent = await agentService.update({
        organizationId: request.organizationId!,
        userId: request.user!.id,
        agentId: id,
        name,
        description,
        status,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return agent;
    } catch (error: any) {
      if (error.message === 'AGENT_NOT_FOUND') {
        return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
      }
      throw error;
    }
  });

  fastify.delete('/:id', {
    schema: {
      tags: ['Agents'],
      summary: 'Delete an agent',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Agent ID.' } },
      },
      response: {
        200: ok(messageSchema, 'Deletion confirmation.'),
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

    try {
      await agentService.delete(request.organizationId!, request.user!.id, id, request.ip, request.headers['user-agent']);
      return { message: 'Agent deleted successfully' };
    } catch (error: any) {
      if (error.message === 'AGENT_NOT_FOUND') {
        return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
      }
      throw error;
    }
  });
};

export default agentRoutes;
