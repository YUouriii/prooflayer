import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hashPassword, verifyPassword, hashApiKey, verifyApiKey, generateApiKey, extractApiKeyPrefix } from '../utils/hash.js';

describe('Hash Utilities', () => {
  describe('hashPassword / verifyPassword', () => {
    it('should hash and verify a password', async () => {
      const password = 'securePassword123';
      const hash = await hashPassword(password);
      const valid = await verifyPassword(hash, password);
      expect(valid).toBe(true);
    });

    it('should reject wrong password', async () => {
      const password = 'securePassword123';
      const hash = await hashPassword(password);
      const valid = await verifyPassword(hash, 'wrongPassword');
      expect(valid).toBe(false);
    });

    it('should produce different hashes for same password', async () => {
      const password = 'securePassword123';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('hashApiKey / verifyApiKey', () => {
    it('should hash and verify an API key', async () => {
      const apiKey = 'pl_live_abc123def456';
      const hash = await hashApiKey(apiKey);
      const valid = await verifyApiKey(hash, apiKey);
      expect(valid).toBe(true);
    });

    it('should reject wrong API key', async () => {
      const apiKey = 'pl_live_abc123def456';
      const hash = await hashApiKey(apiKey);
      const valid = await verifyApiKey(hash, 'pl_live_wrongkey');
      expect(valid).toBe(false);
    });
  });

  describe('generateApiKey', () => {
    it('should generate a valid API key with prefix', () => {
      const { key, prefix, identifier } = generateApiKey('pl');
      expect(key).toMatch(/^pl_[a-f0-9]{8}_[a-f0-9]{40}$/);
      expect(prefix).toBe('pl');
      expect(identifier).toMatch(/^[a-f0-9]{8}$/);
    });

    it('should generate unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const { key } = generateApiKey('pl');
        keys.add(key);
      }
      expect(keys.size).toBe(100);
    });
  });

  describe('extractApiKeyPrefix', () => {
    it('should extract prefix from valid key', () => {
      // Generated format: prefix_8hex_40hex (from generateApiKey)
      // Only valid hex chars: 0-9, a-f
      const validKey1 = 'pl_abcdef12_1234567890abcdef1234567890abcdef1234'; // 8 + 40 hex
      const validKey2 = 'pl_fedcba98_abcdef1234567890abcdef1234567890abcd'; // 8 + 40 hex
      expect(extractApiKeyPrefix(validKey1)).toBe('pl');
      expect(extractApiKeyPrefix(validKey2)).toBe('pl');
    });

    it('should return null for invalid key', () => {
      expect(extractApiKeyPrefix('invalid')).toBeNull();
      expect(extractApiKeyPrefix('')).toBeNull();
      expect(extractApiKeyPrefix('pl_short')).toBeNull();
      expect(extractApiKeyPrefix('pl_abc')).toBeNull();
    });
  });
});