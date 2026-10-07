/**
 * Deterministic verification rules.
 *
 * The engine evaluates structured evidence and derives the verdict.
 * It never trusts a provider-supplied status — only the evidence items.
 *
 * Rules for an `email_sent` claim (in evaluation order):
 *
 * 1. CONTRADICTION → FAILED
 *    Two evidence items for the same check disagree (one PASS, one FAIL),
 *    e.g. two sources report different send states. Contradictory evidence
 *    means the claim cannot be confirmed. Confidence 0.75.
 *
 * 2. REQUIRED CHECK FAILED → FAILED
 *    Any required check with result FAIL rejects the claim
 *    (recipient mismatch, subject mismatch, missing message,
 *    missing attachment, not-sent status). Confidence 0.9.
 *
 * 3. MISSING / UNKNOWN EVIDENCE → INCONCLUSIVE
 *    A required check is absent or UNKNOWN, and nothing above fired.
 *    The provider could not establish enough facts either way.
 *    Confidence 0.5.
 *
 * 4. ALL REQUIRED CHECKS PASS → VERIFIED. Confidence 0.98.
 *
 * No LLM, no randomness: identical evidence always yields the same verdict.
 */
import type { EvaluationOutcome, EvidenceItem, VerificationStatus } from './types.js';

/** Checks every `email_sent` verification must account for. */
export const REQUIRED_EMAIL_SENT_CHECKS: readonly string[] = [
  'message_exists',
  'recipient_match',
  'subject_match',
  'attachment_present',
  'sent_status',
];

export const CONFIDENCE: Record<VerificationStatus, number> = {
  VERIFIED: 0.98,
  FAILED: 0.9,
  INCONCLUSIVE: 0.5,
};

export const CONTRADICTION_CONFIDENCE = 0.75;

function findContradiction(items: EvidenceItem[]): EvidenceItem | null {
  const byType = new Map<string, Set<string>>();
  for (const item of items) {
    const seen = byType.get(item.type) ?? new Set<string>();
    seen.add(item.result);
    byType.set(item.type, seen);
  }
  for (const [type, results] of byType) {
    if (results.has('PASS') && results.has('FAIL')) {
      return items.find((i) => i.type === type) ?? null;
    }
  }
  return null;
}

export function evaluateEvidence(items: EvidenceItem[], required: readonly string[]): EvaluationOutcome {
  const contradiction = findContradiction(items);
  if (contradiction) {
    return {
      status: 'FAILED',
      confidence: CONTRADICTION_CONFIDENCE,
      reason: `Contradictory evidence for check '${contradiction.type}': independent sources disagree, so the claim cannot be confirmed.`,
    };
  }

  const byType = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    const list = byType.get(item.type) ?? [];
    list.push(item);
    byType.set(item.type, list);
  }

  for (const check of required) {
    const found = byType.get(check);
    if (!found || found.length === 0) {
      return {
        status: 'INCONCLUSIVE',
        confidence: CONFIDENCE.INCONCLUSIVE,
        reason: `Missing evidence for required check '${check}': not enough facts to verify or reject the claim.`,
      };
    }
    const failed = found.find((i) => i.result === 'FAIL');
    if (failed) {
      const detail = describeFailure(failed);
      return {
        status: 'FAILED',
        confidence: CONFIDENCE.FAILED,
        reason: `Check '${check}' failed: ${detail}`,
      };
    }
    if (found.every((i) => i.result === 'UNKNOWN')) {
      return {
        status: 'INCONCLUSIVE',
        confidence: CONFIDENCE.INCONCLUSIVE,
        reason: `Check '${check}' is unknown: the provider could not establish the facts.`,
      };
    }
  }

  return {
    status: 'VERIFIED',
    confidence: CONFIDENCE.VERIFIED,
    reason: `All ${required.length} required checks passed.`,
  };
}

function describeFailure(item: EvidenceItem): string {
  const expected = item.expected ?? '(no expectation)';
  const observed = item.observed ?? '(nothing observed)';
  const base = `expected '${expected}', observed '${observed}'`;
  return item.detail ? `${base} (${item.detail})` : base;
}
