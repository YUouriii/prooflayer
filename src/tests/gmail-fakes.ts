import { vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { OAuthClient, OAuthTokens } from '../integrations/gmail/oauth.js';
import type { GmailAccountRecord, GmailAccountStore } from '../integrations/gmail/store.js';
import type { ConnectedGmailAccount, GmailApi, GmailFullMessage } from '../integrations/gmail/types.js';
import { GmailApiError } from '../integrations/gmail/errors.js';

export function testPrisma(overrides: Record<string, unknown> = {}): PrismaClient {
  return {
    agent: { findFirst: vi.fn() },
    verification: { create: vi.fn(), findFirst: vi.fn() },
    gmailAccount: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    ...overrides,
  } as unknown as PrismaClient;
}

export class FakeOAuthClient implements OAuthClient {
  exchanged = new Map<string, OAuthTokens>();
  refreshed = new Map<string, OAuthTokens>();
  refreshCalls: string[] = [];
  revoked: string[] = [];
  exchangeError: Error | null = null;
  refreshError: Error | null = null;

  generateAuthUrl(state: string): string {
    return `https://accounts.google.com/o/oauth2/auth?state=${state}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    if (this.exchangeError) throw this.exchangeError;
    const tokens = this.exchanged.get(code);
    if (!tokens) throw new Error('unknown test code');
    return tokens;
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    this.refreshCalls.push(refreshToken);
    if (this.refreshError) throw this.refreshError;
    const tokens = this.refreshed.get(refreshToken);
    if (!tokens) throw new Error('unknown test refresh token');
    return tokens;
  }

  async revokeToken(token: string): Promise<void> {
    this.revoked.push(token);
  }
}

let accountSeq = 0;

export class FakeGmailStore implements GmailAccountStore {
  accounts: ConnectedGmailAccount[] = [];
  records: GmailAccountRecord[] = [];
  updatedTokens: { id: string; accessToken: string }[] = [];
  marks: { id: string; status: string }[] = [];
  disconnected: string[] = [];
  failLoad = false;

  addConnected(account: Partial<ConnectedGmailAccount> & { email: string }): ConnectedGmailAccount {
    accountSeq += 1;
    const full: ConnectedGmailAccount = {
      id: account.id ?? `acc-${accountSeq}`,
      organizationId: account.organizationId ?? 'org-1',
      accessToken: account.accessToken ?? 'access-token',
      refreshToken: account.refreshToken ?? 'refresh-token',
      expiresAt: account.expiresAt ?? new Date(Date.now() + 3600_000),
      scopes: account.scopes ?? ['https://www.googleapis.com/auth/gmail.readonly'],
      status: account.status ?? 'CONNECTED',
      email: account.email,
    };
    this.accounts.push(full);
    this.records.push({
      id: full.id,
      organizationId: full.organizationId,
      provider: 'gmail',
      email: full.email,
      scopes: full.scopes,
      status: full.status,
      expiresAt: full.expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return full;
  }

  async upsertConnectedAccount(input: {
    organizationId: string;
    email: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    scopes: string[];
  }): Promise<GmailAccountRecord> {
    const existing = this.records.find((r) => r.organizationId === input.organizationId && r.email === input.email);
    if (existing) {
      Object.assign(existing, { scopes: input.scopes, status: 'CONNECTED', expiresAt: input.expiresAt });
      const acc = this.accounts.find((a) => a.id === existing.id);
      if (acc) Object.assign(acc, { accessToken: input.accessToken, refreshToken: input.refreshToken, expiresAt: input.expiresAt, status: 'CONNECTED' });
      return existing;
    }
    return this.addConnected(input) as unknown as GmailAccountRecord;
  }

  async listConnectedAccounts(organizationId: string): Promise<ConnectedGmailAccount[]> {
    if (this.failLoad) throw new Error('store unavailable');
    return this.accounts.filter((a) => a.organizationId === organizationId && a.status === 'CONNECTED');
  }

  async findAccount(organizationId: string, accountId: string): Promise<GmailAccountRecord | null> {
    return this.records.find((r) => r.organizationId === organizationId && r.id === accountId) ?? null;
  }

  async listAccounts(organizationId: string): Promise<GmailAccountRecord[]> {
    return this.records.filter((r) => r.organizationId === organizationId);
  }

  async updateTokens(input: { id: string; accessToken: string; expiresAt: Date | null }): Promise<void> {
    this.updatedTokens.push({ id: input.id, accessToken: input.accessToken });
    const acc = this.accounts.find((a) => a.id === input.id);
    if (acc) {
      acc.accessToken = input.accessToken;
      acc.expiresAt = input.expiresAt;
    }
  }

  async markStatus(id: string, status: 'CONNECTED' | 'DISCONNECTED' | 'REVOKED' | 'ERROR'): Promise<void> {
    this.marks.push({ id, status });
    const acc = this.accounts.find((a) => a.id === id);
    if (acc) acc.status = status;
    const rec = this.records.find((r) => r.id === id);
    if (rec) rec.status = status;
  }

  async disconnect(id: string): Promise<void> {
    this.disconnected.push(id);
    await this.markStatus(id, 'DISCONNECTED');
  }
}

/** Deterministic fake Gmail API over an in-memory message list. */
export class FakeGmailApi implements GmailApi {
  listCalls: string[] = [];
  failList: Error | null = null;
  failGetIds = new Set<string>();

  constructor(private messages: GmailFullMessage[] = []) {}

  async listMessages(options: { query: string; maxResults?: number }): Promise<{ id: string }[]> {
    this.listCalls.push(options.query);
    if (this.failList) throw this.failList;
    const toMatch = /to:([^\s]+)/.exec(options.query)?.[1]?.toLowerCase();
    const subjectMatch = /subject:\(([^)]+)\)/.exec(options.query)?.[1]?.toLowerCase();
    return this.messages
      .filter((m) => {
        if (toMatch) return m.to.some((t) => t.includes(toMatch));
        if (subjectMatch) {
          return subjectMatch.split(/\s+/).every((w) => m.subject.toLowerCase().includes(w));
        }
        return true;
      })
      .slice(0, options.maxResults ?? 10)
      .map((m) => ({ id: m.id }));
  }

  async getMessage(id: string): Promise<GmailFullMessage> {
    if (this.failGetIds.has(id)) throw new GmailApiError('boom', 500);
    const found = this.messages.find((m) => m.id === id);
    if (!found) throw new GmailApiError('not found', 404);
    return found;
  }

  async getProfileEmail(): Promise<string> {
    return 'user@gmail.com';
  }
}

export function sentMessage(overrides: Partial<GmailFullMessage> = {}): GmailFullMessage {
  return {
    id: overrides.id ?? 'msg-1',
    labelIds: overrides.labelIds ?? ['SENT'],
    from: overrides.from ?? 'me@gmail.com',
    to: overrides.to ?? ['john@example.com'],
    cc: overrides.cc ?? [],
    subject: overrides.subject ?? 'Invoice #4821',
    date: overrides.date ?? 'Mon, 01 Jan 2024 10:00:00 +0000',
    attachmentFilenames: overrides.attachmentFilenames ?? ['invoice.pdf'],
  };
}
