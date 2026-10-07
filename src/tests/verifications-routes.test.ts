import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import verificationRoutes from '../routes/verifications.js';
import requestIdPlugin from '../plugins/request-id.js';
import { AuthService } from '../services/auth.js';
import { AuditService } from '../services/audit.js';
import type { EmailSentClaim } from '../verification/types.js';

const mockPrisma = {
  agent: { findFirst: vi.fn() },
  verification: { create: vi.fn(), findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
} as unknown as PrismaClient;

const CLAIM: EmailSentClaim = {
  type: 'email_sent',
  recipient: 'john@example.com',
  subject: 'Invoice #4821',
  attachment: 'invoice.pdf',
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ver-1',
    agentId: 'cmutwgqxp001sclev4c73dre2',
    organizationId: 'org-1',
    provider: 'demo',
    actionType: 'email_sent',
    claim: { ...CLAIM },
    status: 'VERIFIED',
    confidence: 0.98,
    reason: 'All 5 required checks passed.',
    evidence: [],
    gmailMessageId: null,
    idempotencyKey: null,
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function buildApp(withRateLimit = false): Promise<FastifyInstance> {
  const app = fastify();
  // Mirrors production wiring (loggerPlugin decorates fastify.logger,
  // which the request-ID hook uses for structured logs).
  app.decorate('logger', pino({ level: 'silent' }));
  app.decorate('prisma', mockPrisma);
  const auditService = new AuditService(mockPrisma);
  app.decorate('auditService', auditService);
  app.decorate('authService', new AuthService(mockPrisma, auditService));
  app.decorate('config', {
    GOOGLE_CLIENT_ID: 'x',
    GOOGLE_CLIENT_SECRET: 'y',
    GOOGLE_REDIRECT_URI: 'http://localhost/cb',
    JWT_SECRET: 'test-jwt-secret-min-32-characters!!',
  });
  // Test-only auth context: headers drive the authenticated identity,
  // mirroring what the real auth hook establishes.
  app.addHook('onRequest', async (request) => {
    const user = request.headers['x-test-user'];
    const org = request.headers['x-test-org'];
    if (typeof user === 'string' && typeof org === 'string') {
      request.user = { id: user, email: `${user}@example.com`, organizationId: org };
      request.organizationId = org;
      request.organization = { id: org, name: 'Test Org' };
    }
    const permissions = request.headers['x-test-key-permissions'];
    if (typeof org === 'string' && typeof permissions === 'string') {
      request.apiKey = {
        id: 'key-1',
        name: 'test key',
        keyPrefix: 'pl',
        permissions: permissions.split(','),
        organizationId: org,
      };
      request.organizationId = org;
      request.organization = { id: org, name: 'Test Org' };
    }
  });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  // Mirrors the production error contract in main.ts.
  app.setErrorHandler((error, request, reply) => {
    const status = (error as unknown as { statusCode?: number }).statusCode ?? 500;
    const err = error as unknown as { name?: string; message?: string };
    reply.status(status).send({
      error: err.name ?? 'Error',
      message: err.message ?? '',
      requestId: (request as unknown as { requestId?: string }).requestId,
    });
  });
  if (withRateLimit) {
    await app.register(rateLimit, {
      max: 100,
      timeWindow: '1 minute',
      keyGenerator: () => 'test-suite',
      errorResponseBuilder: () => {
        const error = new Error('Rate limit exceeded.') as Error & { statusCode: number };
        error.name = 'Too Many Requests';
        error.statusCode = 429;
        return error;
      },
    });
  }
  await app.register(verificationRoutes, { prefix: '/verifications' });
  return app;
}

const AUTH = { 'x-test-user': 'user-1', 'x-test-org': 'org-1' };

describe('POST /verifications', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPrisma.agent.findFirst.mockResolvedValue({ id: 'cmutwgqxp001sclev4c73dre2', organizationId: 'org-1' });
    mockPrisma.verification.findFirst.mockResolvedValue(null);
    mockPrisma.verification.create.mockImplementation((args: unknown) =>
      Promise.resolve(row((args as { data: Record<string, unknown> }).data))
    );
    mockPrisma.auditLog.create.mockResolvedValue({});
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('unauthenticated request → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/verifications/', payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM } });
    expect(res.statusCode).toBe(401);
  });

  it('invalid provider → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: AUTH,
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM, provider: 'slack' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('malformed claim → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: AUTH,
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: { type: 'email_sent', recipient: 'nope', subject: '' } },
    });
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.verification.create).not.toHaveBeenCalled();
  });

  it('unknown agent → 404', async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: AUTH,
      payload: { agentId: 'cm00000000000000000000000', claim: CLAIM },
    });
    expect(res.statusCode).toBe(404);
  });

  it('agent from another organization → 404 (no leak)', async () => {
    mockPrisma.agent.findFirst.mockImplementation((args: unknown) => {
      const where = (args as { where: { id: string; organizationId: string } }).where;
      return Promise.resolve(where.organizationId === 'org-1' ? { id: 'cmutwgqxp001sclev4c73dre2', organizationId: 'org-1' } : null);
    });
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: { 'x-test-user': 'user-2', 'x-test-org': 'org-2' },
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM },
    });
    expect(res.statusCode).toBe(404);
    expect(mockPrisma.verification.create).not.toHaveBeenCalled();
  });

  it('client-supplied organizationId is ignored', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: AUTH,
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM, organizationId: 'org-evil' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { organizationId: string };
    expect(body.organizationId).toBe('org-1');
    const created = mockPrisma.verification.create.mock.calls[0][0] as unknown as { data: Record<string, unknown> };
    expect(created.data.organizationId).toBe('org-1');
  });

  it('success returns provider and evidence source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: AUTH,
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { provider: string; evidence: { source: string }[] };
    expect(body.provider).toBe('demo');
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.evidence.every((e) => e.source === 'demo')).toBe(true);
  });

  it('same key + same request replays with 200', async () => {
    const headers = { ...AUTH, 'idempotency-key': 'k-1' };
    const first = await app.inject({ method: 'POST', url: '/verifications/', headers, payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM } });
    expect(first.statusCode).toBe(201);
    mockPrisma.verification.findFirst.mockResolvedValue(row({ idempotencyKey: 'k-1' }));
    const second = await app.inject({ method: 'POST', url: '/verifications/', headers, payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM } });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe('ver-1');
  });

  it('same key + different provider → 409', async () => {
    mockPrisma.verification.findFirst.mockResolvedValue(row({ idempotencyKey: 'k-2', provider: 'demo' }));
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: { ...AUTH, 'idempotency-key': 'k-2' },
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM, provider: 'gmail' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('API key without scope → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: { 'x-test-org': 'org-1', 'x-test-key-permissions': 'verification:read' },
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM },
    });
    expect(res.statusCode).toBe(403);
    expect(mockPrisma.verification.create).not.toHaveBeenCalled();
  });

  it('API key with canonical scope → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: { 'x-test-org': 'org-1', 'x-test-key-permissions': 'verification:create' },
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM },
    });
    expect(res.statusCode).toBe(201);
  });

  it('API key with legacy permissions → 201 (backward compatible)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: { 'x-test-org': 'org-1', 'x-test-key-permissions': 'verify:email,read:history' },
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM },
    });
    expect(res.statusCode).toBe(201);
  });

  it('every response carries the request ID', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/verifications/',
      headers: { ...AUTH, 'x-request-id': 'req-abc-123' },
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM },
    });
    expect(created.headers['x-request-id']).toBe('req-abc-123');
    const rejected = await app.inject({
      method: 'POST',
      url: '/verifications/',
      payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.headers['x-request-id']).toBeDefined();
  });
});

