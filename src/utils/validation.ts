import { z } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128),
    name: z.string().min(1).max(100).optional(),
    organizationName: z.string().min(1).max(100),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
});

export const createOrganizationSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
  }),
});

export const updateOrganizationSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
  }),
  params: z.object({
    id: z.string().cuid(),
  }),
});

export const createAgentSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
  }),
});

export const updateAgentSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  }),
  params: z.object({
    id: z.string().cuid(),
  }),
});

export const createApiKeySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    permissions: z.array(z.string()).default(['verify:email', 'read:history']),
    expiresAt: z.string().datetime().optional(),
  }),
});

export const revokeApiKeySchema = z.object({
  params: z.object({
    id: z.string().cuid(),
  }),
});

export const listQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const idParamSchema = z.object({
  params: z.object({
    id: z.string().cuid(),
  }),
});

export const emailSentClaimSchema = z.object({
  type: z.literal('email_sent'),
  recipient: z.string().email(),
  subject: z.string().min(1).max(500),
  attachment: z.string().min(1).max(255).optional(),
});

export const verificationProviderSchema = z.enum(['demo', 'gmail']);

export const createVerificationSchema = z.object({
  body: z.object({
    agentId: z.string().cuid(),
    claim: emailSentClaimSchema,
    provider: verificationProviderSchema.optional(),
  }),
});

export const gmailCallbackSchema = z.object({
  query: z.object({
    code: z.string().min(1).max(2000),
    state: z.string().min(1).max(2000),
  }),
});

export const getVerificationSchema = z.object({
  params: z.object({
    id: z.string().cuid(),
  }),
});

export const auditQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    action: z.string().optional(),
    userId: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  }),
});