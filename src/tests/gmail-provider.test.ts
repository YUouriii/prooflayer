import { describe, it, expect, beforeEach } from 'vitest';
import { GmailEvidenceProvider } from '../integrations/gmail/provider.js';
import { REQUIRED_EMAIL_SENT_CHECKS, evaluateEvidence } from '../verification/engine.js';
import type { EmailSentClaim } from '../verification/types.js';
import { GmailAuthError, GmailRateLimitError } from '../integrations/gmail/errors.js';
import { FakeGmailApi, FakeGmailStore, FakeOAuthClient, sentMessage } from './gmail-fakes.js';

const CLAIM: EmailSentClaim = {
  type: 'email_sent',
  recipient: 'john@example.com',
  subject: 'Invoice #4821',
  attachment: 'invoice.pdf',
};

describe('GmailEvidenceProvider', () => {
  let store: FakeGmailStore;
  let oauth: FakeOAuthClient;
  let api: FakeGmailApi;
  let provider: GmailEvidenceProvider;

  beforeEach(() => {
    store = new FakeGmailStore();
    oauth = new FakeOAuthClient();
    api = new FakeGmailApi([sentMessage()]);
    store.addConnected({ organizationId: 'org-1', email: 'me@gmail.com' });
    provider = new GmailEvidenceProvider({ store, oauth, gmailApiFor: () => api });
  });

  it('supports email_sent only', () => {
    expect(provider.supports(CLAIM)).toBe(true);
    expect(provider.supports({ type: 'sms' } as unknown as EmailSentClaim)).toBe(false);
  });

  it('matching mailbox message → all PASS (engine VERIFIED)', async () => {
    const items = await provider.collect(CLAIM, { organizationId: 'org-1' });
    expect(items).toHaveLength(5);
    expect(items.every((i) => i.result === 'PASS')).toBe(true);
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('VERIFIED');
  });

  it('absent message → FAIL (confident absence, engine FAILED)', async () => {
    const items = await provider.collect(
      { ...CLAIM, recipient: 'nobody@example.com', subject: 'Totally Unknown Subject XYZ' },
      { organizationId: 'org-1' }
    );
    expect(items.find((i) => i.type === 'message_exists')?.result).toBe('FAIL');
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('FAILED');
  });

  it('unknown recipient with known subject → recipient FAIL (subject fallback still rejects)', async () => {
    const items = await provider.collect({ ...CLAIM, recipient: 'nobody@example.com' }, { organizationId: 'org-1' });
    expect(items.find((i) => i.type === 'recipient_match')?.result).toBe('FAIL');
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('FAILED');
  });

  it('subject mismatch → subject FAIL with observed value', async () => {
    const items = await provider.collect({ ...CLAIM, subject: 'Other' }, { organizationId: 'org-1' });
    const subject = items.find((i) => i.type === 'subject_match');
    expect(subject?.result).toBe('FAIL');
    expect(subject?.observed).toBe('Invoice #4821');
  });

  it('missing attachment → attachment FAIL', async () => {
    const items = await provider.collect({ ...CLAIM, attachment: 'missing.pdf' }, { organizationId: 'org-1' });
    expect(items.find((i) => i.type === 'attachment_present')?.result).toBe('FAIL');
  });

  it('no connected accounts → all UNKNOWN (never FALSE)', async () => {
    const items = await provider.collect(CLAIM, { organizationId: 'org-empty' });
    expect(items.every((i) => i.result === 'UNKNOWN')).toBe(true);
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('INCONCLUSIVE');
  });

  it('missing organization context → all UNKNOWN', async () => {
    const items = await provider.collect(CLAIM);
    expect(items.every((i) => i.result === 'UNKNOWN')).toBe(true);
  });

  it('revoked accounts are skipped', async () => {
    store.addConnected({ organizationId: 'org-1', email: 'old@gmail.com', status: 'REVOKED' });
    const items = await provider.collect(CLAIM, { organizationId: 'org-1' });
    expect(items.every((i) => i.result === 'PASS')).toBe(true);
  });

  it('API failure → UNKNOWN and account marked ERROR', async () => {
    api.failList = new GmailRateLimitError('slow down');
    const items = await provider.collect(CLAIM, { organizationId: 'org-1' });
    expect(items.every((i) => i.result === 'UNKNOWN')).toBe(true);
    expect(store.marks).toContainEqual(expect.objectContaining({ status: 'ERROR' }));
  });

  it('auth failure → UNKNOWN and account marked REVOKED', async () => {
    api.failList = new GmailAuthError('invalid_grant');
    const items = await provider.collect(CLAIM, { organizationId: 'org-1' });
    expect(items.every((i) => i.result === 'UNKNOWN')).toBe(true);
    expect(store.marks).toContainEqual(expect.objectContaining({ status: 'REVOKED' }));
  });

  it('expired access token is refreshed and persisted', async () => {
    store.accounts[0].expiresAt = new Date(Date.now() - 1000);
    oauth.refreshed.set('refresh-token', { accessToken: 'fresh-token', expiryDate: Date.now() + 3600_000 });
    const items = await provider.collect(CLAIM, { organizationId: 'org-1' });
    expect(oauth.refreshCalls).toContain('refresh-token');
    expect(store.updatedTokens).toContainEqual(expect.objectContaining({ accessToken: 'fresh-token' }));
    expect(items.every((i) => i.result === 'PASS')).toBe(true);
  });

  it('failed refresh marks REVOKED and yields UNKNOWN', async () => {
    store.accounts[0].expiresAt = new Date(Date.now() - 1000);
    oauth.refreshError = new GmailAuthError('invalid_grant: revoked');
    const items = await provider.collect(CLAIM, { organizationId: 'org-1' });
    expect(store.marks).toContainEqual(expect.objectContaining({ status: 'REVOKED' }));
    expect(items.every((i) => i.result === 'UNKNOWN')).toBe(true);
  });

  it('conflicting candidates surface contradiction for the engine', async () => {
    api = new FakeGmailApi([
      sentMessage({ id: 'a', to: ['john@example.com'], subject: 'Invoice #4821' }),
      sentMessage({ id: 'b', to: ['john@example.com'], subject: 'Quarterly Report' }),
    ]);
    provider = new GmailEvidenceProvider({ store, oauth, gmailApiFor: () => api });
    const items = await provider.collect(CLAIM, { organizationId: 'org-1' });
    const subjects = items.filter((i) => i.type === 'subject_match').map((i) => i.result).sort();
    expect(subjects).toEqual(['FAIL', 'PASS']);
    const outcome = evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.confidence).toBe(0.75);
  });

  it('is deterministic for identical mailbox state', async () => {
    const a = await provider.collect(CLAIM, { organizationId: 'org-1' });
    const b = await provider.collect({ ...CLAIM }, { organizationId: 'org-1' });
    expect(b).toEqual(a);
  });

  it('tags every item with the gmail source', async () => {
    const items = await provider.collect(CLAIM, { organizationId: 'org-1' });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.source === 'gmail')).toBe(true);
  });
});