describe('POST /verifications rate limit', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPrisma.agent.findFirst.mockResolvedValue({ id: 'cmutwgqxp001sclev4c73dre2', organizationId: 'org-1' });
    mockPrisma.verification.findFirst.mockResolvedValue(null);
    mockPrisma.verification.create.mockImplementation((args: unknown) =>
      Promise.resolve(row((args as { data: Record<string, unknown> }).data))
    );
    mockPrisma.auditLog.create.mockResolvedValue({});
    app = await buildApp(true);
  });

  afterEach(async () => {
    await app.close();
  });

  it('31st request in a minute → 429 with the error contract', async () => {
    let lastStatus = 0;
    let lastBody = '';
    const seen: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/verifications/',
        headers: AUTH,
        payload: { agentId: 'cmutwgqxp001sclev4c73dre2', claim: CLAIM },
      });
      seen.push(res.statusCode);
      lastStatus = res.statusCode;
      lastBody = res.body;
    }
    expect(seen.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(lastStatus).toBe(429);
    const body = JSON.parse(lastBody) as { error: string; requestId?: string };
    expect(body.error).toBe('Too Many Requests');
    expect(body.requestId).toBeDefined();
  });
});

describe('GET /verifications/:id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('unauthenticated request → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/verifications/ver-1' });
    expect(res.statusCode).toBe(401);
  });

  it('own verification → 200 with provider', async () => {
    mockPrisma.verification.findFirst.mockResolvedValue(row());
    const res = await app.inject({ method: 'GET', url: '/verifications/ver-1', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { provider: string }).provider).toBe('demo');
  });

  it('foreign verification → 404', async () => {
    mockPrisma.verification.findFirst.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/verifications/ver-9', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

