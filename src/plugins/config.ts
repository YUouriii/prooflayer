import fp from 'fastify-plugin';
import { getEnv, Env } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Env;
  }
}

export default fp(async (fastify) => {
  const config = getEnv();
  fastify.decorate('config', config);
});