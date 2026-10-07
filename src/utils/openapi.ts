/**
 * Shared OpenAPI (JSON Schema) components.
 *
 * IMPORTANT: Fastify/AJV does not understand Zod objects, so route schemas
 * must be plain JSON Schema (see the /register 500 bug: a Zod-only schema
 * meant invalid bodies were never rejected). These components mirror the
 * Zod schemas in validation.ts field-for-field — same required flags, same
 * length/format constraints, never stricter.
 *
 * Conventions used to keep runtime behavior identical:
 * - Querystring page/limit stay untyped strings on the wire (Fastify does
 *   not coerce them); descriptions state the integer contract.
 * - Nullable / free-form JSON fields (dates that may be null, metadata,
 *   claim details) carry no `type` so AJV/fast-json-stringify never reject
 *   or strip legitimate values; precision lives in descriptions/examples.
 * - Error responses use pass-through `{ type: 'object' }` so the global
 *   error handler's payloads are never altered.
 */

export const dateTimeOrNull = {
  description: 'ISO-8601 timestamp, or null when not set.',
};

export const freeJson = {
  description: 'Free-form JSON object.',
};

export const paginationSchema = {
  type: 'object',
  required: ['page', 'limit', 'total', 'totalPages'],
  properties: {
    page: { type: 'integer', minimum: 1, example: 1 },
    limit: { type: 'integer', minimum: 1, example: 20 },
    total: { type: 'integer', minimum: 0, example: 3 },
    totalPages: { type: 'integer', minimum: 0, example: 1 },
  },
};

export const pageQuery = {
  description: 'Page number (positive integer). Defaults to 1.',
};

export const limitQuery = {
  description: 'Items per page, max 100. Defaults to 20.',
};

export const cuidParam = {
  type: 'string',
  description: 'CUID identifier.',
};

export const userPublicSchema = {
  type: 'object',
  required: ['id', 'email'],
  properties: {
    id: { type: 'string', description: 'User ID.' },
    email: { type: 'string', format: 'email', description: 'User email.' },
    name: { description: 'Display name, null when unset.' },
  },
};

export const organizationSchema = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', description: 'Organization ID.' },
    name: { type: 'string', description: 'Organization name.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/**
 * Slim organization reference returned by auth endpoints (register/login/me),
 * which project only { id, name }. A full-row schema here would 500 every
 * call, because response serialization enforces `required`.
 */
export const organizationRefSchema = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string', description: 'Organization ID.' },
    name: { type: 'string', description: 'Organization name.' },
  },
};

export const organizationWithCountSchema = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', description: 'Organization ID.' },
    name: { type: 'string', description: 'Organization name.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    _count: {
      type: 'object',
      required: ['users', 'agents', 'apiKeys'],
      properties: {
        users: { type: 'integer' },
        agents: { type: 'integer' },
        apiKeys: { type: 'integer' },
      },
    },
  },
};

export const agentSchema = {
  type: 'object',
  required: ['id', 'name', 'status', 'organizationId', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', description: 'Agent ID.' },
    name: { type: 'string', description: 'Agent name.' },
    description: { description: 'Agent description, null when unset.' },
    status: { type: 'string', enum: ['active', 'inactive'] },
    organizationId: { type: 'string', description: 'Owning organization ID.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const apiKeyPublicSchema = {
  type: 'object',
  required: ['id', 'name', 'keyPrefix', 'permissions', 'createdAt'],
  properties: {
    id: { type: 'string', description: 'API key ID (not the secret).' },
    name: { type: 'string', description: 'Key label.' },
    keyPrefix: { type: 'string', description: 'Public prefix used for lookup.', example: 'pl' },
    permissions: { type: 'array', items: { type: 'string' }, example: ['verify:email', 'read:history'] },
    lastUsedAt: { ...dateTimeOrNull },
    expiresAt: { ...dateTimeOrNull },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const emailSentClaimSchema = {
  type: 'object',
  required: ['type', 'recipient', 'subject'],
  properties: {
    type: { type: 'string', enum: ['email_sent'] },
    recipient: { type: 'string', format: 'email', description: 'Claimed recipient, e.g. john@example.com.' },
    subject: { type: 'string', minLength: 1, maxLength: 500, description: 'Claimed subject, e.g. Invoice #4821.' },
    attachment: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      description: 'Expected attachment filename (e.g. invoice.pdf). Omit when no attachment is expected.',
    },
  },
};

export const evidenceItemSchema = {
  type: 'object',
  required: ['type', 'result'],
  properties: {
    type: { type: 'string', description: 'Machine-readable check name.', example: 'recipient_match' },
    expected: { description: 'What the claim asserted.' },
    observed: { description: 'What the external system showed (null when nothing observed).' },
    result: { type: 'string', enum: ['PASS', 'FAIL', 'UNKNOWN'] },
    detail: { type: 'string', description: 'Optional extra context.' },
    source: { type: 'string', description: 'Evidence source, e.g. demo or gmail.' },
  },
};

export const verificationResultSchema = {
  type: 'object',
  required: [
    'id',
    'organizationId',
    'agentId',
    'provider',
    'actionType',
    'claim',
    'status',
    'confidence',
    'reason',
    'evidence',
    'createdAt',
    'verifiedAt',
  ],
  properties: {
    id: { type: 'string', description: 'Verification ID.' },
    organizationId: { type: 'string', description: 'Owning organization ID (from auth context, never client input).' },
    agentId: { type: 'string', description: 'Verified agent ID.' },
    provider: { type: 'string', description: 'Evidence source used, e.g. demo or gmail.' },
    actionType: { type: 'string', example: 'email_sent' },
    claim: emailSentClaimSchema,
    status: { type: 'string', enum: ['VERIFIED', 'FAILED', 'INCONCLUSIVE'] },
    confidence: { type: 'number', minimum: 0, maximum: 1, example: 0.98 },
    reason: { type: 'string', description: 'Why this status was produced.' },
    evidence: { type: 'array', items: evidenceItemSchema },
    createdAt: { type: 'string', format: 'date-time' },
    verifiedAt: { type: 'string', format: 'date-time' },
  },
};

export const auditLogSchema = {
  type: 'object',
  required: ['id', 'organizationId', 'action', 'metadata', 'createdAt'],
  properties: {
    id: { type: 'string' },
    organizationId: { type: 'string' },
    userId: { description: 'Actor user ID, null for API-key-only calls.' },
    agentId: { description: 'Related agent ID, when applicable.' },
    apiKeyId: { description: 'Calling API key ID, when applicable.' },
    action: { type: 'string', example: 'verification.create' },
    metadata: { ...freeJson },
    ipAddress: { type: 'string' },
    userAgent: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        name: { description: 'Display name, null when unset.' },
      },
    },
    agent: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    },
    apiKey: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        keyPrefix: { type: 'string' },
      },
    },
  },
};

