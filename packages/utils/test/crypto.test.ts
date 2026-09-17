import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMETERS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/crypto/password.js';
import {
  generateToken,
  hashToken,
  tokenHashEquals,
  generatePrefixedKey,
} from '../src/crypto/tokens.js';

describe('password hashing', () => {
  it('uses the parameters docs/06 specifies', () => {
    expect(ARGON2_PARAMETERS.memoryCost).toBe(64 * 1024);
    expect(ARGON2_PARAMETERS.timeCost).toBe(3);
    expect(ARGON2_PARAMETERS.parallelism).toBe(4);
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, 'same-password')).resolves.toBe(true);
    await expect(verifyPassword(b, 'same-password')).resolves.toBe(true);
  });

  it('treats a corrupted hash as a wrong password, never a crash', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('', 'anything')).resolves.toBe(false);
  });

  it('does not ask to rehash a current hash', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
  });

  it('asks to rehash a weaker or unrecognised hash', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
    expect(needsRehash('$2b$10$somethingbcrypt')).toBe(true);
  });

  it('handles unicode and very long passwords', async () => {
    const pw = '🔐 пароль '.repeat(20);
    const hash = await hashPassword(pw);
    await expect(verifyPassword(hash, pw)).resolves.toBe(true);
  });
});

describe('opaque tokens', () => {
  it('produces 32 bytes of entropy, base64url encoded', () => {
    const token = generateToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    // URL-safe: no +, / or = to escape.
    expect(token).not.toMatch(/[+/=]/u);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 5000 }, () => generateToken()));
    expect(tokens.size).toBe(5000);
  });

  it('hashes deterministically to 32 bytes', () => {
    const token = generateToken();
    expect(hashToken(token)).toHaveLength(32);
    expect(hashToken(token).equals(hashToken(token))).toBe(true);
  });

  it('hashes different tokens differently', () => {
    expect(hashToken(generateToken()).equals(hashToken(generateToken()))).toBe(false);
  });

  it('compares hashes in constant time and survives length mismatch', () => {
    const a = hashToken('a');
    expect(tokenHashEquals(a, hashToken('a'))).toBe(true);
    expect(tokenHashEquals(a, hashToken('b'))).toBe(false);
    // Must not throw, which timingSafeEqual would on mismatched lengths.
    expect(tokenHashEquals(a, Buffer.alloc(8))).toBe(false);
  });

  it('builds a prefixed key with an indexable lookup prefix', () => {
    const { key, lookup } = generatePrefixedKey('rk_live');
    expect(key.startsWith('rk_live_')).toBe(true);
    expect(key.startsWith(lookup)).toBe(true);
    expect(lookup).toHaveLength('rk_live'.length + 1 + 8);
  });
});
