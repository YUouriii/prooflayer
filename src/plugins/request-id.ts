import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import fp from 'fastify-plugin';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Client-supplied IDs must be short, opaque, and charset-safe so they can
 * never smuggle log-injection payloads or oversized values.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

declare module 'fastify' {
  interface FastifyRequest {
    requestId?: string;
  }
}

export function normalizeRequestId(header: unknown): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (REQUEST_ID_PATTERN.test(trimmed)) return trimmed;
  }
  return randomUUID();
}

const requestIdPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const requestId = normalizeRequestId(request.headers[REQUEST_ID_HEADER]);
    request.requestId = requestId;
    reply.header(REQUEST_ID_HEADER, requestId);
  });

  fastify.addHook('onResponse', async (request, reply) => {
    // Operational fields only — never headers, bodies, query, or cookies,
    // which may carry passwords, API keys, tokens, or session data.
    fastify.logger.info({
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });
});

export default requestIdPlugin;