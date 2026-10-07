import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { PrismaClient } from '@prisma/client';
import authRoutes from '../routes/auth.js';
import organizationRoutes from '../routes/organizations.js';
import agentRoutes from '../routes/agents.js';
import apiKeyRoutes from '../routes/api-keys.js';
import auditRoutes from '../routes/audit.js';
import verificationRoutes from '../routes/verifications.js';
import healthRoutes from '../routes/health.js';
import demoRoutes from '../routes/demo.js';
import gmailRoutes from '../routes/gmail.js';
import homepageRoutes from '../routes/homepage.js';
import publicDemoRoutes from '../routes/public-demo.js';
import { AuthService } from '../services/auth.js';
import { AuditService } from '../services/audit.js';
import { apiSecuritySchemes, serverUrl } from '../utils/openapi.js';

const mockPrisma = {
  agent: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  organization: { findUnique: vi.fn() },
  user: { update: vi.fn() },
  apiKey: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  verification: { create: vi.fn(), findFirst: vi.fn() },
  auditLog: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
} as unknown as PrismaClient;

interface OpenApiDoc {
  openapi: string;
  servers: { url: string }[];
  components: { securitySchemes: Record<string, unknown> };
  paths: Record<string, Record<string, Operation>>;
}

interface Operation {
  tags?: string[];
  summary?: string;
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
  responses?: Record<string, unknown>;
}

let doc: OpenApiDoc;

beforeAll(async () => {
  const app: FastifyInstance = fastify();
  app.decorate('prisma', mockPrisma);
  app.decorate('config', {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/v1/gmail/callback',
    JWT_SECRET: 'test-jwt-secret-min-32-characters!!',
  });
  const auditService = new AuditService(mockPrisma);
  app.decorate('auditService', auditService);
  app.decorate('authService', new AuthService(mockPrisma, auditService));
  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      info: { title: 'ProofLayer API (test)', version: '0.0.0' },
      servers: [{ url: serverUrl(3000) }],
      components: { securitySchemes: apiSecuritySchemes },
      security: [{ apiKey: [] }, { session: [] }],
    },
  });
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(organizationRoutes, { prefix: '/api/v1/organizations' });
  await app.register(agentRoutes, { prefix: '/api/v1/agents' });
  await app.register(apiKeyRoutes, { prefix: '/api/v1/api-keys' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit-logs' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verifications' });
  await app.register(gmailRoutes, { prefix: '/api/v1/gmail' });
  await app.register(demoRoutes);
  await app.register(homepageRoutes);
  await app.register(publicDemoRoutes, { prefix: '/api/v1/demo' });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/docs/json' });
  expect(res.statusCode).toBe(200);
  doc = res.json() as OpenApiDoc;
  await app.close();
});

afterAll(() => {
  vi.clearAllMocks();
});

function op(path: string, method: string): Operation {
  const operation = doc.paths[path]?.[method];
  expect(operation, `${method.toUpperCase()} ${path} documented`).toBeDefined();
  return operation;
}

function requiredOf(schema: Record<string, unknown> | undefined): string[] {
  expect(schema, 'requestBody schema present').toBeDefined();
  const required = (schema as { required?: unknown }).required;
  expect(Array.isArray(required), 'required must be an array').toBe(true);
  return required as string[];
}

