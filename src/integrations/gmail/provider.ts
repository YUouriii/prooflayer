/**
 * Gmail evidence provider.
 *
 * Collects the same five checks as the demo provider, but from the real
 * Gmail API instead of a fake mailbox:
 *   message_exists, recipient_match, subject_match,
 *   attachment_present, sent_status
 *
 * Semantics (mirrors the engine contract):
 * - Scoped `in:sent` searches that return no candidates = confident
 *   absence → FAIL (the email was not sent).
 * - No connected accounts, revoked/errored accounts, or API failures =
 *   UNKNOWN (a technical failure is never reported as FALSE).
 * - Candidates that disagree on a check are all emitted, so the engine's
 *   contradiction rule produces FAILED with a contradiction reason.
 *
 * Returns EvidenceItem[] only — never a final VERIFIED/FAILED verdict.
 */
import type { Claim, EmailSentClaim, EvidenceItem } from '../../verification/types.js';
import type { EvidenceContext, EvidenceProvider } from '../../verification/providers.js';
import type { GmailAccountStore } from './store.js';
import type { OAuthClient } from './oauth.js';
import type { GmailApi, GmailFullMessage } from './types.js';
import { GmailApiError, GmailAuthError, GmailRateLimitError } from './errors.js';
import { createGmailApiForToken } from './client.js';

export interface GmailProviderDeps {
  store: GmailAccountStore;
  oauth: OAuthClient;
  gmailApiFor?: (accessToken: string) => GmailApi;
}

const REFRESH_SKEW_MS = 60 * 1000;
const MAX_CANDIDATES = 5;

function unknownSet(claim: EmailSentClaim, detail: string): EvidenceItem[] {
  const base = (type: string, expected: string): EvidenceItem => ({
    type,
    expected,
    observed: null,
    result: 'UNKNOWN',
    detail,
  });
  return [
    base('message_exists', claim.recipient),
    base('recipient_match', claim.recipient),
    base('subject_match', claim.subject),
    base('attachment_present', claim.attachment ?? '(none expected)'),
    base('sent_status', 'sent'),
  ];
}

