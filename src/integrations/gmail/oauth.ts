/**
 * Google OAuth 2.0 helpers.
 *
 * CSRF protection is stateless: the `state` parameter is an HMAC-signed
 * payload (org + user + nonce + expiry) keyed with JWT_SECRET. The callback
 * verifies the signature, the expiry, and that the state organization
 * matches the authenticated session organization. Short expiry (10 min)
 * bounds replay; no server-side state store is required.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { GMAIL_SCOPES } from './types.js';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  organizationId: string;
  userId: string;
  nonce: string;
  expiresAt: number;
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

function base64UrlEncode(data: Buffer | string): string {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

export function createOAuthState(
  input: { organizationId: string; userId: string; secret: string; now?: number; nonce?: string }
): string {
  const now = input.now ?? Date.now();
  const payload: OAuthStatePayload = {
    organizationId: input.organizationId,
    userId: input.userId,
    nonce: input.nonce ?? randomBytes(16).toString('hex'),
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(createHmac('sha256', input.secret).update(encoded).digest());
  return `${encoded}.${signature}`;
}

export function verifyOAuthState(
  state: string,
  input: { secret: string; expectedOrganizationId: string; now?: number }
): OAuthStatePayload {
  const now = input.now ?? Date.now();
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) {
    throw new OAuthStateError('Malformed OAuth state');
  }
  const expected = base64UrlEncode(createHmac('sha256', input.secret).update(encoded).digest());
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new OAuthStateError('Invalid OAuth state signature');
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded).toString('utf8')) as OAuthStatePayload;
  } catch {
    throw new OAuthStateError('Malformed OAuth state payload');
  }
  if (!payload.organizationId || !payload.userId || !payload.expiresAt) {
    throw new OAuthStateError('Malformed OAuth state payload');
  }
  if (payload.expiresAt <= now) {
    throw new OAuthStateError('Expired OAuth state');
  }
  if (payload.organizationId !== input.expectedOrganizationId) {
    throw new OAuthStateError('OAuth state organization mismatch');
  }
  return payload;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  scope?: string;
}

/** Injectable seam: production uses googleapis, tests use fakes. */
export interface OAuthClient {
  generateAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  refreshAccessToken(refreshToken: string): Promise<OAuthTokens>;
  revokeToken(token: string): Promise<void>;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createGoogleOAuthClient(config: GoogleOAuthConfig): OAuthClient {
  const factory = (): OAuth2Client =>
    new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);

  return {
    generateAuthUrl(state: string): string {
      return factory().generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [...GMAIL_SCOPES],
        state,
      });
    },
    async exchangeCode(code: string): Promise<OAuthTokens> {
      const client = factory();
      const { tokens } = await client.getToken(code);
      if (!tokens.access_token) {
        throw new OAuthStateError('Google did not return an access token');
      }
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
        expiryDate: tokens.expiry_date ?? undefined,
        scope: tokens.scope,
      };
    },
    async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
      const client = factory();
      client.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await client.refreshAccessToken();
      if (!credentials.access_token) {
        throw new OAuthStateError('Google did not return a refreshed access token');
      }
      return {
        accessToken: credentials.access_token,
        expiryDate: credentials.expiry_date ?? undefined,
        scope: credentials.scope,
      };
    },
    async revokeToken(token: string): Promise<void> {
      await factory().revokeToken(token);
    },
  };
}
