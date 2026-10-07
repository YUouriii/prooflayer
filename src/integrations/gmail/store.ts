/**
 * Encrypted Gmail account storage.
 *
 * Tokens are AES-256-GCM encrypted (existing utils/encryption) before
 * persistence and decrypted only inside this module. Callers never see
 * ciphertext, and ciphertext never reaches API responses or audit logs.
 */
import { PrismaClient } from '@prisma/client';
import { decrypt, encrypt } from '../../utils/encryption.js';
import { ConnectedGmailAccount, GmailAccountStatus } from './types.js';

export interface GmailAccountRecord {
  id: string;
  organizationId: string;
  provider: string;
  email: string;
  scopes: string[];
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GmailAccountStore {
  upsertConnectedAccount(input: {
    organizationId: string;
    email: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    scopes: string[];
  }): Promise<GmailAccountRecord>;
  listConnectedAccounts(organizationId: string): Promise<ConnectedGmailAccount[]>;
  findAccount(organizationId: string, accountId: string): Promise<GmailAccountRecord | null>;
  listAccounts(organizationId: string): Promise<GmailAccountRecord[]>;
  updateTokens(input: { id: string; accessToken: string; expiresAt: Date | null }): Promise<void>;
  markStatus(id: string, status: GmailAccountStatus): Promise<void>;
  disconnect(id: string): Promise<void>;
}

function toRecord(row: {
  id: string;
  organizationId: string;
  provider: string;
  email: string;
  scopes: string[];
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): GmailAccountRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    email: row.email,
    scopes: row.scopes,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Columns returned by metadata-only queries. Must cover every `required`
 * field of the public Gmail account response schema (otherwise response
 * serialization fails at runtime). */
export const PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  provider: true,
  email: true,
  scopes: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class PrismaGmailAccountStore implements GmailAccountStore {
  constructor(private prisma: PrismaClient) {}

  async upsertConnectedAccount(input: {
    organizationId: string;
    email: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    scopes: string[];
  }): Promise<GmailAccountRecord> {
    const row = await this.prisma.gmailAccount.upsert({
      where: { organizationId_email: { organizationId: input.organizationId, email: input.email } },
      create: {
        organizationId: input.organizationId,
        email: input.email,
        accessToken: encrypt(input.accessToken),
        refreshToken: input.refreshToken ? encrypt(input.refreshToken) : null,
        expiresAt: input.expiresAt,
        scopes: input.scopes,
        status: 'CONNECTED',
      },
      update: {
        accessToken: encrypt(input.accessToken),
        refreshToken: input.refreshToken ? encrypt(input.refreshToken) : null,
        expiresAt: input.expiresAt,
        scopes: input.scopes,
        status: 'CONNECTED',
      },
      select: PUBLIC_SELECT,
    });
    return toRecord(row);
  }

  async listConnectedAccounts(organizationId: string): Promise<ConnectedGmailAccount[]> {
    const rows = await this.prisma.gmailAccount.findMany({
      where: { organizationId, status: 'CONNECTED' },
      orderBy: { createdAt: 'asc' },
    });
    const accounts: ConnectedGmailAccount[] = [];
    for (const row of rows) {
      if (!row.accessToken) continue;
      accounts.push({
        id: row.id,
        organizationId: row.organizationId,
        email: row.email,
        accessToken: decrypt(row.accessToken),
        refreshToken: row.refreshToken ? decrypt(row.refreshToken) : null,
        expiresAt: row.expiresAt,
        scopes: row.scopes,
        status: row.status,
      });
    }
    return accounts;
  }

  async findAccount(organizationId: string, accountId: string): Promise<GmailAccountRecord | null> {
    const row = await this.prisma.gmailAccount.findFirst({
      where: { id: accountId, organizationId },
      select: PUBLIC_SELECT,
    });
    return row ? toRecord(row) : null;
  }

  async listAccounts(organizationId: string): Promise<GmailAccountRecord[]> {
    const rows = await this.prisma.gmailAccount.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: PUBLIC_SELECT,
    });
    return rows.map(toRecord);
  }

  async updateTokens(input: { id: string; accessToken: string; expiresAt: Date | null }): Promise<void> {
    await this.prisma.gmailAccount.update({
      where: { id: input.id },
      data: { accessToken: encrypt(input.accessToken), expiresAt: input.expiresAt, status: 'CONNECTED' },
    });
  }

  async markStatus(id: string, status: GmailAccountStatus): Promise<void> {
    await this.prisma.gmailAccount.update({ where: { id }, data: { status } });
  }

  async disconnect(id: string): Promise<void> {
    await this.prisma.gmailAccount.update({
      where: { id },
      data: { accessToken: null, refreshToken: null, expiresAt: null, status: 'DISCONNECTED' },
    });
  }
}
