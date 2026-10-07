import fp from 'fastify-plugin';
import pino from 'pino';
import { getEnv } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    logger: pino.Logger;
  }
}

export default fp(async (fastify) => {
  const config = getEnv();

  const logger = pino({
    level: config.LOG_LEVEL,
    transport: config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  });

  fastify.decorate('logger', logger);
});