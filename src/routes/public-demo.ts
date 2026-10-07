import { FastifyPluginAsync } from 'fastify';
import { ZodError, z } from 'zod';
import { DemoEvidenceProvider } from '../verification/providers.js';
import { REQUIRED_EMAIL_SENT_CHECKS, evaluateEvidence } from '../verification/engine.js';
import type { EmailSentClaim } from '../verification/types.js';
import {
  badRequest,
  emailSentClaimSchema,
  evidenceItemSchema,
  ok,
  rateLimited,
  serverError,
} from '../utils/openapi.js';

/**
 * Public, anonymous product demo. Runs ONLY the deterministic demo
 * provider for a fixed set of scenarios — no auth, no Gmail, no database
 * writes, no organization data. Strictly rate-limited.
 */

const SCENARIO_NAMES = ['verified', 'failed', 'inconclusive', 'contradiction'] as const;
type ScenarioName = (typeof SCENARIO_NAMES)[number];

const SCENARIO_CLAIMS: Record<ScenarioName, EmailSentClaim> = {
  verified: { type: 'email_sent', recipient: 'john@example.com', subject: 'Invoice #4821', attachment: 'invoice.pdf' },
  failed: { type: 'email_sent', recipient: 'jane@example.com', subject: 'Invoice #4821', attachment: 'invoice.pdf' },
  inconclusive: { type: 'email_sent', recipient: 'ghost@example.com', subject: 'Invoice #4821', attachment: 'invoice.pdf' },
  contradiction: {
    type: 'email_sent',
    recipient: 'john@example.com',
    subject: 'Invoice CONTRADICT #4821',
    attachment: 'invoice.pdf',
  },
};

const demoVerifySchema = z.object({
  // Strict: anything beyond `scenario` (claims, providers, org IDs) is
  // rejected rather than silently stripped.
  body: z
    .object({
      scenario: z.enum(SCENARIO_NAMES),
    })
    .strict(),
});

const publicDemoResultSchema = {
  type: 'object',
  required: ['scenario', 'provider', 'claim', 'status', 'confidence', 'reason', 'evidence'],
  properties: {
    scenario: { type: 'string', enum: [...SCENARIO_NAMES] },
    provider: { type: 'string', description: 'Always demo on this endpoint.' },
    claim: emailSentClaimSchema,
    status: { type: 'string', enum: ['VERIFIED', 'FAILED', 'INCONCLUSIVE'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
    evidence: { type: 'array', items: evidenceItemSchema },
  },
};

const publicDemoRoutes: FastifyPluginAsync = async (fastify) => {
  const provider = new DemoEvidenceProvider();

  fastify.post('/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['Public Demo'],
      summary: 'Run a fixed demo verification (no auth)',
      description:
        'Anonymous product demo. Evaluates one of four predefined scenarios with the ' +
        'deterministic demo provider through the real verification engine. ' +
        'Arbitrary claims and providers are not accepted; nothing is persisted.',
      security: [],
      body: {
        type: 'object',
        required: ['scenario'],
        additionalProperties: false,
        properties: {
          scenario: { type: 'string', enum: [...SCENARIO_NAMES], description: 'Fixed demo scenario.' },
        },
      },
      response: {
        200: ok(publicDemoResultSchema, 'Demo verification result.'),
        400: badRequest,
        429: rateLimited,
        500: serverError,
      },
    },
  }, async (request, reply) => {
    let scenario: ScenarioName;
    try {
      scenario = demoVerifySchema.parse({ body: request.body }).body.scenario;
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Invalid demo request',
          details: error.errors,
        });
      }
      throw error;
    }

    const claim = SCENARIO_CLAIMS[scenario];
    const evidence = await provider.collect(claim);
    const outcome = evaluateEvidence(evidence, REQUIRED_EMAIL_SENT_CHECKS);
    return { scenario, provider: provider.name, claim, ...outcome, evidence };
  });
};

export default publicDemoRoutes;