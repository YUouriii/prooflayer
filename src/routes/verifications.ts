import { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { createVerificationSchema, getVerificationSchema } from '../utils/validation.js';
import { SCOPES, requireAuth, requireOrganization, requirePermission } from '../plugins/auth.js';
import { VerificationService } from '../services/verification.js';
import type { Claim } from '../verification/types.js';
import { GMAIL_PROVIDER_NAME, EvidenceProviderRegistry } from '../verification/registry.js';
import { GmailEvidenceProvider } from '../integrations/gmail/provider.js';
import { PrismaGmailAccountStore } from '../integrations/gmail/store.js';
import { createGoogleOAuthClient } from '../integrations/gmail/oauth.js';
import {
  badRequest,
  conflict,
  emailSentClaimSchema,
  forbidden,
  notFound,
  ok,
  rateLimited,
  serverError,
  unauthorized,
  verificationResultSchema,
} from '../utils/openapi.js';

interface CreateVerificationBody {
  agentId: string;
  claim: Claim;
  provider?: string;
}

function readIdempotencyKey(header: unknown): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return undefined;
  return trimmed;
}

const verificationRoutes: FastifyPluginAsync = async (fastify) => {
  const store = new PrismaGmailAccountStore(fastify.prisma);
  const oauth = createGoogleOAuthClient({
    clientId: fastify.config.GOOGLE_CLIENT_ID,
    clientSecret: fastify.config.GOOGLE_CLIENT_SECRET,
    redirectUri: fastify.config.GOOGLE_REDIRECT_URI,
  });
  const registry = new EvidenceProviderRegistry();
  registry.register(GMAIL_PROVIDER_NAME, () => new GmailEvidenceProvider({ store, oauth }));
  const verificationService = new VerificationService(fastify.prisma, fastify.auditService, undefined, registry);

  fastify.post('/', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['Verifications'],
      summary: 'Verify an agent claim',
      description:
        'Independently checks an agent’s claim against external evidence via the verification engine. ' +
        'The organization is taken from the authenticated context (never from the request body); ' +
        'agentId must belong to that organization. Works with session cookies and Bearer API keys. ' +
        'Pass `provider: "gmail"` for real Gmail evidence (default "demo"). ' +
        'Send Idempotency-Key to safely retry: identical repeats return the original record. ' +
        'API keys need the verification:create scope (session users are exempt). ' +
        'Send X-Request-Id for correlation (a random ID is assigned otherwise). ' +
        'Creation is rate-limited to 30 requests/minute per caller.',
      headers: {
        type: 'object',
        properties: {
          'idempotency-key': {
            type: 'string',
            description: 'Optional caller-supplied idempotency key, scoped to your organization.',
          },
        },
      },
      body: {
        type: 'object',
        required: ['agentId', 'claim'],
        properties: {
          agentId: { type: 'string', description: 'Agent that made the claim (must be in your organization).' },
          claim: emailSentClaimSchema,
          provider: { type: 'string', enum: ['demo', 'gmail'], description: 'Evidence source. Defaults to demo.' },
        },
      },
      response: {
        200: ok(verificationResultSchema, 'Replayed verification for a repeated idempotency key.'),
        201: ok(verificationResultSchema, 'Verification result with status, confidence, reason, and evidence.'),
        400: badRequest,
        401: unauthorized,
        403: forbidden,
        404: notFound,
        409: conflict,
        429: rateLimited,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization, requirePermission(SCOPES.VERIFICATION_CREATE)],
  }, async (request, reply) => {
    // NOTE: Fastify does not enforce the Zod schemas declared above
    // (verified: invalid payloads reach the handler), so the claim is
    // validated explicitly here. Invalid claims → 400.
    let body: CreateVerificationBody;
    try {
      const parsed = createVerificationSchema.parse({ body: request.body });
      body = parsed.body as CreateVerificationBody;
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Invalid verification request',
          details: error.errors,
        });
      }
      throw error;
    }

    try {
      const result = await verificationService.create({
        organizationId: request.organizationId!,
        userId: request.user?.id,
        apiKeyId: request.apiKey?.id,
        agentId: body.agentId,
        claim: body.claim,
        providerName: body.provider,
        idempotencyKey: readIdempotencyKey(request.headers['idempotency-key']),
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
      const { replayed, ...verification } = result;
      return reply.status(replayed ? 200 : 201).send(verification);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'AGENT_NOT_FOUND') {
        return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
      }
      if (error instanceof Error && error.message === 'UNSUPPORTED_CLAIM') {
        return reply.status(400).send({ error: 'Bad Request', message: 'Unsupported claim type' });
      }
      if (error instanceof Error && error.message === 'UNKNOWN_PROVIDER') {
        return reply.status(400).send({ error: 'Bad Request', message: 'Unknown evidence provider' });
      }
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') {
        return reply.status(409).send({ error: 'Conflict', message: 'Idempotency key already used for a different request' });
      }
      throw error;
    }
  });

  fastify.get('/:id', {
    schema: {
      tags: ['Verifications'],
      summary: 'Get a verification by ID',
      description: 'Only verifications of the caller’s organization are visible.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Verification ID.' } },
      },
      response: {
        200: ok(verificationResultSchema, 'Verification result.'),
        401: unauthorized,
        403: forbidden,
        404: notFound,
        500: serverError,
      },
    },
    preHandler: [requireAuth, requireOrganization, requirePermission(SCOPES.VERIFICATION_READ)],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await verificationService.getById(request.organizationId!, id);
    if (!result) {
      return reply.status(404).send({ error: 'Not Found', message: 'Verification not found' });
    }
    return result;
  });
};

export default verificationRoutes;