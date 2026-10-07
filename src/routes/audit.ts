import { FastifyPluginAsync } from 'fastify';
import { requireAuth, requireOrganization } from '../plugins/auth.js';
import { clampPagination } from '../utils/pagination.js';
import {
  auditLogSchema,
  limitQuery,
  ok,
  pageQuery,
  paginationSchema,
  serverError,
  unauthorized,
} from '../utils/openapi.js';

const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    schema: {
      tags: ['Audit'],
      summary: 'List audit logs of the current organization',
      description: 'Security-sensitive actions (logins, agent/key changes, verifications). Secrets are never stored in audit records.',
      querystring: {
        type: 'object',
        properties: {
          page: { ...pageQuery },
          limit: { ...limitQuery },
          action: { type: 'string', description: 'Filter by action, e.g. verification.create.' },
          userId: { type: 'string', description: 'Filter by actor user ID.' },
          startDate: { type: 'string', format: 'date-time', description: 'Filter from this timestamp.' },
          endDate: { type: 'string', format: 'date-time', description: 'Filter up to this timestamp.' },
        },
      },
      response: {
        200: ok(
          {
            type: 'object',
            required: ['data', 'pagination'],
            properties: { data: { type: 'array', items: auditLogSchema }, pagination: paginationSchema },
          },
          'Paginated audit logs scoped to the caller’s organization.'
        ),
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request) => {
    const { action, userId, startDate, endDate } = request.query as any;
    const { page, limit } = clampPagination((request.query as any).page, (request.query as any).limit);
    return fastify.auditService.getAuditLogs(request.organizationId!, {
      page,
      limit,
      action,
      userId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });
  });
};

export default auditRoutes;