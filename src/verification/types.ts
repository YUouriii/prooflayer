/**
 * Verification domain types.
 *
 * A verification = an agent's claim that an external action occurred,
 * plus independently collected evidence, plus the engine's verdict.
 *
 * The engine works only with these types. It never knows which
 * EvidenceProvider produced the evidence (demo, Gmail, Slack, ...).
 */

export const VERIFICATION_STATUSES = ['VERIFIED', 'FAILED', 'INCONCLUSIVE'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const EVIDENCE_RESULTS = ['PASS', 'FAIL', 'UNKNOWN'] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

/** Claim that an email was sent. More claim kinds can extend this union later. */
export interface EmailSentClaim {
  type: 'email_sent';
  recipient: string;
  subject: string;
  /** Expected attachment filename. Absent = no attachment expected. */
  attachment?: string;
}

export type Claim = EmailSentClaim;

/**
 * One structured piece of evidence.
 * `expected` = what the claim asserts, `observed` = what the external
 * system actually shows (null when nothing was observed).
 */
export interface EvidenceItem {
  /** Machine-readable check name, e.g. 'recipient_match'. */
  type: string;
  expected?: string;
  observed?: string | null;
  result: EvidenceResult;
  detail?: string;
  /** Evidence source that produced this item, e.g. 'demo' or 'gmail'. */
  source?: string;
}

/** Engine verdict derived from evidence (never blindly trusted from a provider). */
export interface EvaluationOutcome {
  status: VerificationStatus;
  /** Human-readable explanation of why this status was reached. */
  reason: string;
  /** Deterministic confidence: VERIFIED 0.98, FAILED 0.9 (0.75 on contradiction), INCONCLUSIVE 0.5. */
  confidence: number;
}

/** Full verification result returned by the API. */
export interface VerificationResult {
  id: string;
  organizationId: string;
  agentId: string;
  /** Evidence source that produced this verification, e.g. 'demo' or 'gmail'. */
  provider: string;
  actionType: string;
  claim: Claim;
  status: VerificationStatus;
  confidence: number;
  reason: string;
  evidence: EvidenceItem[];
  createdAt: Date;
  verifiedAt: Date;
}
