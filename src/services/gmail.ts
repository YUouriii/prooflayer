import { PrismaClient } from '@prisma/client';
import { AuditService } from './audit.js';
import type { GmailAccountRecord, GmailAccountStore } from '../integrations/gmail/store.js';
import { PrismaGmailAccountStore } from '../integrations/gmail/store.js';
import type { OAuthClient } from '../integrations/gmail/oauth.js';
import { OAuthStateError, createOAuthState, verifyOAuthState } from '../integrations/gmail/oauth.js';
import type { GmailApi } from '../integrations/gmail/types.js';
import { createGmailApiForToken } from '../integrations/gmail/client.js';

export interface GmailServiceDeps {
  oauth: OAuthClient;
  store?: GmailAccountStore;
  gmailApiFor?: (accessToken: string) => GmailApi;
  stateSecret: string;
  redirectAfterConnect?: string;
}

export class GmailAccountService {
  private readonly store: GmailAccountStore;
  private readonly gmailApiFor: (accessToken: string) => GmailApi;

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
    private oauth: OAuthClient,
    private options: { stateSecret: string; redirectAfterConnect?: string },
    deps?: { store?: GmailAccountStore; gmailApiFor?: (accessToken: string) => GmailApi }
  ) {
    this.store = deps?.store ?? new PrismaGmailAccountStore(prisma);
    this.gmailApiFor = deps?.gmailApiFor ?? createGmailApiForToken;
  }

  /** Step 1 of OAuth: signed connect URL for the browser. No secrets inside. */
  buildConnect(input: { organizationId: string; userId: string }): { url: string } {
    const state = createOAuthState({
      organizationId: input.organizationId,
      userId: input.userId,
      secret: this.options.stateSecret,
    });
    return { url: this.oauth.generateAuthUrl(state) };
  }

  /**
   * Step 2 of OAuth: exchange the code, persist encrypted tokens.
   * Throws ACCOUNT_NOT_FOUND-safe errors mapped by the route layer.
   */
  async handleCallback(input: {
    code: string;
    state: string;
    organizationId: string;
    userId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ email: string }> {
    let stateOrg: string;
    let stateUser: string;
    try {
      const payload = verifyOAuthState(input.state, {
        secret: this.options.stateSecret,
        expectedOrganizationId: input.organizationId,
      });
      stateOrg = payload.organizationId;
      stateUser = payload.userId;
    } catch (error) {
      await this.auditFailure(input, error);
      throw error;
    }
    if (stateUser !== input.userId || stateOrg !== input.organizationId) {
      const error = new OAuthStateError('OAuth state does not match the authenticated session');
      await this.auditFailure(input, error);
      throw error;
    }

    let tokens;
    try {
      tokens = await this.oauth.exchangeCode(input.code);
    } catch (error) {
      await this.auditFailure(input, error);
      throw new OAuthStateError('Google token exchange failed');
    }

    let email: string;
    try {
      email = await this.gmailApiFor(tokens.accessToken).getProfileEmail();
    } catch (error) {
      await this.auditFailure(input, error);
      throw new OAuthStateError('Could not read Gmail profile');
    }

    const account = await this.store.upsertConnectedAccount({
      organizationId: input.organizationId,
      email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: tokens.expiryDate ? new Date(tokens.expiryDate) : null,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
    });

    // Identifiers and statuses only — never tokens, codes, or secrets.
    await this.auditService.log({
      organizationId: input.organizationId,
      userId: input.userId,
      action: 'gmail.connect',
      metadata: { email: account.email, accountId: account.id, scopes: account.scopes },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return { email: account.email };
  }

  async listAccounts(organizationId: string): Promise<GmailAccountRecord[]> {
    return this.store.listAccounts(organizationId);
  }

  async getAccount(organizationId: string, accountId: string): Promise<GmailAccountRecord | null> {
    return this.store.findAccount(organizationId, accountId);
  }

  async disconnect(input: {
    organizationId: string;
    userId?: string;
    apiKeyId?: string;
    accountId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<GmailAccountRecord> {
    const accounts = await this.store.listAccounts(input.organizationId);
    const target = accounts.find((a) => a.id === input.accountId) ?? null;
    if (!target) {
      throw new Error('GMAIL_ACCOUNT_NOT_FOUND');
    }
    // Best effort: revoking at Google must not block local disconnect.
    // Tokens are loaded only here, used once, and never returned or logged.
    try {
      const connected = await this.store.listConnectedAccounts(input.organizationId);
      const secret = connected.find((c) => c.id === target.id)?.accessToken;
      if (secret) {
        await this.oauth.revokeToken(secret);
      }
    } catch {
      // Revocation is best-effort; local disconnect proceeds regardless.
    }
    await this.store.disconnect(target.id);
    const disconnected = await this.store.findAccount(input.organizationId, target.id);

    await this.auditService.log({
      organizationId: input.organizationId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      action: 'gmail.disconnect',
      metadata: { email: target.email, accountId: target.id },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return disconnected ?? { ...target, status: 'DISCONNECTED' };
  }

  private async auditFailure(
    input: { organizationId: string; userId: string; ipAddress?: string; userAgent?: string },
    error: unknown
  ): Promise<void> {
    try {
      await this.auditService.log({
        organizationId: input.organizationId,
        userId: input.userId,
        action: 'gmail.oauth_failed',
        metadata: { reason: error instanceof Error ? error.message : 'unknown' },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    } catch {
      // Audit failures must never mask the OAuth error itself.
    }
  }
}
