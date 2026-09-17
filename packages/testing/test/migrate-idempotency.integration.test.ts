import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireContainers, startPostgres } from '../src/containers.js';
import type { StartedPostgres } from '../src/containers.js';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrateCli = path.join(repoRoot, 'packages/db/dist/bin/migrate.js');

const gate = await requireContainers();
const describeIntegration = gate.available ? describe : describe.skip;

if (!gate.available) {
  process.stdout.write(`\n[integration] SKIPPED: ${gate.reason}\n`);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the real migration CLI as a child process.
 *
 * The gate criterion is about `pnpm db:migrate` exiting 0, and an exit code is
 * something only a process has — calling runMigrations() in-process can prove
 * the database state but never the exit status the one-off ECS task reports.
 *
 * The child gets a deliberately minimal environment: DATABASE_URL and nothing
 * else it could fall back on. That also proves the CLI needs nothing more.
 * (process.execPath is the node binary, so no PATH is required; process.env is
 * never read here, which the relayd/no-process-env rule forbids outside
 * packages/config.)
 */
async function runMigrateCli(databaseUrl: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [migrateCli], {
      env: { DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'info' },
      cwd: repoRoot,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/**
 * Criterion 3 of the Phase 0 gate: `pnpm db:migrate` run twice in a row is a
 * clean no-op — exit 0, no changes.
 */
describeIntegration('migration runner is idempotent against a fresh Postgres 16', () => {
  let postgres: StartedPostgres;
  let client: pg.Client;

  beforeAll(async () => {
    await expect(
      access(migrateCli),
      `${migrateCli} is missing — run \`pnpm turbo run build\` before the integration suite`,
    ).resolves.toBeUndefined();

    postgres = await startPostgres();
    client = new pg.Client({ connectionString: postgres.url });
    await client.connect();
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await postgres?.stop();
  }, 60_000);

  /**
   * A byte-level fingerprint of the ledger, computed by Postgres over every
   * column that could possibly change — including applied_at, which is what
   * a re-application would rewrite.
   */
  const ledgerDigest = async (): Promise<string> => {
    const { rows } = await client.query<{ digest: string }>(
      `SELECT md5(
         coalesce(
           string_agg(name || '|' || checksum || '|' || applied_at::text, E'\n' ORDER BY name),
           ''
         )
       ) AS digest
       FROM _relayd_migrations`,
    );
    return rows[0]?.digest ?? '';
  };

  const ledgerDump = async (): Promise<string[]> => {
    const { rows } = await client.query<{ row: string }>(
      `SELECT name || '|' || checksum || '|' || applied_at::text AS row
       FROM _relayd_migrations ORDER BY name`,
    );
    return rows.map((r) => r.row);
  };

  let digestAfterFirstRun = '';
  let dumpAfterFirstRun: string[] = [];

  it('first run applies the migrations and exits 0', async () => {
    const result = await runMigrateCli(postgres.url);

    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('migration applied');
    expect(result.stdout).toContain('0001_init.sql');

    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('relayd_init_check') IS NOT NULL AS exists",
    );
    expect(rows[0]?.exists).toBe(true);

    digestAfterFirstRun = await ledgerDigest();
    dumpAfterFirstRun = await ledgerDump();
    expect(dumpAfterFirstRun).toHaveLength(1);
  }, 120_000);

  it('second run reports no migrations pending and exits 0', async () => {
    const result = await runMigrateCli(postgres.url);

    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('no migrations pending');
    // Nothing was applied on the way to saying so.
    expect(result.stdout).not.toContain('migration applied');
  }, 120_000);

  it('leaves _relayd_migrations byte-identical', async () => {
    expect(await ledgerDump()).toEqual(dumpAfterFirstRun);
    expect(await ledgerDigest()).toBe(digestAfterFirstRun);
  }, 60_000);

  it('does not re-run the migration body either', async () => {
    // 0001_init.sql inserts a row. A second execution would make it two, which
    // is the failure a checksum on the ledger alone would not catch.
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM relayd_init_check',
    );
    expect(rows[0]?.count).toBe('1');
  }, 60_000);

  it('is still a clean no-op on a third run', async () => {
    const before = await ledgerDigest();
    const result = await runMigrateCli(postgres.url);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no migrations pending');
    expect(await ledgerDigest()).toBe(before);
  }, 120_000);
});