export const gmailAccountSchema = {
  type: 'object',
  required: ['id', 'organizationId', 'provider', 'email', 'scopes', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', description: 'Gmail account ID.' },
    organizationId: { type: 'string', description: 'Owning organization ID.' },
    provider: { type: 'string', example: 'gmail' },
    email: { type: 'string', format: 'email', description: 'Connected mailbox address.' },
    scopes: { type: 'array', items: { type: 'string' }, description: 'Granted OAuth scopes.' },
    status: {
      type: 'string',
      enum: ['CONNECTED', 'DISCONNECTED', 'REVOKED', 'ERROR'],
      description: 'Connection status.',
    },
    expiresAt: { ...dateTimeOrNull },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const messageSchema = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string' },
  },
};

/**
 * Error response shape. Properties must enumerate every field the error
 * paths send — fast-json-stringify drops undeclared properties, and a
 * bare `{ type: 'object' }` serializes error bodies to `{}`.
 */
export const errorSchema = {
  type: 'object',
  description: 'Error payload: { error, message, details?, requestId?, statusCode? }.',
  properties: {
    error: { type: 'string', description: 'Stable error name, e.g. Unauthorized.' },
    message: { type: 'string', description: 'Human-readable detail.' },
    details: { description: 'Validation details, present on 400s.' },
    requestId: { type: 'string', description: 'Correlation ID echo.' },
    statusCode: { type: 'number', description: 'HTTP status (rate-limit responses).' },
  },
};

export const badRequest = {
  description: 'Invalid input.',
  content: { 'application/json': { schema: errorSchema } },
};

export const unauthorized = {
  description: 'Missing or invalid authentication (session cookie or Bearer API key).',
  content: { 'application/json': { schema: errorSchema } },
};

export const forbidden = {
  description: "Authenticated, but the resource belongs to another organization.",
  content: { 'application/json': { schema: errorSchema } },
};

export const notFound = {
  description: 'Resource not found (includes resources owned by another organization).',
  content: { 'application/json': { schema: errorSchema } },
};

export const conflict = {
  description: 'Conflicting state (e.g. email already registered, key already revoked).',
  content: { 'application/json': { schema: errorSchema } },
};

export const rateLimited = {
  description: 'Too many requests.',
  content: { 'application/json': { schema: errorSchema } },
};

export const serverError = {
  description: 'Unexpected server error.',
  content: { 'application/json': { schema: errorSchema } },
};

export const json = (schema: unknown) => ({
  'application/json': { schema },
});

/**
 * OpenAPI server URL. Local development falls back to localhost; production
 * deployments set PUBLIC_BASE_URL to the public HTTPS origin so Swagger UI
 * targets the real service instead of a localhost port. Never advertise
 * 0.0.0.0 (bind address, not a URL). Never hardcode a host URL here.
 */
export function serverUrl(port: number, publicBaseUrl?: string): string {
  const base = publicBaseUrl?.trim().replace(/\/+$/, '');
  if (base) return base;
  return `http://localhost:${port}`;
}

export const apiSecuritySchemes = {
  apiKey: {
    type: 'apiKey' as const,
    name: 'Authorization',
    in: 'header' as const,
    description: 'API Key authentication (Bearer token)',
  },
  session: {
    type: 'apiKey' as const,
    name: 'Cookie',
    in: 'cookie' as const,
    description: 'Session cookie authentication',
  },
};

export const ok = (schema: unknown, description: string) => ({
  description,
  content: json(schema),
});
