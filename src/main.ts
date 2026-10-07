import fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cookie from '@fastify/cookie';

import configPlugin from './plugins/config.js';
import loggerPlugin from './plugins/logger.js';
import prismaPlugin from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';
import auditPlugin from './plugins/audit.js';
import requestIdPlugin from './plugins/request-id.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import organizationRoutes from './routes/organizations.js';
import agentRoutes from './routes/agents.js';
import apiKeyRoutes from './routes/api-keys.js';
import auditRoutes from './routes/audit.js';
import verificationRoutes from './routes/verifications.js';
import demoRoutes from './routes/demo.js';
import gmailRoutes from './routes/gmail.js';
import homepageRoutes from './routes/homepage.js';
import publicDemoRoutes from './routes/public-demo.js';
import { getEnv } from './config/env.js';
import { apiSecuritySchemes, serverUrl } from './utils/openapi.js';

async function buildApp() {
  const config = getEnv();

  const app = fastify({
    logger: false,
    // Single service behind Render's trusted reverse proxy: client IPs
    // come from X-Forwarded-For (rate limiting + audit IPs depend on it).
    trustProxy: true,
    ajv: {
      customOptions: {
        coerceTypes: 'array',
        removeAdditional: 'all',
      },
    },
  });

  await app.register(configPlugin);
  await app.register(loggerPlugin);
  await app.register(prismaPlugin);

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  const corsOrigins = config.CORS_ALLOWED_ORIGINS
    ? config.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter((origin) => origin.length > 0)
    : config.FRONTEND_URL
      ? [config.FRONTEND_URL]
      : true;

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  await app.register(cookie, {
    secret: config.JWT_SECRET,
    hook: 'onRequest',
  });

  await app.register(requestIdPlugin);

  // Global abuse guard: 100 requests/minute per caller. POST /verifications
  // carries a tighter route-level limit (expensive evidence collection).
  // Health/docs/demo stay under the same global budget, which comfortably
  // covers deployment probes.
  //
  // NOTE: per @fastify/rate-limit docs the builder returns a response
  // object (thrown by the plugin); it must carry statusCode itself.
  // requestId comes from the request-id hook, which runs first.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers['x-api-key'] as string || req.ip,
    errorResponseBuilder: (request) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Retry after the window resets.',
      requestId: request.requestId,
    }),
  });

  await app.register(authPlugin);
  await app.register(auditPlugin);

  // Developer surfaces. Disable in production with SWAGGER_ENABLED=false.
  const developerSurfaces = config.SWAGGER_ENABLED !== 'false';

  if (developerSurfaces) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'ProofLayer API',
          version: '0.1.0',
          description:
            'Independent verification layer for AI agents. ' +
            'External agents authenticate with `Authorization: Bearer <api-key>`. ' +
            'Every response carries an `X-Request-Id` header (send your own to correlate).',
        },
        servers: [{ url: serverUrl(config.PORT), description: 'Development server' }],
        components: {
          securitySchemes: apiSecuritySchemes,
        },
        security: [{ apiKey: [], session: [] }],
      },
    });

    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });
  }

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(organizationRoutes, { prefix: '/api/v1/organizations' });
  await app.register(agentRoutes, { prefix: '/api/v1/agents' });
  await app.register(apiKeyRoutes, { prefix: '/api/v1/api-keys' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit-logs' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verifications' });
  if (developerSurfaces) {
    await app.register(demoRoutes);
  }
  await app.register(gmailRoutes, { prefix: '/api/v1/gmail' });
  await app.register(homepageRoutes);
  await app.register(publicDemoRoutes, { prefix: '/api/v1/demo' });

  // Flat error contract is preserved ({ error, message, details? });
  // requestId is additive on every error response.
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    if (error.validation) {
      return reply.status(400).send({
        error: 'Validation Error',
        message: error.message,
        details: error.validation,
        requestId: request.requestId,
      });
    }

    if (error.statusCode) {
      return reply.status(error.statusCode).send({
        error: error.name,
        message: error.message,
        requestId: request.requestId,
      });
    }

    return reply.status(500).send({
      error: 'Internal Server Error',
      message: config.NODE_ENV === 'production' ? 'An unexpected error occurred' : error.message,
      requestId: request.requestId,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method}:${request.url} not found`,
      requestId: request.requestId,
    });
  });

  return app;
}

async function start() {
  try {
    const config = getEnv();
    const app = await buildApp();

    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Server listening on http://${config.HOST}:${config.PORT}`);
    app.log.info(`Swagger docs available at http://${config.HOST}:${config.PORT}/docs`);

    // Bounded graceful shutdown: stop accepting, drain in-flight work,
    // then force-exit. Prisma disconnects through the onClose hook.
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) {
        process.exit(1);
      }
      shuttingDown = true;
      app.log.info(`Received ${signal}, closing server`);
      const force = setTimeout(() => process.exit(1), 10_000);
      force.unref();
      app.close().then(
        () => process.exit(0),
        () => process.exit(1)
      );
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();