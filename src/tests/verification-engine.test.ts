import { describe, it, expect } from 'vitest';
import { REQUIRED_EMAIL_SENT_CHECKS, evaluateEvidence } from '../verification/engine.js';
import type { EvidenceItem } from '../verification/types.js';

function pass(type: string): EvidenceItem {
  return { type, expected: 'x', observed: 'x', result: 'PASS' };
}

function fail(type: string, expected = 'x', observed = 'y'): EvidenceItem {
  return { type, expected, observed, result: 'FAIL' };
}

function unknown(type: string): EvidenceItem {
  return { type, expected: 'x', observed: null, result: 'UNKNOWN' };
}

const ALL_PASS = REQUIRED_EMAIL_SENT_CHECKS.map(pass);

describe('evaluateEvidence', () => {
  it('all required checks PASS → VERIFIED with 0.98 confidence', () => {
    const out = evaluateEvidence(ALL_PASS, REQUIRED_EMAIL_SENT_CHECKS);
    expect(out.status).toBe('VERIFIED');
    expect(out.confidence).toBe(0.98);
    expect(out.reason).toContain('All 5 required checks passed');
  });

  it('any required check FAIL → FAILED with 0.9 confidence', () => {
    const items = [...REQUIRED_EMAIL_SENT_CHECKS.map(pass)];
    items[0] = fail('message_exists', 'jane@example.com', null);
    const out = evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS);
    expect(out.status).toBe('FAILED');
    expect(out.confidence).toBe(0.9);
  });

  it('recipient mismatch → FAILED and names the check', () => {
    const items = ALL_PASS.map((i) => (i.type === 'recipient_match' ? fail(i.type, 'jane@example.com', 'john@example.com') : i));
    const out = evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS);
    expect(out.status).toBe('FAILED');
    expect(out.reason).toContain('recipient_match');
    expect(out.reason).toContain('jane@example.com');
  });

  it('subject mismatch → FAILED', () => {
    const items = ALL_PASS.map((i) => (i.type === 'subject_match' ? fail(i.type, 'Wrong', 'Invoice #4821') : i));
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('FAILED');
  });

  it('missing required attachment → FAILED', () => {
    const items = ALL_PASS.map((i) =>
      i.type === 'attachment_present' ? fail(i.type, 'missing.pdf', 'invoice.pdf') : i
    );
    expect(evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS).status).toBe('FAILED');
  });

  it('UNKNOWN evidence with no failures → INCONCLUSIVE with 0.5 confidence', () => {
    const items = REQUIRED_EMAIL_SENT_CHECKS.map(unknown);
    const out = evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS);
    expect(out.status).toBe('INCONCLUSIVE');
    expect(out.confidence).toBe(0.5);
  });

  it('missing required check entirely → INCONCLUSIVE', () => {
    const items = ALL_PASS.filter((i) => i.type !== 'sent_status');
    const out = evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS);
    expect(out.status).toBe('INCONCLUSIVE');
    expect(out.reason).toContain('sent_status');
  });

  it('contradictory evidence (PASS + FAIL on same check) → FAILED with 0.75', () => {
    const items = [...ALL_PASS, fail('sent_status', 'sent', 'draft')];
    const out = evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS);
    expect(out.status).toBe('FAILED');
    expect(out.confidence).toBe(0.75);
    expect(out.reason).toContain('Contradictory');
  });

  it('contradiction wins over an unrelated failure', () => {
    const items = ALL_PASS.map((i) => (i.type === 'subject_match' ? fail(i.type) : i));
    items.push(fail('sent_status'));
    const out = evaluateEvidence(items, REQUIRED_EMAIL_SENT_CHECKS);
    expect(out.status).toBe('FAILED');
    expect(out.confidence).toBe(0.75);
  });

  it('is deterministic for identical inputs', () => {
    const a = evaluateEvidence(ALL_PASS, REQUIRED_EMAIL_SENT_CHECKS);
    const b = evaluateEvidence([...ALL_PASS.map((i) => ({ ...i }))], REQUIRED_EMAIL_SENT_CHECKS);
    expect(b).toEqual(a);
  });
});