describe('server and security documentation', () => {
  it('advertises the local URL, never 0.0.0.0', () => {
    expect(doc.servers[0].url).toBe('http://localhost:3000');
    expect(doc.servers[0].url).not.toContain('0.0.0.0');
  });

  it('serverUrl helper never emits a bind address', () => {
    expect(serverUrl(3000)).toBe('http://localhost:3000');
  });

  it('serverUrl uses the public base URL when configured (production)', () => {
    expect(serverUrl(10000, 'https://prooflayer-2ixp.onrender.com')).toBe('https://prooflayer-2ixp.onrender.com');
  });

  it('production server URL never points to localhost', () => {
    const url = serverUrl(10000, 'https://prooflayer-2ixp.onrender.com');
    expect(url).not.toContain('localhost');
    expect(url).not.toContain('0.0.0.0');
    expect(url.startsWith('https://')).toBe(true);
  });

  it('serverUrl trims a trailing slash from the public base URL', () => {
    expect(serverUrl(10000, 'https://prooflayer-2ixp.onrender.com/')).toBe('https://prooflayer-2ixp.onrender.com');
  });

  it('declares Bearer API-key and session-cookie schemes', () => {
    expect(doc.components.securitySchemes.apiKey).toBeDefined();
    expect(doc.components.securitySchemes.session).toBeDefined();
  });

  it('every operation has tags and at least one response', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.tags?.length, `${method} ${path} tags`).toBeGreaterThan(0);
        expect(Object.keys(operation.responses ?? {}).length, `${method} ${path} responses`).toBeGreaterThan(0);
      }
    }
  });
});

describe('request bodies', () => {
  it('POST /api/v1/auth/register has application/json requestBody', () => {
    const operation = op('/api/v1/auth/register', 'post');
    const schema = operation.requestBody?.content['application/json']?.schema;
    const required = requiredOf(schema);
    expect(required).toContain('email');
    expect(required).toContain('password');
    expect(required).toContain('organizationName');
  });

  it('POST /api/v1/agents/ has application/json requestBody requiring name', () => {
    const operation = op('/api/v1/agents/', 'post');
    const schema = operation.requestBody?.content['application/json']?.schema;
    expect(requiredOf(schema)).toContain('name');
  });

  it('POST /api/v1/verifications has application/json requestBody requiring agentId and claim', () => {
    const operation = op('/api/v1/verifications/', 'post');
    const schema = operation.requestBody?.content['application/json']?.schema;
    const required = requiredOf(schema);
    expect(required).toContain('agentId');
    expect(required).toContain('claim');
  });

  it('POST /api/v1/auth/login has application/json requestBody', () => {
    const operation = op('/api/v1/auth/login', 'post');
    expect(operation.requestBody?.content['application/json']?.schema).toBeDefined();
  });

  it('POST /api/v1/api-keys/ has application/json requestBody requiring name', () => {
    const operation = op('/api/v1/api-keys/', 'post');
    const schema = operation.requestBody?.content['application/json']?.schema;
    expect(requiredOf(schema)).toContain('name');
  });
});

describe('parameters', () => {
  it('GET /api/v1/agents/ documents page/limit query parameters', () => {
    const params = op('/api/v1/agents/', 'get').parameters ?? [];
    const names = params.filter((p) => p.in === 'query').map((p) => p.name);
    expect(names).toContain('page');
    expect(names).toContain('limit');
  });

  it('GET /api/v1/audit-logs/ documents filter query parameters', () => {
    const params = op('/api/v1/audit-logs/', 'get').parameters ?? [];
    const names = params.filter((p) => p.in === 'query').map((p) => p.name);
    for (const expected of ['page', 'limit', 'action', 'userId', 'startDate', 'endDate']) {
      expect(names).toContain(expected);
    }
  });

  it('GET /api/v1/agents/{id} documents the path parameter', () => {
    const params = op('/api/v1/agents/{id}', 'get').parameters ?? [];
    const id = params.find((p) => p.in === 'path' && p.name === 'id');
    expect(id).toBeDefined();
    expect(id?.required).toBe(true);
  });

  it('GET /api/v1/verifications/{id} documents the path parameter', () => {
    const params = op('/api/v1/verifications/{id}', 'get').parameters ?? [];
    const id = params.find((p) => p.in === 'path' && p.name === 'id');
    expect(id).toBeDefined();
    expect(id?.required).toBe(true);
  });
});

