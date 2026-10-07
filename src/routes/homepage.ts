import { FastifyPluginAsync } from 'fastify';
import { readFile } from 'node:fs/promises';

/**
 * Public product homepage. Always served (unlike /docs and /demo, which can
 * be disabled in production). Static HTML; the interactive demo calls the
 * anonymous POST /api/v1/demo/verify endpoint.
 */
const homepageRoutes: FastifyPluginAsync = async (fastify) => {
  const htmlPath = new URL('../../public/index.html', import.meta.url);
  let cached: string | null = null;

  fastify.get('/', {
    schema: {
      tags: ['Public'],
      summary: 'ProofLayer product homepage',
      description: 'Public landing page with an interactive demo. No authentication required.',
      security: [],
      response: {
        200: {
          description: 'Homepage HTML.',
          content: { 'text/html': { schema: { type: 'string' } } },
        },
      },
    },
  }, async (request, reply) => {
    if (!cached) {
      cached = await readFile(htmlPath, 'utf8');
    }
    return reply.type('text/html').send(cached);
  });
};

export default homepageRoutes;