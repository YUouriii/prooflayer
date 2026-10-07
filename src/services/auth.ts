import { PrismaClient, User, Organization, ApiKey, Session } from '@prisma/client';
import { hashPassword, verifyPassword, hashApiKey, verifyApiKey, generateApiKey, extractApiKeyPrefix } from '../utils/hash.js';
import { AuditService } from './audit.js';
import { FastifyRequest } from 'fastify';
import { randomBytes } from 'crypto';

export interface AuthTokens {
  user: User;
  organization: Organization;
  session?: Session;
}

export interface ApiKeyAuthResult {
  apiKey: ApiKey;
  organization: Organization;
}

export class AuthService {
  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService
  ) {}

  async register(data: {
    email: string;
    password: string;
    name?: string;
    organizationName: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthTokens> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
    });

    if (existingUser) {
      throw new Error('EMAIL_ALREADY_EXISTS');
    }

    const passwordHash = await hashPassword(data.password);

    const organization = await this.prisma.organization.create({
      data: { name: data.organizationName },
    });

    const user = await this.prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        passwordHash,
        name: data.name,
        organizationId: organization.id,
      },
    });

    await this.auditService.log({
      organizationId: organization.id,
      userId: user.id,
      action: 'user.register',
      metadata: { email: data.email, organizationName: data.organizationName },
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    });

    await this.auditService.log({
      organizationId: organization.id,
      userId: user.id,
      action: 'organization.create',
      metadata: { name: data.organizationName },
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    });

    return { user, organization };
  }

  async createSession(userId: string, ipAddress?: string, userAgent?: string): Promise<Session> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    return this.prisma.session.create({
      data: {
        token,
        userId,
        ipAddress,
        userAgent,
        expiresAt,
      },
    });
  }

  async destroySession(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { token } });
  }

  async login(data: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthTokens | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
      include: { organization: true },
    });

    if (!user) {
      // No organization to attribute this event to (AuditLog.organizationId
      // is a required FK), so it cannot be persisted without violating
      // referential integrity. Authentication still fails safely below.
      return null;
    }

    const valid = await verifyPassword(user.passwordHash, data.password);
    if (!valid) {
      await this.auditService.log({
        organizationId: user.organizationId,
        userId: user.id,
        action: 'auth.login.failed',
        metadata: { email: data.email, reason: 'invalid_password' },
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      });
      return null;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.auditService.log({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'auth.login.success',
      metadata: { email: data.email },
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    });

    const session = await this.createSession(user.id, data.ipAddress, data.userAgent);

    return { user, organization: user.organization, session };
  }

  async validateApiKey(apiKey: string, ipAddress?: string, userAgent?: string): Promise<ApiKeyAuthResult | null> {
    const prefix = extractApiKeyPrefix(apiKey);
    if (!prefix) return null;

    const apiKeys = await this.prisma.apiKey.findMany({
      where: {
        keyPrefix: prefix,
        revokedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      include: { organization: true },
    });

    for (const key of apiKeys) {
      const valid = await verifyApiKey(key.keyHash, apiKey);
      if (valid) {
        await this.prisma.apiKey.update({
          where: { id: key.id },
          data: { lastUsedAt: new Date() },
        });

        await this.auditService.log({
          organizationId: key.organizationId,
          apiKeyId: key.id,
          action: 'api_key.used',
          metadata: { keyName: key.name, permissions: key.permissions },
          ipAddress,
          userAgent,
        });

        return { apiKey: key, organization: key.organization };
      }
    }

    // No organization to attribute this event to (AuditLog.organizationId
    // is a required FK and the key matched nothing), so it cannot be
    // persisted without violating referential integrity. The key is still
    // rejected safely below.
    return null;
  }

  async createApiKey(data: {
    organizationId: string;
    userId: string;
    name: string;
    permissions: string[];
    expiresAt?: Date;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ apiKey: ApiKey; rawKey: string }> {
    const { key, prefix } = generateApiKey();
    const keyHash = await hashApiKey(key);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        name: data.name,
        keyHash,
        keyPrefix: prefix,
        organizationId: data.organizationId,
        permissions: data.permissions,
        expiresAt: data.expiresAt,
      },
    });

    await this.auditService.log({
      organizationId: data.organizationId,
      userId: data.userId,
      apiKeyId: apiKey.id,
      action: 'api_key.create',
      metadata: { name: data.name, permissions: data.permissions, prefix },
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    });

    return { apiKey, rawKey: key };
  }

  async revokeApiKey(data: {
    organizationId: string;
    userId: string;
    apiKeyId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<ApiKey> {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { id: data.apiKeyId, organizationId: data.organizationId },
    });

    if (!apiKey) {
      throw new Error('API_KEY_NOT_FOUND');
    }

    if (apiKey.revokedAt) {
      throw new Error('API_KEY_ALREADY_REVOKED');
    }

    const revoked = await this.prisma.apiKey.update({
      where: { id: data.apiKeyId },
      data: { revokedAt: new Date() },
    });

    await this.auditService.log({
      organizationId: data.organizationId,
      userId: data.userId,
      apiKeyId: data.apiKeyId,
      action: 'api_key.revoke',
      metadata: { name: apiKey.name },
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    });

    return revoked;
  }

  async getApiKeys(organizationId: string): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({
      where: { organizationId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrganization(organizationId: string): Promise<Organization | null> {
    return this.prisma.organization.findUnique({ where: { id: organizationId } });
  }
}