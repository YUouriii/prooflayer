import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const HTML_PATH = new URL('../../public/index.html', import.meta.url);

function html(): string {
  return readFileSync(HTML_PATH, 'utf8');
}

describe('public homepage', () => {
  it('is self-contained with responsive metadata', () => {
    const page = html();
    expect(page.length).toBeGreaterThan(5000);
    expect(page).not.toMatch(/src="http/i);
    expect(page).not.toMatch(/href="http/i);
    expect(page).toContain('name="viewport"');
  });

  it('covers the required sections', () => {
    const page = html();
    for (const token of [
      'prove it', 'How it works', 'Try it', 'Built for developers',
      '/api/v1/verifications', '/docs', 'Gmail', 'Organization isolation',
    ]) {
      expect(page).toContain(token);
    }
  });

  it('offers exactly the four fixed demo scenarios', () => {
    const page = html();
    for (const scenario of ['verified', 'failed', 'inconclusive', 'contradiction']) {
      expect(page).toContain(`data-scenario="${scenario}"`);
    }
  });

  it('fetches only the anonymous public demo endpoint', () => {
    const page = html();
    expect(page).toContain('/api/v1/demo/verify');
    const fetches = [...page.matchAll(/fetch\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    expect(fetches.length).toBeGreaterThan(0);
    for (const url of fetches) {
      expect(url).toBe('/api/v1/demo/verify');
    }
    // No live credential is ever attached to requests (the API-example code
    // block documents the header shape for developers; it is not executed).
    expect(page).not.toMatch(/headers:\s*\{[^}]*Authorization/i);
    expect(page).not.toMatch(/Bearer \+ /);
  });

  it('distinguishes live Gmail from planned integrations honestly', () => {
    const page = html();
    expect(page).toContain('live');
    for (const planned of ['GitHub — planned', 'Slack — planned', 'Stripe — planned']) {
      expect(page).toContain(planned);
    }
  });

  it('contains no fake social proof or secrets', () => {
    const page = html().toLowerCase();
    for (const fake of ['testimonial', 'trusted by', 'customers', 'loved by', 'pl_live_', 'ya29', 'gocspx']) {
      expect(page).not.toContain(fake);
    }
    expect(page).not.toContain('console.log');
    expect(page).not.toMatch(/localstorage|sessionstorage/i);
  });

  it('respects reduced-motion preferences', () => {
    expect(html()).toContain('prefers-reduced-motion');
  });
});
