import { describe, it, expect } from 'vitest';
import { DemoEvidenceProvider } from '../verification/providers.js';
import { REQUIRED_EMAIL_SENT_CHECKS, evaluateEvidence } from '../verification/engine.js';
import type { EmailSentClaim } from '../verification/types.js';

const BASE_CLAIM: EmailSentClaim = {
  type: 'email_sent',
  recipient: 'john@example.com',
  subject: 'Invoice #4821',
  attachment: 'invoice.pdf',
};

describe('DemoEvidenceProvider', () => {
  const provider = new DemoEvidenceProvider();

  it('supports email_sent claims only', () => {
    expect(provider.supports(BASE_CLAIM)).toBe(true);
    expect(provider.supports({ type: 'other' } as unknown as EmailSentClaim)).toBe(false);
  });

  it('exact mailbox claim → all checks PASS (→ VERIFIED)', async () => {
    const items = await provider.collect(BASE_CLAIM);
    expect(items).toHaveLength(5);
    expect(items.every((i) => i.result === 'PASS')).toBe(true);
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('VERIFIED');
  });

  it('unknown recipient → message_exists FAIL (→ FAILED)', async () => {
    const items = await provider.collect({ ...BASE_CLAIM, recipient: 'jane@example.com' });
    const exists = items.find((i) => i.type === 'message_exists');
    expect(exists?.result).toBe('FAIL');
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('FAILED');
  });

  it('ghost recipient → all UNKNOWN (→ INCONCLUSIVE)', async () => {
    const items = await provider.collect({ ...BASE_CLAIM, recipient: 'ghost@example.com' });
    expect(items.every((i) => i.result === 'UNKNOWN')).toBe(true);
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('INCONCLUSIVE');
  });

  it('wrong subject → subject_match FAIL with observed mailbox value', async () => {
    const items = await provider.collect({ ...BASE_CLAIM, subject: 'Wrong subject' });
    const subject = items.find((i) => i.type === 'subject_match');
    expect(subject?.result).toBe('FAIL');
    expect(subject?.observed).toBe('Invoice #4821');
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('FAILED');
  });

  it('missing attachment → attachment_present FAIL', async () => {
    const items = await provider.collect({ ...BASE_CLAIM, attachment: 'missing.pdf' });
    expect(items.find((i) => i.type === 'attachment_present')?.result).toBe('FAIL');
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('FAILED');
  });

  it('omitted attachment → attachment check PASS (nothing expected)', async () => {
    const { attachment: _omitted, ...noAttachment } = BASE_CLAIM;
    const items = await provider.collect(noAttachment);
    expect(items.find((i) => i.type === 'attachment_present')?.result).toBe('PASS');
  });

  it('CONTRADICT marker → disagreeing sent_status items (→ FAILED as contradiction)', async () => {
    const items = await provider.collect({ ...BASE_CLAIM, subject: 'Invoice CONTRADICT #4821' });
    const sent = items.filter((i) => i.type === 'sent_status');
    expect(sent.map((i) => i.result).sort()).toEqual(['FAIL', 'PASS']);
    const out = evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS);
    expect(out.status).toBe('FAILED');
    expect(out.confidence).toBe(0.75);
  });

  it('is deterministic for identical inputs', async () => {
    const a = await provider.collect(BASE_CLAIM);
    const b = await provider.collect({ ...BASE_CLAIM });
    expect(b).toEqual(a);
  });

  it('tags every item with the demo source', async () => {
    const items = await provider.collect(BASE_CLAIM);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.source === 'demo')).toBe(true);
  });
});
