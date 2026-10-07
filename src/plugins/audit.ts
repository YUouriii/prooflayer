import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AuditService } from '../services/audit.js';

declare module 'fastify' {
  interface FastifyInstance {
    auditService: AuditService;
  }
}

const auditPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const auditService = new AuditService(fastify.prisma);
  fastify.decorate('auditService', auditService);
});

export default auditPlugin;