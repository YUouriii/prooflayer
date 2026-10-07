import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import pino from 'pino';
import publicDemoRoutes from '../routes/public-demo.js';
import requestIdPlugin from '../plugins/request-id.js';

async function buildApp(withRateLimit = false): Promise<FastifyInstance> {
  // Mirror production validation behavior (see main.ts): unknown body
  // fields are stripped before handlers run.
  const app = fastify({ ajv: { customOptions: { coerceTypes: 'array', removeAdditional: 'all' } } });
  app.decorate('logger', pino({ level: 'silent' }));
  await app.register(requestIdPlugin);
  if (withRateLimit) {
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute', keyGenerator: () => 'public-demo-suite' });
  }
  await app.register(publicDemoRoutes, { prefix: '/api/v1/demo' });
  return app;
}

describe('POST /api/v1/demo/verify', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('verified scenario → VERIFIED 0.98 with 5 PASS checks', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/demo/verify', payload: { scenario: 'verified' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; confidence: number; evidence: { result: string }[]; provider: string };
    expect(body.status).toBe('VERIFIED');
    expect(body.confidence).toBe(0.98);
    expect(body.provider).toBe('demo');
    expect(body.evidence).toHaveLength(5);
    expect(body.evidence.every((e) => e.result === 'PASS')).toBe(true);
  });

  it('failed scenario → FAILED', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/demo/verify', payload: { scenario: 'failed' } });
    expect((res.json() as { status: string }).status).toBe('FAILED');
  });

  it('inconclusive scenario → INCONCLUSIVE 0.5', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/demo/verify', payload: { scenario: 'inconclusive' } });
    const body = res.json() as { status: string; confidence: number };
    expect(body.status).toBe('INCONCLUSIVE');
    expect(body.confidence).toBe(0.5);
  });

  it('contradiction scenario → FAILED with contradiction confidence', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/demo/verify', payload: { scenario: 'contradiction' } });
    const body = res.json() as { status: string; confidence: number };
    expect(body.status).toBe('FAILED');
    expect(body.confidence).toBe(0.75);
  });

  it('unknown scenario → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/demo/verify', payload: { scenario: 'gmail' } });
    expect(res.statusCode).toBe(400);
  });

  it('injected arbitrary claim is ignored, fixed scenario runs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/verify',
      payload: { scenario: 'verified', claim: { type: 'email_sent', recipient: 'x@y.zz', subject: 's' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; claim: { recipient: string } };
    expect(body.status).toBe('VERIFIED');
    expect(body.claim.recipient).toBe('john@example.com');
  });

  it('injected provider is ignored, demo evidence is used', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/verify',
      payload: { scenario: 'verified', provider: 'gmail' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; provider: string };
    expect(body.provider).toBe('demo');
    expect(body.status).toBe('VERIFIED');
  });

  it('exposes no organization internals', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/demo/verify', payload: { scenario: 'verified' } });
    const blob = res.body.toLowerCase();
    expect(blob).not.toContain('organizationid');
    expect(blob).not.toContain('apikey');
  });

  it('works with no authentication at all', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/demo/verify', payload: { scenario: 'verified' } });
    expect([200, 429]).toContain(res.statusCode);
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/v1/demo/verify rate limit', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(true);
  });

  afterEach(async () => {
    await app.close();
  });

  it('11th request in a minute → 429', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/demo/verify', payload: { scenario: 'verified' } });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});
