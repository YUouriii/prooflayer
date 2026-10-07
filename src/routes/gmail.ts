import { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { gmailCallbackSchema } from '../utils/validation.js';
import { requireAuth, requireOrganization } from '../plugins/auth.js';
import { GmailAccountService } from '../services/gmail.js';
import { OAuthStateError, createGoogleOAuthClient } from '../integrations/gmail/oauth.js';
import {
  badRequest,
  forbidden,
  gmailAccountSchema,
  messageSchema,
  notFound,
  ok,
  serverError,
  unauthorized,
} from '../utils/openapi.js';

const gmailRoutes: FastifyPluginAsync = async (fastify) => {
  const oauth = createGoogleOAuthClient({
    clientId: fastify.config.GOOGLE_CLIENT_ID,
    clientSecret: fastify.config.GOOGLE_CLIENT_SECRET,
    redirectUri: fastify.config.GOOGLE_REDIRECT_URI,
  });
  const gmailService = new GmailAccountService(fastify.prisma, fastify.auditService, oauth, {
    stateSecret: fastify.config.JWT_SECRET,
  });

  fastify.get('/connect', {
    schema: {
      tags: ['Gmail'],
      summary: 'Start Gmail OAuth',
      description:
        'Returns the Google consent URL for connecting a mailbox to your organization. ' +
        'Requires a session user (completing OAuth happens in a browser).',
      response: {
        200: ok(
          {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', description: 'Google OAuth consent URL (single use, expires in 10 minutes).' },
            },
          },
          'Consent URL. Open it in a browser to authorize ProofLayer.'
        ),
        401: unauthorized,
        403: forbidden,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Gmail connect requires a user session' });
    }
    return gmailService.buildConnect({
      organizationId: request.organizationId!,
      userId: request.user.id,
    });
  });

  fastify.get('/callback', {
    schema: {
      tags: ['Gmail'],
      summary: 'Gmail OAuth callback',
      description:
        'Google redirects here after consent. Verifies state (CSRF), exchanges the code, ' +
        'and stores encrypted tokens. Never returns tokens; on success responds with a 302 ' +
        'redirect to /demo?gmail=connected. Requires the same session user that started the flow.',
      querystring: {
        type: 'object',
        required: ['code', 'state'],
        properties: {
          code: { type: 'string', description: 'Authorization code from Google.' },
          state: { type: 'string', description: 'Signed state issued by /connect.' },
        },
      },
      response: {
        400: badRequest,
        401: unauthorized,
        403: forbidden,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    let query: { code: string; state: string };
    try {
      query = gmailCallbackSchema.parse({ query: request.query }).query;
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Invalid OAuth callback',
          details: error.errors,
        });
      }
      throw error;
    }
    if (!request.user) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Gmail callback requires a user session' });
    }
    try {
      await gmailService.handleCallback({
        code: query.code,
        state: query.state,
        organizationId: request.organizationId!,
        userId: request.user.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return reply.redirect('/demo?gmail=connected');
    } catch (error) {
      if (error instanceof OAuthStateError) {
        return reply.status(400).send({ error: 'Bad Request', message: error.message });
      }
      throw error;
    }
  });

  fastify.get('/accounts', {
    schema: {
      tags: ['Gmail'],
      summary: 'List connected Gmail accounts',
      description: 'Metadata only — access/refresh tokens are never returned.',
      response: {
        200: ok(
          {
            type: 'object',
            required: ['data'],
            properties: { data: { type: 'array', items: gmailAccountSchema } },
          },
          'Gmail accounts of your organization (no secrets).'
        ),
        401: unauthorized,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request) => {
    const data = await gmailService.listAccounts(request.organizationId!);
    return { data };
  });

  fastify.get('/accounts/:id', {
    schema: {
      tags: ['Gmail'],
      summary: 'Get a Gmail account by ID',
      description: 'Metadata only — access/refresh tokens are never returned.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Gmail account ID.' } },
      },
      response: {
        200: ok(gmailAccountSchema, 'Gmail account metadata.'),
        401: unauthorized,
        403: forbidden,
        404: notFound,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await gmailService.getAccount(request.organizationId!, id);
    if (!account) {
      return reply.status(404).send({ error: 'Not Found', message: 'Gmail account not found' });
    }
    return account;
  });

  fastify.delete('/accounts/:id', {
    schema: {
      tags: ['Gmail'],
      summary: 'Disconnect a Gmail account',
      description:
        'Revokes the grant at Google (best effort), wipes stored tokens, and marks ' +
        'the account DISCONNECTED. Recorded in the audit log without secrets.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Gmail account ID.' } },
      },
      response: {
        200: ok(gmailAccountSchema, 'Disconnected account metadata.'),
        401: unauthorized,
        403: forbidden,
        404: notFound,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const account = await gmailService.disconnect({
        organizationId: request.organizationId!,
        userId: request.user?.id,
        apiKeyId: request.apiKey?.id,
        accountId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return account;
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'GMAIL_ACCOUNT_NOT_FOUND') {
        return reply.status(404).send({ error: 'Not Found', message: 'Gmail account not found' });
      }
      throw error;
    }
  });
};

export default gmailRoutes;
