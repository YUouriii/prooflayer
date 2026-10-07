import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { GmailAccountService } from '../services/gmail.js';
import { AuditService } from '../services/audit.js';
import { OAuthStateError, createOAuthState } from '../integrations/gmail/oauth.js';
import { FakeGmailApi, FakeGmailStore, FakeOAuthClient } from './gmail-fakes.js';
import { PUBLIC_SELECT } from '../integrations/gmail/store.js';
import { gmailAccountSchema } from '../utils/openapi.js';

describe('gmail account metadata contract', () => {
  it('PUBLIC_SELECT covers every required response field (no 500 on list/get)', () => {
    const required = gmailAccountSchema.required as string[];
    for (const field of required) {
      expect(
        Object.prototype.hasOwnProperty.call(PUBLIC_SELECT, field),
        `PUBLIC_SELECT must select required response field '${field}'`
      ).toBe(true);
    }
  });

  it('PUBLIC_SELECT never includes token columns', () => {
    const selected = Object.keys(PUBLIC_SELECT);
    expect(selected).not.toContain('accessToken');
    expect(selected).not.toContain('refreshToken');
  });
});

const SECRET = 'test-state-secret-min-32-characters!!';

function buildHarness() {
  const prisma = {
    auditLog: { create: vi.fn() },
  } as unknown as PrismaClient;
  const audit = new AuditService(prisma);
  const oauth = new FakeOAuthClient();
  const store = new FakeGmailStore();
  const api = new FakeGmailApi();
  const service = new GmailAccountService(prisma, audit, oauth, { stateSecret: SECRET }, {
    store,
    gmailApiFor: () => api,
  });
  return { prisma, audit, oauth, store, api, service };
}

describe('GmailAccountService', () => {
  let h: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    h = buildHarness();
  });

  it('buildConnect returns a Google URL embedding verifiable state', () => {
    const { url } = h.service.buildConnect({ organizationId: 'org-1', userId: 'user-1' });
    expect(url).toContain('https://accounts.google.com/o/oauth2/auth');
    expect(url).toContain('state=');
  });

  it('callback connects the account and audits without secrets', async () => {
    h.oauth.exchanged.set('auth-code', {
      accessToken: 'ya29.access',
      refreshToken: 'refresh-xyz',
      expiryDate: Date.now() + 3600_000,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    });
    const state = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: Date.now() });

    const result = await h.service.handleCallback({
      code: 'auth-code',
      state,
      organizationId: 'org-1',
      userId: 'user-1',
    });

    expect(result.email).toBe('user@gmail.com');
    const accounts = await h.service.listAccounts('org-1');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).not.toHaveProperty('accessToken');
    expect(accounts[0]).not.toHaveProperty('refreshToken');

    const logged = h.prisma.auditLog.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    const connected = logged.find((d) => d.action === 'gmail.connect');
    expect(connected).toBeDefined();
    const blob = JSON.stringify(logged);
    for (const secret of ['ya29.access', 'refresh-xyz', 'auth-code']) {
      expect(blob).not.toContain(secret);
    }
  });

  it('callback rejects forged state and audits the failure', async () => {
    await expect(
      h.service.handleCallback({ code: 'x', state: 'forged', organizationId: 'org-1', userId: 'user-1' })
    ).rejects.toThrow(OAuthStateError);
    const logged = h.prisma.auditLog.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(logged.find((d) => d.action === 'gmail.oauth_failed')).toBeDefined();
  });

  it('callback rejects state bound to another organization', async () => {
    const state = createOAuthState({ organizationId: 'org-2', userId: 'user-1', secret: SECRET, now: Date.now() });
    await expect(
      h.service.handleCallback({ code: 'x', state, organizationId: 'org-1', userId: 'user-1' })
    ).rejects.toThrow(OAuthStateError);
  });

  it('callback fails closed when Google exchange fails', async () => {
    h.oauth.exchangeError = new Error('redirect_uri_mismatch');
    const state = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: Date.now() });
    await expect(
      h.service.handleCallback({ code: 'bad-code', state, organizationId: 'org-1', userId: 'user-1' })
    ).rejects.toThrow(/token exchange/i);
    expect(await h.service.listAccounts('org-1')).toHaveLength(0);
  });

  it('accounts are isolated per organization', async () => {
    h.store.addConnected({ organizationId: 'org-1', email: 'a@gmail.com' });
    h.store.addConnected({ organizationId: 'org-2', email: 'b@gmail.com' });
    expect((await h.service.listAccounts('org-1')).map((a) => a.email)).toEqual(['a@gmail.com']);
    expect(await h.service.getAccount('org-1', h.store.records[1].id)).toBeNull();
  });

  it('disconnect revokes at Google, wipes local state, and audits', async () => {
    const acc = h.store.addConnected({ organizationId: 'org-1', email: 'a@gmail.com', accessToken: 'tok-1' });
    const result = await h.service.disconnect({ organizationId: 'org-1', userId: 'user-1', accountId: acc.id });
    expect(h.oauth.revoked).toContain('tok-1');
    expect(result.status).toBe('DISCONNECTED');
    const logged = h.prisma.auditLog.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    const entry = logged.find((d) => d.action === 'gmail.disconnect');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('tok-1');
  });

  it('disconnect of a foreign account → not found', async () => {
    const acc = h.store.addConnected({ organizationId: 'org-2', email: 'b@gmail.com' });
    await expect(
      h.service.disconnect({ organizationId: 'org-1', accountId: acc.id })
    ).rejects.toThrow('GMAIL_ACCOUNT_NOT_FOUND');
    expect(h.oauth.revoked).toHaveLength(0);
  });
});
