import { FastifyPluginAsync } from 'fastify';
import { ok, serverError } from '../utils/openapi.js';

class ServiceUnavailableError extends Error {
  statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

const timestampSchema = { type: 'string', format: 'date-time' };

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness check',
      description: 'Returns 200 when the process is running. No database access, no authentication.',
      security: [],
      response: {
        200: ok(
          {
            type: 'object',
            required: ['status', 'timestamp'],
            properties: { status: { type: 'string', example: 'ok' }, timestamp: timestampSchema },
          },
          'Service is alive.'
        ),
        500: serverError,
      },
    },
  }, async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  fastify.get('/health/ready', {
    schema: {
      tags: ['Health'],
      summary: 'Readiness check',
      description: 'Returns 200 when PostgreSQL is reachable, otherwise 503. No authentication.',
      security: [],
      response: {
        200: ok(
          {
            type: 'object',
            required: ['status', 'database', 'timestamp'],
            properties: {
              status: { type: 'string', example: 'ready' },
              database: { type: 'string', example: 'connected' },
              timestamp: timestampSchema,
            },
          },
          'Ready to serve traffic.'
        ),
        503: {
          description: 'Database not reachable.',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        500: serverError,
      },
    },
  }, async () => {
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'connected', timestamp: new Date().toISOString() };
    } catch (error) {
      fastify.log.error(error, 'Readiness check failed');
      throw new ServiceUnavailableError('Database not ready');
    }
  });
};

export default healthRoutes;