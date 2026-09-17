import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque secrets: refresh tokens, invitation tokens, email-verification and
 * password-reset tokens.
 *
 * All four follow the same shape — 32 random bytes handed to the user once,
 * and only a sha256 of them stored. A database dump therefore yields nothing
 * usable, which is the same property provider credentials get from Secrets
 * Manager (CLAUDE.md section 11).
 */

/** 32 bytes, per docs/06 section 15 ("Refresh token: 32 random bytes"). */
const TOKEN_BYTES = 32;

/**
 * A new opaque token, base64url encoded so it is safe in a URL path, a query
 * string and a cookie without further escaping.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The stored form of a token.
 *
 * sha256 rather than argon2 deliberately: these are 256 bits of full-entropy
 * random, not a human-chosen password, so there is nothing to brute force and
 * a slow KDF would only add latency to every refresh. Passwords use argon2id;
 * random tokens do not need it.
 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Constant-time comparison of two token hashes.
 *
 * Length is checked first because timingSafeEqual throws on a length
 * mismatch, and that throw would itself be a timing signal.
 */
export function tokenHashEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A prefixed, displayable API key: `rk_live_<random>`.
 *
 * The prefix is stored in clear and indexed so a key can be located without
 * scanning every hash (docs/02, api_keys.key_prefix). API keys themselves are
 * Phase 9; the generator lives here because it is the same primitive.
 */
export function generatePrefixedKey(prefix: string): { key: string; lookup: string } {
  const secret = generateToken();
  const key = `${prefix}_${secret}`;
  return { key, lookup: key.slice(0, prefix.length + 1 + 8) };
}
