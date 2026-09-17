import { customType } from 'drizzle-orm/pg-core';

/**
 * Postgres types Drizzle has no built-in helper for.
 *
 * The migration SQL is the authoritative DDL — drizzle-kit generates, a human
 * edits, and the numbered file is what runs (docs/01, "Migration discipline").
 * These exist so queries are typed correctly against columns that already
 * exist, not so Drizzle can create them.
 */

/**
 * Case-insensitive text. docs/02 uses it for users.email, workspaces.slug and
 * workspace_invitations.email, which removes an entire class of duplicate
 * account bug without a functional index on lower(...).
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * Raw bytes. Every use here is a hash — refresh tokens, invitation tokens —
 * or KMS-enveloped ciphertext. None of them is ever a plaintext secret.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * An IP address. Stored on sessions and audit_logs for forensics.
 *
 * Note these are NOT the tracking IPs: those are hashed with a daily rotating
 * salt and never stored raw (CLAUDE.md section 11).
 */
export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'inet';
  },
});
