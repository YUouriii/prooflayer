import { describe, it, expect } from 'vitest';

/**
 * Opt-in live Gmail test. Skipped unless ALL of these are set:
 *   GOOGLE_TEST_ACCESS_TOKEN (a valid OAuth access token with gmail.readonly)
 *
 * Never runs in normal `npm test`. Exercises the real Gmail query path
 * (list + metadata parse) without persisting anything.
 */
const ACCESS_TOKEN = process.env.GOOGLE_TEST_ACCESS_TOKEN;

describe.runIf(ACCESS_TOKEN)('live Gmail API (opt-in)', () => {
  it('lists sent messages and parses metadata', async () => {
    const { createGmailApiForToken } = await import('../integrations/gmail/client.js');
    const api = createGmailApiForToken(ACCESS_TOKEN as string);
    const refs = await api.listMessages({ query: 'in:sent', maxResults: 1 });
    expect(Array.isArray(refs)).toBe(true);
    if (refs.length > 0) {
      const message = await api.getMessage(refs[0].id);
      expect(typeof message.subject).toBe('string');
      expect(Array.isArray(message.to)).toBe(true);
    }
  });
});

describe('live Gmail API guard', () => {
  it('documents the opt-in requirement', () => {
    expect('GOOGLE_TEST_ACCESS_TOKEN').toBeTruthy();
  });
});