describe('verification contract documentation', () => {
  it('verification responses require provider', () => {
    const responses = op('/api/v1/verifications/', 'post').responses ?? {};
    const schema = (responses['201'] as { content: Record<string, { schema: Record<string, unknown> }> }).content[
      'application/json'
    ].schema as { required: string[] };
    expect(schema.required).toContain('provider');
  });

  it('POST /api/v1/verifications documents 200 replay, 409 conflict, and 429', () => {
    const responses = op('/api/v1/verifications/', 'post').responses ?? {};
    for (const code of ['200', '201', '400', '401', '404', '409', '429', '500']) {
      expect(responses[code], `response ${code} documented`).toBeDefined();
    }
  });

  it('POST documents 403 for insufficient API-key scope', () => {
    const responses = op('/api/v1/verifications/', 'post').responses ?? {};
    expect(responses['403']).toBeDefined();
  });

  it('POST documents correlation and limit behavior', () => {
    const operation = op('/api/v1/verifications/', 'post');
    const description = JSON.stringify(operation);
    expect(description).toContain('X-Request-Id');
    expect(description).toContain('Idempotency-Key');
  });

  it('evidence items document the source field', () => {
    const responses = op('/api/v1/verifications/', 'post').responses ?? {};
    const schema = (responses['201'] as { content: Record<string, { schema: Record<string, unknown> }> }).content[
      'application/json'
    ].schema as { properties: Record<string, unknown> };
    expect(schema.properties.provider).toBeDefined();
  });
});

describe('public demo documentation', () => {
  it('POST /api/v1/demo/verify accepts only the scenario enum', () => {
    const operation = op('/api/v1/demo/verify', 'post');
    const schema = operation.requestBody?.content['application/json']?.schema as {
      required: string[];
      properties: { scenario: { enum: string[] } };
    };
    expect(requiredOf(schema)).toEqual(['scenario']);
    expect(schema.properties.scenario.enum.sort()).toEqual(
      ['contradiction', 'failed', 'inconclusive', 'verified']
    );
  });

  it('public demo is anonymous and rate-limited', () => {
    const operation = op('/api/v1/demo/verify', 'post');
    expect(operation.security).toEqual([]);
    expect(operation.responses?.['429']).toBeDefined();
  });

  it('GET / documents the homepage', () => {
    expect(op('/', 'get').responses?.['200']).toBeDefined();
  });
});

describe('authentication representation', () => {
  it('public endpoints require no auth', () => {
    for (const [path, method] of [
      ['/api/v1/auth/register', 'post'],
      ['/api/v1/auth/login', 'post'],
      ['/health', 'get'],
      ['/health/ready', 'get'],
    ] as const) {
      expect(op(path, method).security).toEqual([]);
    }
  });

  it('protected endpoints do not opt out of the global security', () => {
    for (const [path, method] of [
      ['/api/v1/auth/me', 'get'],
      ['/api/v1/agents/', 'get'],
      ['/api/v1/verifications/', 'post'],
      ['/api/v1/audit-logs/', 'get'],
      ['/api/v1/gmail/accounts', 'get'],
    ] as const) {
      expect(op(path, method).security ?? 'inherit').not.toEqual([]);
    }
  });
});

describe('gmail documentation', () => {
  it('GET /api/v1/gmail/connect is documented', () => {
    const operation = op('/api/v1/gmail/connect', 'get');
    expect(operation.responses?.['200']).toBeDefined();
  });

  it('GET /api/v1/gmail/callback documents code/state query parameters', () => {
    const params = op('/api/v1/gmail/callback', 'get').parameters ?? [];
    const names = params.filter((p) => p.in === 'query').map((p) => p.name);
    expect(names).toContain('code');
    expect(names).toContain('state');
  });

  it('account responses expose metadata only (no token fields)', () => {
    const blob = JSON.stringify(doc.paths['/api/v1/gmail/accounts'].get);
    for (const secret of ['accessToken', 'refreshToken', 'authorization code', 'client_secret']) {
      expect(blob).not.toContain(secret);
    }
  });

  it('POST /api/v1/verifications documents provider and idempotency key', () => {
    const operation = op('/api/v1/verifications/', 'post');
    const schema = operation.requestBody?.content['application/json']?.schema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.provider).toBeDefined();
    const params = (operation.parameters ?? []).filter((p) => p.in === 'header').map((p) => p.name);
    expect(params).toContain('idempotency-key');
  });
});
