import { describe, it, expect } from 'vitest';
import fastify from 'fastify';
import { readFileSync } from 'node:fs';

describe('trust proxy configuration', () => {
  it('production app trusts the platform reverse proxy', () => {
    // Guards src/main.ts wiring: without this, req.ip behind Render is the
    // proxy address and rate limiting + audit IPs silently break.
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/trustProxy:\s*true/);
  });

  it('recognizes the X-Forwarded-For client IP when trust is enabled', async () => {
    const app = fastify({ trustProxy: true });
    app.get('/whoami', async (request) => ({ ip: request.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ip: string }).ip).toBe('203.0.113.7');
    await app.close();
  });

  it('does not trust the header without the option (documents the default)', async () => {
    const app = fastify();
    app.get('/whoami', async (request) => ({ ip: request.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect((res.json() as { ip: string }).ip).not.toBe('203.0.113.7');
    await app.close();
  });
});
