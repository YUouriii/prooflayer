import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const HTML_PATH = new URL('../../public/demo.html', import.meta.url);

function html(): string {
  return readFileSync(HTML_PATH, 'utf8');
}

describe('demo client page', () => {
  it('exists and is served as a single self-contained page', () => {
    const page = html();
    expect(page.length).toBeGreaterThan(1000);
    expect(page).not.toMatch(/src="http/i);
    expect(page).not.toMatch(/href="http/i);
  });

  it('targets the real verification API endpoints', () => {
    const page = html();
    expect(page).toContain('/api/v1/verifications/');
    expect(page).toContain('/api/v1/auth/login');
    expect(page).toContain('/api/v1/agents/');
  });

  it('contains all three demo scenarios with the specified values', () => {
    const page = html();
    expect(page).toContain('john@example.com');
    expect(page).toContain('Invoice #4821');
    expect(page).toContain('invoice.pdf');
    expect(page).toContain('jane@example.com');
    expect(page).toContain('ghost@example.com');
  });

  it('renders status, confidence, reason, and evidence separately', () => {
    const page = html();
    for (const token of ['VERIFIED', 'FAILED', 'INCONCLUSIVE']) {
      expect(page).toContain(token);
    }
    expect(page).toContain('rConf');
    expect(page).toContain('rReason');
    expect(page).toContain('rClaim');
    expect(page).toContain('rEvidence');
  });

  it('handles 400, 401, 404, and 500 responses', () => {
    const page = html();
    for (const code of ['400', '401', '404', '500']) {
      expect(page).toContain(code);
    }
  });

  it('never persists or echoes API secrets', () => {
    const page = html();
    expect(page).not.toMatch(/localStorage/i);
    expect(page).not.toMatch(/sessionStorage/i);
    expect(page).not.toContain('console.log');
  });

  it('verification request carries no email field and declares the demo provider', () => {
    const page = html();
    const verifyBlock = page.slice(page.indexOf("$('verifyBtn')"), page.indexOf("$('retrieveBtn')"));
    expect(verifyBlock).not.toMatch(/\bemail\s*:/);
    expect(verifyBlock).toContain("provider: 'demo'");
    expect(verifyBlock).toContain('agentId');
    expect(verifyBlock).toContain("type: 'email_sent'");
    expect(verifyBlock).toContain('recipient');
    expect(verifyBlock).toContain('subject');
    expect(verifyBlock).toContain('attachment');
  });

  it('authenticates verification requests with a Bearer API key from page memory', () => {
    const page = html();
    expect(page).toContain("'Authorization'] = 'Bearer ' + apiKey");
    expect(page).toContain('credentials');
  });

  it('labels every failure with the endpoint that produced it', () => {
    const page = html();
    for (const label of [
      'POST /api/v1/auth/login',
      'GET /api/v1/agents/',
      'POST /api/v1/verifications/',
      'GET /api/v1/verifications/:id',
    ]) {
      expect(page).toContain(label);
    }
  });

  it('guards session login against an empty email before any request', () => {
    const page = html();
    const loginBlock = page.slice(page.indexOf("$('loginBtn')"), page.indexOf("$('loadAgentsBtn')"));
    expect(loginBlock).toMatch(/Enter a valid email address/);
    expect(loginBlock).toContain('no request was sent');
  });

  it('session login flow still posts email and password with cookies', () => {
    const page = html();
    expect(page).toContain("body: JSON.stringify({ email: email, password: $('password').value })");
    expect(page).toContain("credentials: 'include'");
  });
});
