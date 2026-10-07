import { FastifyPluginAsync } from 'fastify';
import { readFile } from 'node:fs/promises';

/**
 * Local developer demo client (NOT the production dashboard).
 * Serves a single static HTML page; all product behavior stays in the API.
 */
const demoRoutes: FastifyPluginAsync = async (fastify) => {
  const htmlPath = new URL('../../public/demo.html', import.meta.url);
  let cached: string | null = null;

  fastify.get('/demo', {
    schema: {
      tags: ['Demo'],
      summary: 'Local demo client page',
      description: 'Serves the developer-facing demo HTML (uses the real API via fetch).',
      security: [],
      response: {
        200: {
          description: 'Demo HTML page.',
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

export default demoRoutes;