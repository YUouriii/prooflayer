import { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { registerSchema } from '../utils/validation.js';
import { requireAuth } from '../plugins/auth.js';
import {
  badRequest,
  conflict,
  messageSchema,
  ok,
  organizationRefSchema,
  rateLimited,
  serverError,
  unauthorized,
  userPublicSchema,
} from '../utils/openapi.js';

/**
 * JSON Schema mirror of registerSchema's body.
 * Fastify/AJV enforces this (400 on invalid input) and Swagger renders it
 * as the request body. The Zod schema remains authoritative in the handler.
 */
const registerBodyJsonSchema = {
  type: 'object',
  required: ['email', 'password', 'organizationName'],
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 8, maxLength: 128 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    organizationName: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const authService = fastify.authService;

  fastify.post('/register', {
    schema: {
      tags: ['Auth'],
      summary: 'Register a new user and organization',
      description: 'Creates a user together with a brand-new organization and starts a session (httpOnly cookie). `organizationName` is required.',
      security: [],
      body: registerBodyJsonSchema,
      response: {
        201: ok(
          {
            type: 'object',
            required: ['user', 'organization'],
            properties: { user: userPublicSchema, organization: organizationRefSchema },
          },
          'Registered user and organization. A `session` cookie is also set.'
        ),
        400: badRequest,
        409: conflict,
        429: rateLimited,
        500: serverError,
      },
    },
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    let parsed: { email: string; password: string; name?: string; organizationName: string };
    try {
      parsed = registerSchema.parse({ body: request.body }).body;
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Invalid registration request',
          details: error.errors,
        });
      }
      throw error;
    }
    try {
      const { email, password, name, organizationName } = parsed;
      const result = await authService.register({
        email,
        password,
        name,
        organizationName,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      const session = await authService.createSession(result.user.id, request.ip, request.headers['user-agent']);

      reply.setCookie('session', session.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60,
        path: '/',
      });

      return reply.status(201).send({
        user: { id: result.user.id, email: result.user.email, name: result.user.name },
        organization: { id: result.organization.id, name: result.organization.name },
      });
    } catch (error: any) {
      if (error.message === 'EMAIL_ALREADY_EXISTS') {
        return reply.status(409).send({ error: 'Conflict', message: 'Email already registered' });
      }
      throw error;
    }
  });

  fastify.post('/login', {
    schema: {
      tags: ['Auth'],
      summary: 'Log in with email and password',
      description: 'Starts a session (httpOnly cookie) on valid credentials.',
      security: [],
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
      },
      response: {
        200: ok(
          {
            type: 'object',
            required: ['user', 'organization'],
            properties: { user: userPublicSchema, organization: organizationRefSchema },
          },
          'Authenticated user and organization. A `session` cookie is also set.'
        ),
        400: badRequest,
        401: unauthorized,
        429: rateLimited,
        500: serverError,
      },
    },
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { email, password } = request.body as any;
    const result = await authService.login({
      email,
      password,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if (!result) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }

    reply.setCookie('session', result.session!.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60,
      path: '/',
    });

    return {
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      organization: { id: result.organization.id, name: result.organization.name },
    };
  });

  fastify.post('/logout', {
    schema: {
      tags: ['Auth'],
      summary: 'Log out the current session',
      description: 'Destroys the session cookie. API-key callers receive success but have no session to destroy.',
      response: {
        200: ok(messageSchema, 'Logged out.'),
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const sessionToken = request.cookies?.session;
    if (sessionToken) {
      await authService.destroySession(sessionToken);
    }

    reply.clearCookie('session', { path: '/' });
    return { message: 'Logged out successfully' };
  });

  fastify.get('/me', {
    schema: {
      tags: ['Auth'],
      summary: 'Get the current authentication context',
      description: 'Returns the session user or the calling API key, plus the resolved organization.',
      response: {
        200: ok(
          {
            type: 'object',
            properties: {
              user: userPublicSchema,
              apiKey: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  keyPrefix: { type: 'string' },
                  permissions: { type: 'array', items: { type: 'string' } },
                },
              },
              organization: organizationRefSchema,
            },
          },
          'Session shape contains `user`; API-key shape contains `apiKey`.'
        ),
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (request.user) {
      return {
        user: { id: request.user.id, email: request.user.email, name: request.user.name },
        organization: request.organization,
      };
    }
    if (request.apiKey) {
      return {
        apiKey: { id: request.apiKey.id, name: request.apiKey.name, keyPrefix: request.apiKey.keyPrefix, permissions: request.apiKey.permissions },
        organization: request.organization,
      };
    }
    return reply.status(401).send({ error: 'Unauthorized' });
  });
};

export default authRoutes;
