import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashAddress } from '../src/repositories/global/block-list.js';

/**
 * The cross-workspace block list (migration 0018; docs/06 "Shared signals").
 *
 * docs/06: "Addresses that complained in any workspace go on a global block
 * list applied everywhere."
 *
 * ## What the hashing is for
 *
 * In plaintext this table would be a list of everyone who has ever
 * complained, across every customer — the most sensitive thing in the
 * database and a standing temptation. Hashed and peppered, it answers "is
 * this one blocked" and nothing else.
 *
 * The queries need Postgres and land with the integration suite. What is
 * testable here is the hashing, which is the part where a mistake is silent:
 * an unpeppered hash still works perfectly and is brute-forceable in an
 * afternoon.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.join(here, '../src/repositories/global/block-list.ts'),
  'utf8',
);
const migration = readFileSync(
  path.join(here, '../migrations/0018_global_block_list.sql'),
  'utf8',
);

const PEPPER = 'test-pepper';

describe('hashing an address', () => {
  it('is stable', () => {
    expect(hashAddress('a@example.test', PEPPER)).toEqual(hashAddress('a@example.test', PEPPER));
  });

  it('normalises case and whitespace', () => {
    // The same person, typed differently in two workspaces. A block list
    // that missed `A@Example.test` after seeing `a@example.test` would miss
    // most of what it is for.
    const canonical = hashAddress('a@example.test', PEPPER);

    expect(hashAddress('A@Example.Test', PEPPER)).toEqual(canonical);
    expect(hashAddress('  a@example.test  ', PEPPER)).toEqual(canonical);
  });

  it('distinguishes different addresses', () => {
    expect(hashAddress('a@example.test', PEPPER)).not.toEqual(
      hashAddress('b@example.test', PEPPER),
    );
  });

  it('depends on the pepper', () => {
    // The property the pepper exists for. Without it, a stolen copy of this
    // table can be brute-forced against a dictionary of email addresses —
    // the space of real addresses is small enough to enumerate, so an
    // unpeppered SHA-256 protects nobody.
    expect(hashAddress('a@example.test', 'one')).not.toEqual(
      hashAddress('a@example.test', 'two'),
    );
  });

  it('cannot be confused by moving the boundary between pepper and address', () => {
    // Without a separator, pepper `ab` + address `c` and pepper `a` +
    // address `bc` hash identically. A NUL is used because it cannot appear
    // in either half.
    expect(hashAddress('c', 'ab')).not.toEqual(hashAddress('bc', 'a'));
  });

  it('produces 32 bytes, matching the bytea column', () => {
    expect(hashAddress('a@example.test', PEPPER)).toHaveLength(32);
  });
});

describe('the plaintext never reaches the repository', () => {
  it('takes hashes, not addresses', () => {
    // Read from the source, because a method that accepted an address and
    // hashed it internally would pass every functional test while putting
    // the plaintext into a query log and a slow-query report.
    expect(source).toContain('blockedAmong(hashes: readonly Buffer[])');
    expect(source).not.toMatch(/blockedAmong\([a-z]*addresses/u);
  });

  it('reads the pepper from its caller rather than the environment', () => {
    // `packages/config` is the only place that reads the environment
    // (CLAUDE.md section 7), and a test needs to supply its own.
    expect(source).not.toContain('process.env');
  });
});

describe('the table is deliberately not tenant-scoped', () => {
  it('has no workspace_id', () => {
    // A workspace_id would defeat the entire feature: the point is that an
    // address complaining in workspace A is blocked in workspace B.
    const table = /CREATE TABLE global_blocked_addresses \(([\s\S]*?)\n\);/u.exec(migration)?.[1];

    expect(table).toBeDefined();
    expect(table).not.toContain('workspace_id');
  });

  it('says why it has no RLS, rather than leaving a reader to guess', () => {
    // Every other tenant table in the schema has a policy. A reader finding
    // one without needs the reason next to it, not in a test file.
    expect(migration).toContain('Deliberately no RLS');
  });

  it('counts distinct workspaces', () => {
    // One workspace is a recipient who changed their mind; five is an
    // address being sold on a list, and the difference decides what to do
    // about the workspaces that keep mailing it.
    expect(migration).toContain('workspace_count');
  });
});

describe('blocked link domains expire', () => {
  it('has an expiry column', () => {
    // Domains get cleaned up, resold and reused. A permanent block list
    // slowly fills with entries nobody can justify and that nobody dares
    // remove.
    expect(migration).toContain('expires_at');
  });

  it('treats a null expiry as permanent rather than as expired', () => {
    // `null > now()` is null in SQL, not true. A query relying on the
    // comparison alone would silently drop every permanent block — the
    // entries that matter most.
    expect(source).toContain('isNull(blockedLinkDomains.expiresAt)');
  });
});
