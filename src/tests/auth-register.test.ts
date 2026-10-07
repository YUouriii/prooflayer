import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { PrismaClient } from '@prisma/client';
import authRoutes from '../routes/auth.js';
import { AuthService } from '../services/auth.js';
import { AuditService } from '../services/audit.js';

const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  organization: {
    create: vi.fn(),
  },
  session: {
    create: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
} as unknown as PrismaClient;

async function buildApp(): Promise<FastifyInstance> {
  const app = fastify();
  app.decorate('prisma', mockPrisma);
  const auditService = new AuditService(mockPrisma);
  app.decorate('auditService', auditService);
  app.decorate('authService', new AuthService(mockPrisma, auditService));
  await app.register(cookie);
  await app.register(authRoutes, { prefix: '/auth' });
  return app;
}

describe('POST /auth/register', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.organization.create.mockImplementation((args: unknown) => {
      const data = (args as { data: { name: string } }).data;
      return Promise.resolve({ id: 'org-1', name: data.name, createdAt: new Date(), updatedAt: new Date() });
    });
    mockPrisma.user.create.mockImplementation((args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      return Promise.resolve({ id: 'user-1', ...data, createdAt: new Date(), updatedAt: new Date() });
    });
    mockPrisma.session.create.mockResolvedValue({ token: 'sess-token' });
    mockPrisma.auditLog.create.mockResolvedValue({});
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('registers with a valid organization name → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'ali.test@example.com',
        password: 'ProofLayer123!',
        name: 'Ali ProofLayer',
        organizationName: 'Ali Org',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { user: { email: string }; organization: { name: string } };
    expect(body.user.email).toBe('ali.test@example.com');
    expect(body.organization.name).toBe('Ali Org');
    expect(mockPrisma.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Ali Org' }) })
    );
  });

  it('missing organization name → 400 (not 500)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'ali.test@example.com',
        password: 'ProofLayer123!',
        name: 'Ali ProofLayer',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(mockPrisma.organization.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('invalid email → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'not-an-email',
        password: 'ProofLayer123!',
        organizationName: 'Ali Org',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(mockPrisma.organization.create).not.toHaveBeenCalled();
  });

  it('short password → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'ali.test@example.com',
        password: 'short',
        organizationName: 'Ali Org',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(mockPrisma.organization.create).not.toHaveBeenCalled();
  });
});
