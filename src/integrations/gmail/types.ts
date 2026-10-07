/**
 * Narrow Gmail shapes used by ProofLayer.
 * Only the fields the evidence provider inspects are modeled —
 * never full bodies or attachments.
 */

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export interface GmailMessageRef {
  id: string;
  threadId?: string;
}

export interface GmailFullMessage {
  id: string;
  threadId?: string;
  /** Gmail label IDs, e.g. ['SENT', 'INBOX']. */
  labelIds: string[];
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string | undefined;
  /** Attachment filenames found in MIME parts (metadata only). */
  attachmentFilenames: string[];
}

/** Minimal Gmail API surface the provider needs (implemented by client.ts). */
export interface GmailApi {
  listMessages(options: { query: string; maxResults?: number }): Promise<GmailMessageRef[]>;
  getMessage(id: string): Promise<GmailFullMessage>;
  getProfileEmail(): Promise<string>;
}

export type GmailAccountStatus = 'CONNECTED' | 'DISCONNECTED' | 'REVOKED' | 'ERROR';

export const GMAIL_ACCOUNT_STATUSES: readonly string[] = [
  'CONNECTED',
  'DISCONNECTED',
  'REVOKED',
  'ERROR',
];

/** Decrypted account handed to the Gmail API layer (never leaves the server). */
export interface ConnectedGmailAccount {
  id: string;
  organizationId: string;
  email: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  status: string;
}
