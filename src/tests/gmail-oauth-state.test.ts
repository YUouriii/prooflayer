import { describe, it, expect } from 'vitest';
import {
  OAuthStateError,
  createOAuthState,
  verifyOAuthState,
} from '../integrations/gmail/oauth.js';
import { decrypt, encrypt } from '../utils/encryption.js';

// encryption utils read validated env lazily; provide test values
// (isolated per test file by vitest).
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars-min!!';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/v1/gmail/callback';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-characters!!';

const SECRET = 'test-jwt-secret-min-32-characters-long';

describe('OAuth state (CSRF protection)', () => {
  it('round-trips organization and user', () => {
    const state = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: 1000 });
    const payload = verifyOAuthState(state, { secret: SECRET, expectedOrganizationId: 'org-1', now: 1000 });
    expect(payload.organizationId).toBe('org-1');
    expect(payload.userId).toBe('user-1');
  });

  it('rejects tampered state', () => {
    const state = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: 1000 });
    const tampered = state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA');
    expect(() => verifyOAuthState(tampered, { secret: SECRET, expectedOrganizationId: 'org-1', now: 1000 })).toThrow(
      OAuthStateError
    );
  });

  it('rejects wrong secret', () => {
    const state = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: 1000 });
    expect(() =>
      verifyOAuthState(state, { secret: 'different-secret-min-32-chars-longer', expectedOrganizationId: 'org-1', now: 1000 })
    ).toThrow(OAuthStateError);
  });

  it('rejects expired state', () => {
    const state = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: 1000 });
    expect(() =>
      verifyOAuthState(state, { secret: SECRET, expectedOrganizationId: 'org-1', now: 1000 + 11 * 60 * 1000 })
    ).toThrow(/Expired/);
  });

  it('rejects organization mismatch (session swap)', () => {
    const state = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: 1000 });
    expect(() => verifyOAuthState(state, { secret: SECRET, expectedOrganizationId: 'org-2', now: 1000 })).toThrow(
      /mismatch/
    );
  });

  it('rejects malformed state', () => {
    for (const bad of ['', 'no-dot', '.sig', 'a.b.c']) {
      expect(() => verifyOAuthState(bad, { secret: SECRET, expectedOrganizationId: 'org-1', now: 1000 })).toThrow(
        OAuthStateError
      );
    }
  });

  it('generates unique nonces', () => {
    const a = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: 1000 });
    const b = createOAuthState({ organizationId: 'org-1', userId: 'user-1', secret: SECRET, now: 1000 });
    expect(a).not.toBe(b);
  });
});

describe('token encryption round-trip', () => {
  it('encrypts and decrypts access tokens', () => {
    const token = 'ya29.fake-access-token-123';
    expect(decrypt(encrypt(token))).toBe(token);
  });

  it('produces different ciphertexts for identical plaintexts', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('rejects tampered ciphertext', () => {
    const cipher = encrypt('secret');
    const tampered = cipher.slice(0, -4) + 'AAAA';
    expect(() => decrypt(tampered)).toThrow();
  });
});
