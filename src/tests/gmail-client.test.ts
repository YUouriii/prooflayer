import { describe, it, expect, vi } from 'vitest';
import { createGmailApi, parseGmailMessage } from '../integrations/gmail/client.js';
import { GmailApiError, GmailAuthError, GmailRateLimitError, classifyGmailError } from '../integrations/gmail/errors.js';

function googleMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    threadId: 'thr-1',
    labelIds: ['SENT'],
    payload: {
      headers: [
        { name: 'To', value: 'John <john@example.com>, jane@example.com' },
        { name: 'From', value: 'me@gmail.com' },
        { name: 'Subject', value: 'Invoice #4821' },
        { name: 'Date', value: 'Mon, 01 Jan 2024 10:00:00 +0000' },
      ],
      parts: [
        { filename: '', parts: [{ filename: 'invoice.pdf' }, { filename: '' }] },
      ],
    },
    ...overrides,
  };
}

function fakeGmail(impl: Record<string, unknown>) {
  return { users: impl } as never;
}

describe('parseGmailMessage', () => {
  it('extracts headers, labels, and nested attachment filenames', () => {
    const parsed = parseGmailMessage(googleMessage());
    expect(parsed.to).toEqual(['john@example.com', 'jane@example.com']);
    expect(parsed.from).toBe('me@gmail.com');
    expect(parsed.subject).toBe('Invoice #4821');
    expect(parsed.labelIds).toContain('SENT');
    expect(parsed.attachmentFilenames).toEqual(['invoice.pdf']);
  });

  it('handles missing headers and parts', () => {
    const parsed = parseGmailMessage({ id: 'x', payload: {} });
    expect(parsed.to).toEqual([]);
    expect(parsed.subject).toBe('');
    expect(parsed.attachmentFilenames).toEqual([]);
  });
});

describe('createGmailApi', () => {
  it('lists message refs', async () => {
    const api = createGmailApi(
      fakeGmail({ messages: { list: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'a' }] } }) } })
    );
    await expect(api.listMessages({ query: 'in:sent' })).resolves.toEqual([{ id: 'a', threadId: undefined }]);
  });

  it('fetches full MIME structure (metadata format omits attachment filenames)', async () => {
    const get = vi.fn().mockResolvedValue({ data: googleMessage() });
    const api = createGmailApi(fakeGmail({ messages: { get } }));
    await api.getMessage('msg-1');
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ format: 'full' }));
  });

  it('maps auth failures to GmailAuthError', async () => {
    const api = createGmailApi(
      fakeGmail({
        messages: {
          list: vi.fn().mockRejectedValue({ code: 401, message: 'Invalid Credentials', response: { data: {} } }),
        },
      })
    );
    await expect(api.listMessages({ query: 'x' })).rejects.toBeInstanceOf(GmailAuthError);
  });

  it('reads profile email lowercase', async () => {
    const api = createGmailApi(
      fakeGmail({ getProfile: vi.fn().mockResolvedValue({ data: { emailAddress: 'Me@Gmail.COM' } }) })
    );
    await expect(api.getProfileEmail()).resolves.toBe('me@gmail.com');
  });
});

describe('classifyGmailError', () => {
  it('invalid_grant → auth', () => {
    expect(classifyGmailError({ code: 400, message: 'invalid_grant: revoked', response: { data: {} } })).toBeInstanceOf(
      GmailAuthError
    );
  });

  it('rate limits → rate limit error', () => {
    const err = { code: 429, response: { data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } };
    expect(classifyGmailError(err)).toBeInstanceOf(GmailRateLimitError);
  });

  it('unknown shapes → generic API error', () => {
    expect(classifyGmailError(new Error('socket hang up'))).toBeInstanceOf(GmailApiError);
  });
});
