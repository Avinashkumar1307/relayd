import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, uuidv7 } from '@relayd/db';
import { GLOBAL_JOB_TYPES, QUEUE_NAMES, isGlobalJob } from '@relayd/queue';
import { requireContainers, startPostgres } from '../src/containers.js';
import type { StartedPostgres } from '../src/containers.js';

/**
 * Tenant-isolation suite, parts 3, 4 and 5 (docs/06 section 15).
 *
 * Parts 1 and 6 — the endpoint matrix and the fuzz test — run at the HTTP
 * boundary in apps/api and need no database. Part 2, the repository reflection
 * test, is in repository-scope.isolation.test.ts. These three need real
 * Postgres, because what they test IS Postgres: row-level security, foreign
 * key enforcement across tenants, and the role a job connects as.
 *
 * Skips without Docker rather than passing. In CI, CI=true turns a missing
 * daemon into a failure.
 */

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

const gate = await requireContainers();
const describeIntegration = gate.available ? describe : describe.skip;

if (!gate.available) {
  process.stdout.write(`\n[isolation] SKIPPED parts 3-5: ${gate.reason}\n`);
}

describeIntegration('tenant isolation against real Postgres', () => {
  let postgres: StartedPostgres;
  /** Superuser connection: sets up fixtures and bypasses RLS. */
  let admin: pg.Client;
  /** Connects as relayd_app, where RLS is enforced. */
  let app: pg.Client;

  const workspaceA = uuidv7();
  const workspaceB = uuidv7();
  const ownerA = uuidv7();
  const ownerB = uuidv7();

  beforeAll(async () => {
    postgres = await startPostgres();
    await runMigrations({ connectionString: postgres.url, directory: migrationsDir });

    admin = new pg.Client({ connectionString: postgres.url });
    await admin.connect();

    // The migration creates relayd_app with LOGIN and no password, which
    // cannot authenticate. Give it one here so the test can connect AS it —
    // this is exactly the out-of-band step an operator performs.
    await admin.query("ALTER ROLE relayd_app WITH PASSWORD 'test-only'");

    const url = new URL(postgres.url);
    url.username = 'relayd_app';
    url.password = 'test-only';
    app = new pg.Client({ connectionString: url.toString() });
    await app.connect();

    // Two workspaces with an owner each.
    for (const [user, workspace, name] of [
      [ownerA, workspaceA, 'Workspace A'],
      [ownerB, workspaceB, 'Workspace B'],
    ] as const) {
      await admin.query(
        'INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
        [user, `${user}@example.com`, name, 'x'],
      );
      await admin.query(
        'INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)',
        // The slug comes from the END of the id, not the start. These are
        // UUIDv7s: the leading characters are the timestamp, so two ids
        // minted in the same millisecond share their first twelve and the
        // pair collided on uq_workspaces_slug, failing this suite in its
        // setup before a single isolation assertion ran.
        [workspace, name, workspace.slice(-12), user],
      );
      await admin.query(
        'INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [uuidv7(), workspace, user, 'owner'],
      );
    }
  }, 240_000);

  afterAll(async () => {
    await app?.end();
    await admin?.end();
    await postgres?.stop();
  }, 60_000);

  /** Runs a query as relayd_app with scope set, exactly as scoped() does. */
  const asWorkspace = async <T extends pg.QueryResultRow>(
    workspaceId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const { rows } = await app.query<T>(sql, params);
      await app.query('COMMIT');
      return rows;
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  };

  describe('part 3: RLS returns only the scoped workspace', () => {
    it('sees its own workspace and not the other', async () => {
      const rows = await asWorkspace<{ id: string }>(workspaceA, 'SELECT id FROM workspaces');
      expect(rows.map((r) => r.id)).toEqual([workspaceA]);
    });

    it('sees only its own members', async () => {
      const rows = await asWorkspace<{ user_id: string }>(
        workspaceB,
        'SELECT user_id FROM workspace_members',
      );
      expect(rows.map((r) => r.user_id)).toEqual([ownerB]);
    });

    it('cannot reach the other workspace even by naming its id explicitly', async () => {
      const rows = await asWorkspace<{ id: string }>(
        workspaceA,
        'SELECT id FROM workspaces WHERE id = $1',
        [workspaceB],
      );
      expect(rows).toEqual([]);
    });

    it('returns nothing at all when scope is unset', async () => {
      // Fails closed: NULLIF turns the unset setting into NULL, and
      // `workspace_id = NULL` is never true.
      await app.query('BEGIN');
      const { rows } = await app.query('SELECT id FROM workspaces');
      await app.query('COMMIT');
      expect(rows).toEqual([]);
    });

    it('cannot write into another workspace', async () => {
      await expect(
        asWorkspace(
          workspaceA,
          'INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)',
          [uuidv7(), workspaceB, ownerA, 'admin'],
        ),
      ).rejects.toThrow();
    });

    it('scope does not survive the transaction that set it', async () => {
      // The whole reason for SET LOCAL semantics: under transaction pooling
      // the connection goes back to the pool and is handed to another tenant.
      await asWorkspace(workspaceA, 'SELECT 1');
      await app.query('BEGIN');
      const { rows } = await app.query('SELECT id FROM workspaces');
      await app.query('COMMIT');
      expect(rows).toEqual([]);
    });
  });

  describe('part 4: cross-tenant foreign keys are refused', () => {
    it('refuses a member row pointing at a user that does not exist', async () => {
      await expect(
        admin.query(
          'INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)',
          [uuidv7(), workspaceA, uuidv7(), 'editor'],
        ),
      ).rejects.toThrow(/foreign key/iu);
    });

    it('refuses an invitation for a workspace that does not exist', async () => {
      await expect(
        admin.query(
          `INSERT INTO workspace_invitations
             (id, workspace_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days')`,
          [uuidv7(), uuidv7(), 'x@example.com', 'editor', Buffer.from('h'), ownerA],
        ),
      ).rejects.toThrow(/foreign key/iu);
    });

    it('refuses to orphan a workspace by deleting its owner', async () => {
      // owner_user_id is ON DELETE RESTRICT.
      await expect(admin.query('DELETE FROM users WHERE id = $1', [ownerA])).rejects.toThrow();
    });

    it('cascades members when a workspace is hard-deleted', async () => {
      const throwaway = uuidv7();
      const user = uuidv7();
      await admin.query(
        'INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
        [user, `${user}@example.com`, 'Temp', 'x'],
      );
      await admin.query(
        'INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)',
        [throwaway, 'Temp', throwaway.slice(0, 12), user],
      );
      await admin.query(
        'INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [uuidv7(), throwaway, user, 'owner'],
      );

      await admin.query('DELETE FROM workspaces WHERE id = $1', [throwaway]);

      const { rows } = await admin.query(
        'SELECT 1 FROM workspace_members WHERE workspace_id = $1',
        [throwaway],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('part 5: the roles are what the migration says', () => {
    it('relayd_app does not bypass RLS and relayd_global does', async () => {
      const { rows } = await admin.query<{ rolname: string; rolbypassrls: boolean }>(
        "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('relayd_app','relayd_global')",
      );
      const byName = new Map(rows.map((r) => [r.rolname, r.rolbypassrls]));

      expect(byName.get('relayd_app')).toBe(false);
      expect(byName.get('relayd_global')).toBe(true);
    });

    it('every tenant table has RLS enabled AND forced', async () => {
      // Without FORCE, the table owner silently bypasses the policy.
      const { rows } = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname IN ('workspaces','workspace_members','workspace_invitations','audit_logs')`,
      );

      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
      }
    });

    it('users and sessions deliberately have no RLS', async () => {
      const { rows } = await admin.query<{ relname: string; relrowsecurity: boolean }>(
        "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('users','sessions','user_tokens')",
      );
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} is cross-tenant by design`).toBe(false);
      }
    });

    /**
     * The queue half of part 5, which replaces the Phase 5 tripwire.
     *
     * The tripwire here asserted that `global-jobs.ts` did not exist, so that
     * whoever added the first cross-tenant job had to write these tests
     * instead of leaving a gap that looked covered. The file exists now, so
     * this is the test it was holding the place for.
     *
     * The property under test is F20's: a job that bypasses RLS reduces the
     * four-layer isolation story to one layer, so the set of jobs allowed to
     * do that must be small, deliberate, and enumerable.
     */
    it('the cross-tenant allowlist is exactly the three reviewed entries', () => {
      // Pinned by value, not by length. Adding a job here is a diff that says
      // "this job can now read every customer's data" AND turns this test
      // red, which is the review conversation global-jobs.ts asks for.
      expect([...GLOBAL_JOB_TYPES].sort()).toEqual([
        'billing-reconcile',
        'enforcement-sweep',
        'partition-maintenance',
      ]);
    });

    it('every allowlisted name is a real queue, and nothing else is global', () => {
      // A typo would otherwise be a silent no-op: isGlobalJob('parition-...')
      // returns false, the job quietly gets an RLS-enforced connection and
      // reads nothing. Safe, but baffling to debug.
      for (const name of GLOBAL_JOB_TYPES) {
        expect(QUEUE_NAMES, `${name} is not a queue`).toContain(name);
      }

      for (const name of QUEUE_NAMES) {
        expect(isGlobalJob(name), `${name} global?`).toBe(GLOBAL_JOB_TYPES.includes(name));
      }

      // Fails closed for anything it has never heard of.
      expect(isGlobalJob('not-a-queue')).toBe(false);
      expect(isGlobalJob('')).toBe(false);
    });

    it('relayd_global really does see across tenants and relayd_app does not', async () => {
      // The role flags are asserted above; this asserts the behaviour the
      // flags are supposed to produce, which is the thing the design rests
      // on. Both workspaces exist, so the counts differ by role.
      await admin.query("ALTER ROLE relayd_global WITH PASSWORD 'test-only'");
      const url = new URL(postgres.url);
      url.username = 'relayd_global';
      url.password = 'test-only';

      const global = new pg.Client({ connectionString: url.toString() });
      await global.connect();
      try {
        // No scope set at all, and it still sees both.
        const { rows } = await global.query<{ id: string }>('SELECT id FROM workspaces');
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(workspaceA);
        expect(ids).toContain(workspaceB);
      } finally {
        await global.end();
      }

      // The same query as relayd_app with scope set sees exactly one.
      const scoped = await asWorkspace<{ id: string }>(workspaceA, 'SELECT id FROM workspaces');
      expect(scoped.map((r) => r.id)).toEqual([workspaceA]);
    });

    /**
     * TRIPWIRE, the second one.
     *
     * The allowlist is declared but nothing reads it yet: `isGlobalJob` has
     * no callers, and config exposes no connection string for the bypass
     * role. Every job therefore runs as `relayd_app`, RLS enforced — the safe
     * state, reached by there being no other option rather than by a choice.
     *
     * That changes the day someone adds a global connection. This fails then,
     * and what it asks for is the test that the *chooser* is correct: that a
     * job type off the allowlist cannot obtain the bypass connection however
     * it is invoked. Assert it at the point the connection is picked; a list
     * that is right and a chooser that ignores it is F20 all over again.
     */
    it('no process can connect as relayd_global yet: test the chooser when one can', async () => {
      const { readFile } = await import('node:fs/promises');
      const schema = await readFile(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../config/src/schema.ts',
        ),
        'utf8',
      );

      const databaseKeys = [...schema.matchAll(/^\s*(DATABASE_\w+):/gmu)].map((m) => m[1]);
      expect(databaseKeys.sort()).toEqual(['DATABASE_DIRECT_URL', 'DATABASE_URL']);
    });
  });
});
