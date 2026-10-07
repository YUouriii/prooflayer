import { FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';

export async function requireOrganizationAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  resourceOrganizationId: string
) {
  const userOrgId = request.organizationId;
  const apiKeyOrgId = request.apiKey?.organizationId;

  const effectiveOrgId = userOrgId || apiKeyOrgId;

  if (!effectiveOrgId) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'No organization context' });
  }

  if (effectiveOrgId !== resourceOrganizationId) {
    return reply.status(403).send({ error: 'Forbidden', message: 'Access denied to this organization\'s resources' });
  }
}

export function requireOwnership<T extends { organizationId: string }>(
  getResource: (request: FastifyRequest) => Promise<T | null>,
  resourceName: string
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const resource = await getResource(request);
    if (!resource) {
      return reply.status(404).send({ error: 'Not Found', message: `${resourceName} not found` });
    }

    const userOrgId = request.organizationId;
    const apiKeyOrgId = request.apiKey?.organizationId;
    const effectiveOrgId = userOrgId || apiKeyOrgId;

    if (!effectiveOrgId || effectiveOrgId !== resource.organizationId) {
      return reply.status(403).send({ error: 'Forbidden', message: `Access denied to this ${resourceName}` });
    }

    (request as any)[resourceName.toLowerCase()] = resource;
  };
}

export function requireOrganizationId() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const userOrgId = request.organizationId;
    const apiKeyOrgId = request.apiKey?.organizationId;
    const effectiveOrgId = userOrgId || apiKeyOrgId;

    if (!effectiveOrgId) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Organization context required' });
    }
  };
}