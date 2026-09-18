import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '@relayd/db/schema';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'packages/db/migrations');

/**
 * CLAUDE.md section 8: "RLS on every tenant table."
 *
 * The tenant tables are not listed here by hand. They are derived from the
 * Drizzle schema — any table carrying a workspace_id is tenant-owned — so a
 * table added in a later phase fails this test until a migration gives it
 * RLS. A hand-maintained list would drift the first time someone was in a
 * hurry, which is exactly when it matters.
 */

/**
 * Tables that are deliberately NOT tenant-scoped, with the reason.
 *
 * A user exists before any workspace is chosen and may belong to several. The
 * login, refresh and password-reset paths all run with no workspace in
 * context, so a workspace predicate on these would make authentication
 * impossible. They are protected by layer three instead: their repositories
 * live in packages/db/repositories/global/ as named exceptions (docs/06 s15).
 */
const NON_TENANT_TABLES = new Map<string, string>([
  ['users', 'spans workspaces; exists before one is chosen'],
  ['sessions', 'belongs to a user, not a workspace; used before scope exists'],
  ['user_tokens', 'verification and reset tokens belong to a person; reset runs before scope exists'],
  [
    'scheduled_jobs',
    'operator configuration for the whole deployment; read by the scheduler on a direct connection before any workspace exists (R35)',
  ],
  ['plans', 'the plan catalogue; identical for every workspace, so a policy would have nothing to compare'],
  ['features', 'the feature catalogue; same reason as plans'],
  ['plan_features', 'the plan catalogue; same reason as plans'],
  ['prices', 'the plan catalogue; same reason as plans'],
  ['coupons', 'mirrors Stripe coupons, which are account-wide rather than per workspace'],
  [
    'billing_reconciliation_runs',
    'a record of what the nightly reconciler did across every workspace; it has no single workspace to be scoped to (R19)',
  ],
]);

/**
 * Tables carrying a NULLABLE `workspace_id` that are deliberately not
 * tenant-scoped.
 *
 * These are the billing ingest tables. A provider event arrives before we
 * know which workspace it belongs to — that is the whole reason
 * `workspace_id` is nullable on them — and an RLS policy would discard
 * exactly the events that most need keeping. They are operator-scoped: only
 * the allowlisted cross-tenant job types in `packages/queue/global-jobs.ts`
 * touch them, and no request path does.
 *
 * Separate from `NON_TENANT_TABLES` because these tables *have* the column,
 * so a reader seeing one would otherwise reasonably expect a policy.
 */
const OPERATOR_SCOPED_TABLES = new Map<string, string>([
  [
    'payment_webhook_events',
    'the Stripe inbox; an event may arrive before its workspace is known, and refusing it would lose it (R17)',
  ],
  [
    'billing_refetch_queue',
    'the coalescing queue behind the inbox; one row per Stripe object, which may have no workspace yet (R17)',
  ],
]);

async function allMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const parts = await Promise.all(
    files.map((f) => readFile(path.join(migrationsDir, f), 'utf8')),
  );
  return parts.join('\n');
}

/** Every pgTable exported by the schema, as [name, hasWorkspaceColumn]. */
function schemaTables(): { name: string; tenantOwned: boolean }[] {
  const out: { name: string; tenantOwned: boolean }[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const name = getTableName(value);
    const columns = Object.keys(getTableColumns(value));
    // `workspaces` is itself the tenant, keyed by id rather than workspace_id.
    const tenantOwned = columns.includes('workspaceId') || name === 'workspaces';
    out.push({ name, tenantOwned });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

describe('RLS coverage', () => {
  it('finds the schema tables', () => {
    const names = schemaTables().map((t) => t.name);
    expect(names).toContain('workspaces');
    expect(names).toContain('users');
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it('enables and forces RLS on every tenant-owned table', async () => {
    const sql = await allMigrationSql();
    const missing: string[] = [];

    for (const { name, tenantOwned } of schemaTables()) {
      if (!tenantOwned) continue;
      if (OPERATOR_SCOPED_TABLES.has(name)) continue;
      if (!sql.includes(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`)) {
        missing.push(`${name}: no ENABLE ROW LEVEL SECURITY`);
      }
      // Without FORCE, the table owner bypasses the policy entirely.
      if (!sql.includes(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`)) {
        missing.push(`${name}: no FORCE ROW LEVEL SECURITY`);
      }
      if (!sql.includes(`CREATE POLICY ${name}_tenant ON ${name}`)) {
        missing.push(`${name}: no ${name}_tenant policy`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('every policy reads app.workspace_id and fails closed when unset', async () => {
    const sql = await allMigrationSql();
    const policies = sql.match(/CREATE POLICY[\s\S]*?;/gu) ?? [];
    expect(policies.length).toBeGreaterThan(0);

    for (const policy of policies) {
      expect(policy).toContain("current_setting('app.workspace_id', true)");
      // NULLIF turns an empty setting into NULL rather than erroring on the
      // uuid cast, so unset scope denies rather than throws.
      expect(policy).toContain('NULLIF');
    }
  });

  it('non-tenant tables are exempt only by explicit, documented decision', () => {
    for (const { name, tenantOwned } of schemaTables()) {
      if (tenantOwned) continue;
      expect(
        NON_TENANT_TABLES.has(name),
        `${name} has no workspace_id and no documented reason for being cross-tenant`,
      ).toBe(true);
    }
  });

  it('exempts a table with a workspace_id only by explicit, documented decision', async () => {
    // The stricter half. A table that carries the column and has no policy is
    // the shape a reader assumes is protected, so the exemption has to be
    // written down rather than inferred from the absence of a policy.
    const sql = await allMigrationSql();

    for (const name of OPERATOR_SCOPED_TABLES.keys()) {
      expect(
        sql.includes(`CREATE POLICY ${name}_tenant ON ${name}`),
        `${name} is listed as operator-scoped but a migration gives it a tenant policy`,
      ).toBe(false);
    }
  });

  it('creates both database roles with the right BYPASSRLS posture', async () => {
    const sql = await allMigrationSql();
    expect(sql).toContain('CREATE ROLE relayd_app LOGIN');
    expect(sql).toContain('CREATE ROLE relayd_global LOGIN BYPASSRLS');
    // relayd_app must never acquire BYPASSRLS, which would silently void
    // layer four everywhere at once.
    expect(sql).toContain('ALTER ROLE relayd_app NOBYPASSRLS');
  });
});
