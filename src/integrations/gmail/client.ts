/**
 * Minimal Gmail API wrapper.
 *
 * Only message metadata is fetched (`format: 'metadata'` with To/Subject/
 * Date headers); bodies and attachment contents are never downloaded —
 * attachment presence is established from MIME part filenames.
 */
import { google, type gmail_v1 } from 'googleapis';
import { GmailApi, GmailFullMessage, GmailMessageRef } from './types.js';
import { GmailApiError, classifyGmailError } from './errors.js';

type GmailResource = Pick<gmail_v1.Gmail, 'users'>;

function headerValue(headers: { name?: string | null; value?: string | null }[] | undefined, name: string): string {
  const found = (headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((part) => {
      const email = part.match(/<([^>]+)>/)?.[1] ?? part;
      return email.trim().toLowerCase();
    })
    .filter((address) => address.length > 0);
}

function collectFilenames(part: gmail_v1.Schema$MessagePart | undefined, into: string[]): void {
  if (!part) return;
  if (part.filename && part.filename.length > 0) {
    into.push(part.filename);
  }
  for (const child of part.parts ?? []) {
    collectFilenames(child, into);
  }
}

export function parseGmailMessage(message: gmail_v1.Schema$Message): GmailFullMessage {
  const headers = message.payload?.headers ?? [];
  const filenames: string[] = [];
  collectFilenames(message.payload, filenames);
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? undefined,
    labelIds: message.labelIds ?? [],
    from: headerValue(headers, 'from').toLowerCase(),
    to: splitAddresses(headerValue(headers, 'to')),
    cc: splitAddresses(headerValue(headers, 'cc')),
    subject: headerValue(headers, 'subject'),
    date: headerValue(headers, 'date') || undefined,
    attachmentFilenames: filenames,
  };
}

/** Production factory: builds a GmailApi bound to an OAuth access token. */
export function createGmailApiForToken(accessToken: string): GmailApi {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return createGmailApi(google.gmail({ version: 'v1', auth }));
}

export function createGmailApi(gmail: GmailResource): GmailApi {
  return {
    async listMessages(options: { query: string; maxResults?: number }): Promise<GmailMessageRef[]> {
      try {
        const response = await gmail.users.messages.list({
          userId: 'me',
          q: options.query,
          maxResults: options.maxResults ?? 10,
        });
        return (response.data.messages ?? [])
          .filter((m) => typeof m.id === 'string')
          .map((m) => ({ id: m.id as string, threadId: m.threadId ?? undefined }));
      } catch (error) {
        throw classifyGmailError(error);
      }
    },
    async getMessage(id: string): Promise<GmailFullMessage> {
      try {
        // NOTE: `format: 'metadata'` does NOT return MIME parts (verified
        // live: attachment filenames are absent), so attachment presence
        // cannot be established from it. `format: 'full'` is required for
        // the part/filename structure. Message bodies and attachment
        // contents are never read, stored, or logged — only headers,
        // labels, and filenames are parsed (see parseGmailMessage).
        const response = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
          metadataHeaders: ['To', 'From', 'Subject', 'Date'],
        });
        return parseGmailMessage(response.data);
      } catch (error) {
        throw classifyGmailError(error);
      }
    },
    async getProfileEmail(): Promise<string> {
      try {
        const response = await gmail.users.getProfile({ userId: 'me' });
        const email = response.data.emailAddress ?? '';
        if (!email) {
          throw new GmailApiError('Gmail profile has no email address');
        }
        return email.toLowerCase();
      } catch (error) {
        if (error instanceof GmailApiError) throw error;
        throw classifyGmailError(error);
      }
    },
  };
}
