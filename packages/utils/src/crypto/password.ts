import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * Argon2id. The library exports this as an ambient const enum, which
 * verbatimModuleSyntax forbids reading as a value, so the discriminant is
 * pinned here instead. Left explicit rather than relying on the library
 * default: which variant hashes your passwords is not a thing to inherit
 * silently from a dependency's defaults.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * Password hashing parameters from docs/06 section 15: argon2id, m=64MB, t=3,
 * p=4.
 *
 * These are cost parameters, not preferences. Lowering memoryCost is the
 * change that quietly turns a stolen database dump from useless into
 * crackable, so they live here as named constants rather than inline at a
 * call site where a future edit would look harmless.
 */
export const ARGON2_PARAMETERS = {
  algorithm: ARGON2ID,
  /** 64 MiB, expressed in KiB as the library expects. */
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 4,
} as const;

/**
 * Hashes a password for storage.
 *
 * The returned string is a PHC-format encoding that carries the salt and the
 * parameters with it, so a future parameter change can be detected on login
 * and the hash upgraded in place rather than invalidating every password.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_PARAMETERS);
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash. A corrupted or
 * truncated hash column must read as "wrong password", never as a crash that
 * a caller might accidentally catch into a success path.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was produced with weaker parameters than current
 * policy, and should be re-hashed on the next successful login.
 *
 * Parsed from the PHC string rather than trusted: m, t and p are encoded in
 * it, so this stays correct when ARGON2_PARAMETERS changes.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/u.exec(storedHash);
  if (match === null) return true; // unknown format: re-hash it

  const memory = Number(match[1]);
  const time = Number(match[2]);
  const parallelism = Number(match[3]);

  return (
    memory < ARGON2_PARAMETERS.memoryCost ||
    time < ARGON2_PARAMETERS.timeCost ||
    parallelism < ARGON2_PARAMETERS.parallelism
  );
}
