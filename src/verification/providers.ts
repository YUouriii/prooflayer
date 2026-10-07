/**
 * Evidence provider abstraction.
 *
 * The verification engine calls `collect(claim)` and evaluates the returned
 * evidence items. It never knows whether the evidence came from the demo
 * mailbox, Gmail, Slack, GitHub, or any other system.
 *
 * To add a real integration (e.g. Gmail), implement this interface and
 * return the same EvidenceItem shapes for the claim type — the engine,
 * database, API, and audit layers stay untouched.
 */
import type { Claim, EvidenceItem } from './types.js';

export interface EvidenceProvider {
  /** Stable provider name, persisted implicitly via evidence details. */
  readonly name: string;
  /** Whether this provider can collect evidence for the given claim. */
  supports(claim: Claim): boolean;
  /**
   * Collect structured evidence for the claim. Must be deterministic
   * for identical inputs. Providers needing organization-scoped resources
   * (e.g. connected Gmail accounts) receive them via `context`.
   */
  collect(claim: Claim, context?: EvidenceContext): Promise<EvidenceItem[]>;
}

/** Organization context handed to providers that need scoped resources. */
export interface EvidenceContext {
  organizationId: string;
}

interface DemoSentMessage {
  to: string;
  subject: string;
  attachments: string[];
  sent: boolean;
}

/**
 * Deterministic demo provider simulating a sent mailbox.
 *
 * Mailbox contents (fixed):
 *   to: john@example.com, subject: 'Invoice #4821',
 *   attachments: ['invoice.pdf'], sent: true
 *
 * Content-driven scenarios (same input → same output, no randomness):
 * - Claim matches the mailbox message exactly → all checks PASS.
 * - Different recipient/subject/attachment → that check FAILs
 *   (observed values echo what the mailbox actually holds).
 * - Recipient `ghost@example.com` → every check UNKNOWN (the provider
 *   cannot establish any facts → INCONCLUSIVE).
 * - Any other unknown recipient → `message_exists` FAILs
 *   (the provider can establish the message is absent → FAILED).
 * - Subject containing the marker word `CONTRADICT` → the provider emits
 *   two disagreeing `sent_status` items, simulating conflicting sources.
 */
export class DemoEvidenceProvider implements EvidenceProvider {
  readonly name = 'demo';

  private static readonly MAILBOX: DemoSentMessage[] = [
    {
      to: 'john@example.com',
      subject: 'Invoice #4821',
      attachments: ['invoice.pdf'],
      sent: true,
    },
  ];

  /** Recipient for which the provider cannot establish any facts. */
  static readonly UNKNOWN_RECIPIENT = 'ghost@example.com';
  /** Subject marker that simulates conflicting evidence sources. */
  static readonly CONTRADICTION_MARKER = 'CONTRADICT';

  supports(claim: Claim): boolean {
    return claim.type === 'email_sent';
  }

  async collect(claim: Claim): Promise<EvidenceItem[]> {
    if (claim.type !== 'email_sent') return [];

    const recipient = claim.recipient.toLowerCase();

    const tag = (items: EvidenceItem[]): EvidenceItem[] => items.map((item) => ({ ...item, source: 'demo' }));

    if (recipient === DemoEvidenceProvider.UNKNOWN_RECIPIENT) {
      return tag([
        { type: 'message_exists', expected: claim.recipient, observed: null, result: 'UNKNOWN', detail: 'demo provider could not establish mailbox facts' },
        { type: 'recipient_match', expected: claim.recipient, observed: null, result: 'UNKNOWN' },
        { type: 'subject_match', expected: claim.subject, observed: null, result: 'UNKNOWN' },
        { type: 'attachment_present', expected: claim.attachment ?? '(none expected)', observed: null, result: 'UNKNOWN' },
        { type: 'sent_status', expected: 'sent', observed: null, result: 'UNKNOWN' },
      ]);
    }

    const message = DemoEvidenceProvider.MAILBOX.find((m) => m.to.toLowerCase() === recipient) ?? null;

    if (!message) {
      return tag([
        { type: 'message_exists', expected: claim.recipient, observed: null, result: 'FAIL', detail: 'no sent message to this recipient in mailbox' },
        { type: 'recipient_match', expected: claim.recipient, observed: null, result: 'FAIL' },
        { type: 'subject_match', expected: claim.subject, observed: null, result: 'FAIL' },
        { type: 'attachment_present', expected: claim.attachment ?? '(none expected)', observed: null, result: 'FAIL' },
        { type: 'sent_status', expected: 'sent', observed: null, result: 'FAIL' },
      ]);
    }

    const items: EvidenceItem[] = [
      { type: 'message_exists', expected: claim.recipient, observed: message.to, result: 'PASS' },
      {
        type: 'recipient_match',
        expected: claim.recipient,
        observed: message.to,
        result: message.to.toLowerCase() === recipient ? 'PASS' : 'FAIL',
      },
      {
        type: 'subject_match',
        expected: claim.subject,
        observed: message.subject,
        result: message.subject === claim.subject ? 'PASS' : 'FAIL',
      },
      claim.attachment
        ? {
            type: 'attachment_present',
            expected: claim.attachment,
            observed: message.attachments.join(', ') || null,
            result: message.attachments.includes(claim.attachment) ? 'PASS' : 'FAIL',
          }
        : {
            type: 'attachment_present',
            expected: '(none expected)',
            observed: message.attachments.join(', ') || null,
            result: 'PASS',
            detail: 'claim expected no attachment',
          },
      {
        type: 'sent_status',
        expected: 'sent',
        observed: message.sent ? 'sent' : 'draft',
        result: message.sent ? 'PASS' : 'FAIL',
      },
    ];

    if (claim.subject.includes(DemoEvidenceProvider.CONTRADICTION_MARKER)) {
      items.push({
        type: 'sent_status',
        expected: 'sent',
        observed: 'draft',
        result: 'FAIL',
        detail: 'conflicting source reports the message was never sent',
      });
    }

    return tag(items);
  }
}
