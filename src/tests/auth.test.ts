import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AuthService } from '../services/auth.js';
import { AuditService } from '../services/audit.js';
import { hashPassword, generateApiKey, hashApiKey } from '../utils/hash.js';

// Mock Prisma Client
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  organization: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  apiKey: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  session: {
    create: vi.fn(),
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn((callback) => callback(mockPrisma)),
} as unknown as PrismaClient;

describe('AuthService', () => {
  let authService: AuthService;
  let auditService: AuditService;

  beforeEach(() => {
    vi.clearAllMocks();
    auditService = new AuditService(mockPrisma);
    authService = new AuthService(mockPrisma, auditService);
  });

  describe('register', () => {
    it('should create user and organization', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.organization.create.mockResolvedValue({ id: 'org-1', name: 'Test Org' });
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        organizationId: 'org-1',
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await authService.register({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
        organizationName: 'Test Org',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      });

      expect(result.user.email).toBe('test@example.com');
      expect(result.organization.name).toBe('Test Org');
      expect(mockPrisma.user.create).toHaveBeenCalled();
      expect(mockPrisma.organization.create).toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(2);
    });

    it('should throw if email already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(authService.register({
        email: 'test@example.com',
        password: 'password123',
        organizationName: 'Test Org',
      })).rejects.toThrow('EMAIL_ALREADY_EXISTS');
    });
  });

  describe('login', () => {
    it('should return user and organization on valid credentials', async () => {
      const passwordHash = await hashPassword('password123');
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        passwordHash,
        name: 'Test User',
        organizationId: 'org-1',
        organization: { id: 'org-1', name: 'Test Org' },
      });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});
      mockPrisma.session.create.mockResolvedValue({ token: 'session-token' });

      const result = await authService.login({
        email: 'test@example.com',
        password: 'password123',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      });

      expect(result).not.toBeNull();
      expect(result!.user.email).toBe('test@example.com');
      expect(result!.session).toBeDefined();
    });

    it('should return null for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await authService.login({
        email: 'nonexistent@example.com',
        password: 'password123',
      });

      expect(result).toBeNull();
    });

    it('should return null for invalid password', async () => {
      const passwordHash = await hashPassword('password123');
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        passwordHash,
        organizationId: 'org-1',
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await authService.login({
        email: 'test@example.com',
        password: 'wrongpassword',
      });

      expect(result).toBeNull();
    });
  });

  describe('createApiKey', () => {
    it('should create API key with hash', async () => {
      const generatedKey = 'pl_abcdefgh_1234567890abcdef1234567890abcdef12345678';
      const generatedPrefix = 'pl';
      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'key-1',
        name: 'Test Key',
        keyHash: await hashApiKey(generatedKey),
        keyPrefix: generatedPrefix,
        organizationId: 'org-1',
        permissions: ['verify:email'],
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await authService.createApiKey({
        organizationId: 'org-1',
        userId: 'user-1',
        name: 'Test Key',
        permissions: ['verify:email'],
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      });

      expect(result.rawKey).toMatch(/^pl_[a-f0-9]{8}_[a-f0-9]{40}$/);
      expect(result.apiKey.keyPrefix).toBe('pl');
    });
  });

  describe('validateApiKey', () => {
    it('should validate correct API key', async () => {
      const { key, prefix } = generateApiKey('pl');
      const keyHash = await hashApiKey(key);
      mockPrisma.apiKey.findMany.mockResolvedValue([
        { id: 'key-1', keyHash, keyPrefix: prefix, organizationId: 'org-1', name: 'Test Key', permissions: ['verify:email'], organization: { id: 'org-1', name: 'Test Org' } },
      ]);
      mockPrisma.apiKey.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await authService.validateApiKey(key, '127.0.0.1', 'test-agent');

      expect(result).not.toBeNull();
      expect(result!.apiKey.id).toBe('key-1');
    });

    it('should reject invalid API key', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await authService.validateApiKey('pl_live_invalid', '127.0.0.1', 'test-agent');

      expect(result).toBeNull();
    });

    it('should reject revoked API key', async () => {
      // Revoked keys are filtered out in the query, so findMany returns empty
      mockPrisma.apiKey.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await authService.validateApiKey('pl_abcdefgh_1234567890abcdef1234567890abcdef12345678', '127.0.0.1', 'test-agent');

      expect(result).toBeNull();
    });
  });

  describe('revokeApiKey', () => {
    it('should revoke API key', async () => {
      mockPrisma.apiKey.findFirst.mockResolvedValue({
        id: 'key-1',
        name: 'Test Key',
        revokedAt: null,
        organizationId: 'org-1',
      });
      mockPrisma.apiKey.update.mockResolvedValue({ id: 'key-1', revokedAt: new Date() });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await authService.revokeApiKey({
        organizationId: 'org-1',
        userId: 'user-1',
        apiKeyId: 'key-1',
      });

      expect(result.revokedAt).toBeDefined();
    });

    it('should throw if API key not found', async () => {
      mockPrisma.apiKey.findFirst.mockResolvedValue(null);

      await expect(authService.revokeApiKey({
        organizationId: 'org-1',
        userId: 'user-1',
        apiKeyId: 'key-1',
      })).rejects.toThrow('API_KEY_NOT_FOUND');
    });

    it('should throw if API key already revoked', async () => {
      mockPrisma.apiKey.findFirst.mockResolvedValue({
        id: 'key-1',
        revokedAt: new Date(),
        organizationId: 'org-1',
      });

      await expect(authService.revokeApiKey({
        organizationId: 'org-1',
        userId: 'user-1',
        apiKeyId: 'key-1',
      })).rejects.toThrow('API_KEY_ALREADY_REVOKED');
    });
  });
});