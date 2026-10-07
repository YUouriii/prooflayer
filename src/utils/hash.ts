import argon2 from 'argon2';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function hashApiKey(apiKey: string): Promise<string> {
  return argon2.hash(apiKey, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyApiKey(hash: string, apiKey: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, apiKey);
  } catch {
    return false;
  }
}

export function generateApiKey(prefix: string = 'pl'): { key: string; prefix: string; identifier: string } {
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const randomPart = Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('');
  const identifier = randomPart.substring(0, 8);
  const key = `${prefix}_${identifier}_${randomPart.substring(8)}`;
  return { key, prefix, identifier };
}

export function extractApiKeyPrefix(apiKey: string): string | null {
  const match = apiKey.match(/^([a-z]+)_[a-f0-9]{8}_[a-f0-9]+$/);
  return match ? match[1] : null;
}