function escapeGmailQuery(value: string): string {
  return value.replace(/["\\]/g, '').slice(0, 200);
}

export class GmailEvidenceProvider implements EvidenceProvider {
  readonly name = 'gmail';

  private readonly store: GmailAccountStore;
  private readonly oauth: OAuthClient;
  private readonly gmailApiFor: (accessToken: string) => GmailApi;

  constructor(deps: GmailProviderDeps) {
    this.store = deps.store;
    this.oauth = deps.oauth;
    this.gmailApiFor = deps.gmailApiFor ?? createGmailApiForToken;
  }

  supports(claim: Claim): boolean {
    return claim.type === 'email_sent';
  }

  async collect(claim: Claim, context?: EvidenceContext): Promise<EvidenceItem[]> {
    const items = await this.collectUntagged(claim, context);
    return items.map((item) => ({ ...item, source: 'gmail' }));
  }

  private async collectUntagged(claim: Claim, context?: EvidenceContext): Promise<EvidenceItem[]> {
    if (claim.type !== 'email_sent') return [];
    if (!context?.organizationId) {
      return unknownSet(claim, 'missing organization context');
    }

    let accounts;
    try {
      accounts = await this.store.listConnectedAccounts(context.organizationId);
    } catch {
      return unknownSet(claim, 'could not load Gmail accounts');
    }
    if (accounts.length === 0) {
      return unknownSet(claim, 'no connected Gmail account for this organization');
    }

    const candidates: GmailFullMessage[] = [];
    let usableAccount = false;
    let sawAuthFailure = false;

    for (const account of accounts) {
      const token = await this.accessTokenFor(account);
      if (!token) {
        sawAuthFailure = true;
        continue;
      }
      const api = this.gmailApiFor(token);
      try {
        const found = await this.findCandidates(api, claim);
        usableAccount = true;
        candidates.push(...found);
      } catch (error) {
        if (error instanceof GmailAuthError) {
          sawAuthFailure = true;
          await this.safeMark(account.id, 'REVOKED');
        } else if (error instanceof GmailRateLimitError || error instanceof GmailApiError) {
          await this.safeMark(account.id, 'ERROR');
        } else {
          throw error;
        }
      }
    }

    if (!usableAccount) {
      return unknownSet(
        claim,
        sawAuthFailure ? 'Gmail authorization failed or was revoked' : 'Gmail API unavailable'
      );
    }

    const sent = candidates.filter((m) => m.labelIds.includes('SENT'));
    if (sent.length === 0) {
      const failed = (type: string, expected: string): EvidenceItem => ({
        type,
        expected,
        observed: null,
        result: 'FAIL',
        detail: 'scoped sent-mailbox search returned no candidates',
      });
      return [
        failed('message_exists', claim.recipient),
        failed('recipient_match', claim.recipient),
        failed('subject_match', claim.subject),
        failed('attachment_present', claim.attachment ?? '(none expected)'),
        failed('sent_status', 'sent'),
      ];
    }

    return this.evaluateCandidates(claim, sent);
  }

  private async accessTokenFor(account: {
    id: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
  }): Promise<string | null> {
    const expired = account.expiresAt !== null && account.expiresAt.getTime() <= Date.now() + REFRESH_SKEW_MS;
    if (!expired) return account.accessToken;
    if (!account.refreshToken) return null;
    try {
      const refreshed = await this.oauth.refreshAccessToken(account.refreshToken);
      const expiresAt = refreshed.expiryDate ? new Date(refreshed.expiryDate) : null;
      await this.store.updateTokens({ id: account.id, accessToken: refreshed.accessToken, expiresAt });
      return refreshed.accessToken;
    } catch (error) {
      if (error instanceof GmailAuthError || /invalid_grant|revoked/i.test((error as Error).message)) {
        await this.safeMark(account.id, 'REVOKED');
      }
      return null;
    }
  }

  private async findCandidates(api: GmailApi, claim: EmailSentClaim): Promise<GmailFullMessage[]> {
    const recipient = escapeGmailQuery(claim.recipient);
    let refs = await api.listMessages({ query: `in:sent to:${recipient}`, maxResults: MAX_CANDIDATES });
    if (refs.length === 0 && claim.subject.trim().length > 0) {
      const words = claim.subject.trim().split(/\s+/).slice(0, 6).join(' ');
      refs = await api.listMessages({
        query: `in:sent subject:(${escapeGmailQuery(words)})`,
        maxResults: MAX_CANDIDATES,
      });
    }
    const messages: GmailFullMessage[] = [];
    for (const ref of refs.slice(0, MAX_CANDIDATES)) {
      try {
        messages.push(await api.getMessage(ref.id));
      } catch (error) {
        if (error instanceof GmailAuthError || error instanceof GmailRateLimitError || error instanceof GmailApiError) {
          throw error;
        }
        throw error;
      }
    }
    return messages;
  }

  private evaluateCandidates(claim: EmailSentClaim, sent: GmailFullMessage[]): EvidenceItem[] {
    const wanted = claim.recipient.toLowerCase();
    const toMatches = (m: GmailFullMessage): boolean => m.to.includes(wanted);
    const subjectMatches = (m: GmailFullMessage): boolean => m.subject === claim.subject;
    const attachmentMatches = (m: GmailFullMessage): boolean =>
      !claim.attachment || m.attachmentFilenames.some((f) => f.toLowerCase() === claim.attachment!.toLowerCase());

    const best = sent.find(toMatches) ?? sent[0];
    const items: EvidenceItem[] = [
      { type: 'message_exists', expected: claim.recipient, observed: `${sent.length} candidate(s) in sent mailbox`, result: 'PASS' },
      {
        type: 'recipient_match',
        expected: claim.recipient,
        observed: best.to.join(', ') || null,
        result: toMatches(best) ? 'PASS' : 'FAIL',
      },
      {
        type: 'subject_match',
        expected: claim.subject,
        observed: best.subject || null,
        result: subjectMatches(best) ? 'PASS' : 'FAIL',
      },
      claim.attachment
        ? {
            type: 'attachment_present',
            expected: claim.attachment,
            observed: best.attachmentFilenames.join(', ') || null,
            result: attachmentMatches(best) ? 'PASS' : 'FAIL',
          }
        : {
            type: 'attachment_present',
            expected: '(none expected)',
            observed: best.attachmentFilenames.join(', ') || null,
            result: 'PASS',
            detail: 'claim expected no attachment',
          },
      {
        type: 'sent_status',
        expected: 'sent',
        observed: 'sent',
        result: 'PASS',
      },
    ];

    // Surface disagreement between independent candidates so the engine's
    // contradiction rule fires instead of silently picking a winner.
    const disagrees = (check: (m: GmailFullMessage) => boolean): boolean => {
      const results = new Set(sent.map((m) => check(m)));
      return results.size > 1;
    };
    const conflict = (type: string, expected: string, observed: string | null, basePass: boolean): void => {
      items.push({
        type,
        expected,
        observed,
        result: basePass ? 'FAIL' : 'PASS',
        detail: 'conflicting mailbox sources disagree on this check',
      });
    };
    const baseByType = new Map(items.map((i) => [i.type, i]));
    if (disagrees(toMatches)) {
      const base = baseByType.get('recipient_match')!;
      conflict('recipient_match', claim.recipient, sent.map((m) => m.to.join(', ')).join(' | ') || null, base.result === 'PASS');
    }
    if (disagrees(subjectMatches)) {
      const base = baseByType.get('subject_match')!;
      conflict('subject_match', claim.subject, sent.map((m) => m.subject).join(' | ') || null, base.result === 'PASS');
    }
    if (claim.attachment && disagrees(attachmentMatches)) {
      const base = baseByType.get('attachment_present')!;
      conflict('attachment_present', claim.attachment, sent.map((m) => m.attachmentFilenames.join(', ')).join(' | ') || null, base.result === 'PASS');
    }

    return items;
  }

  private async safeMark(id: string, status: 'REVOKED' | 'ERROR'): Promise<void> {
    try {
      await this.store.markStatus(id, status);
    } catch {
      // Status bookkeeping must never break evidence collection.
    }
  }
}
