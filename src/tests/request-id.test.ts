import { describe, it, expect, afterEach, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import pino from 'pino';
import requestIdPlugin, { normalizeRequestId } from '../plugins/request-id.js';

describe('normalizeRequestId', () => {
  it('accepts a well-formed client ID', () => {
    expect(normalizeRequestId('order-123_ABC')).toBe('order-123_ABC');
  });

  it('replaces missing, empty, and malformed IDs', () => {
    for (const bad of [undefined, null, '', 'has spaces', 'x'.repeat(65), 'semi;colon', '<script>']) {
      const id = normalizeRequestId(bad);
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$|^[0-9a-f-]{36}$/);
    }
  });

  it('generates unique IDs', () => {
    expect(normalizeRequestId(undefined)).not.toBe(normalizeRequestId(undefined));
  });
});

describe('request ID plugin', () => {
  let app: FastifyInstance;
  const lines: string[] = [];

  async function buildApp(): Promise<FastifyInstance> {
    const stream = { write: (chunk: string): void => void lines.push(chunk) };
    const instance = fastify();
    // Mirrors production wiring (loggerPlugin decorates fastify.logger).
    instance.decorate('logger', pino({ level: 'info' }, stream as never));
    await instance.register(requestIdPlugin);
    instance.post('/echo', async (request) => ({ ok: true }));
    await instance.ready();
    return instance;
  }

  afterEach(async () => {
    lines.length = 0;
    vi.clearAllMocks();
    if (app) await app.close();
  });

  it('echoes a valid client request ID in the response', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { 'x-request-id': 'agent-run-42' }, payload: {} });
    expect(res.headers['x-request-id']).toBe('agent-run-42');
  });

  it('assigns a fresh ID when the client value is invalid', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { 'x-request-id': 'no good!' }, payload: {} });
    const echoed = res.headers['x-request-id'] as string;
    expect(echoed).toBeDefined();
    expect(echoed).not.toBe('no good!');
  });

  it('logs operational fields without secrets', async () => {
    app = await buildApp();
    const secret = 'pl_live_supersecretvalue123';
    await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'x-request-id': 'log-check-1', authorization: `Bearer ${secret}`, cookie: 'session=abc123' },
      payload: { password: 'hunter2' },
    });
    expect(lines.length).toBeGreaterThan(0);
    const blob = lines.join('\n');
    expect(blob).toContain('log-check-1');
    expect(blob).toContain('/echo');
    for (const leaked of [secret, 'hunter2', 'abc123', 'authorization', 'cookie', 'password']) {
      expect(blob).not.toContain(leaked);
    }
    const logged = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    for (const field of ['requestId', 'method', 'url', 'statusCode', 'durationMs']) {
      expect(logged[field], `log field ${field}`).toBeDefined();
    }
    expect(logged.requestId).toBe('log-check-1');
  });
});
