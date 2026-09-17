import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, MigrationError } from '@relayd/db';
import { extractRollback } from '../src/rollback.js';
import { requireContainers, startPostgres, startRedis } from '../src/containers.js';
import type { StartedPostgres, StartedRedis } from '../src/containers.js';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

const gate = await requireContainers();
const describeIntegration = gate.available ? describe : describe.skip;

if (!gate.available) {
  // Visible in the run output rather than a silent skip.
  process.stdout.write(`\n[integration] SKIPPED: ${gate.reason}\n`);
}

describeIntegration('migration runner against real Postgres', () => {
  let postgres: StartedPostgres;
  let client: pg.Client;

  beforeAll(async () => {
    postgres = await startPostgres();
    client = new pg.Client({ connectionString: postgres.url });
    await client.connect();
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await postgres?.stop();
  }, 60_000);

  const tableExists = async (name: string): Promise<boolean> => {
    const { rows } = await client.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [name],
    );
    return rows[0]?.exists === true;
  };

  it('applies the pending migrations', async () => {
    const result = await runMigrations({
      connectionString: postgres.url,
      directory: migrationsDir,
    });

    expect(result.applied).toContain('0001_init.sql');
    expect(await tableExists('relayd_init_check')).toBe(true);

    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM relayd_init_check',
    );
    expect(rows[0]?.count).toBe('1');
  }, 60_000);

  it('records what it applied', async () => {
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM _relayd_migrations ORDER BY name',
    );
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
  });

  /**
   * The Phase 0 gate: running it twice in a row is a clean no-op, exit 0, no
   * changes.
   */
  it('is idempotent: a second run applies nothing and changes nothing', async () => {
    const before = await client.query('SELECT name, applied_at FROM _relayd_migrations ORDER BY name');
    const rowsBefore = await client.query('SELECT count(*)::text AS c FROM relayd_init_check');

    const result = await runMigrations({
      connectionString: postgres.url,
      directory: migrationsDir,
    });

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBeGreaterThan(0);

    const after = await client.query('SELECT name, applied_at FROM _relayd_migrations ORDER BY name');
    const rowsAfter = await client.query('SELECT count(*)::text AS c FROM relayd_init_check');

    // Nothing re-applied, nothing re-inserted, no timestamp rewritten.
    expect(after.rows).toEqual(before.rows);
    expect(rowsAfter.rows).toEqual(rowsBefore.rows);
  }, 60_000);

  it('refuses to run when an applied migration has been edited', async () => {
    // Migrations are immutable once merged (CLAUDE.md section 8).
    await client.query(
      "UPDATE _relayd_migrations SET checksum = 'tampered' WHERE name = '0001_init.sql'",
    );

    await expect(
      runMigrations({ connectionString: postgres.url, directory: migrationsDir }),
    ).rejects.toThrow(MigrationError);

    // Leave the database as we found it for the rollback test.
    const sql = await readFile(path.join(migrationsDir, '0001_init.sql'), 'utf8');
    const { createHash } = await import('node:crypto');
    const checksum = createHash('sha256')
      .update(sql.replace(/\r\n/gu, '\n'), 'utf8')
      .digest('hex');
    await client.query('UPDATE _relayd_migrations SET checksum = $1 WHERE name = $2', [
      checksum,
      '0001_init.sql',
    ]);
  }, 60_000);

  it('rolls back using the reversal the migration documents', async () => {
    const sql = await readFile(path.join(migrationsDir, '0001_init.sql'), 'utf8');
    const rollback = extractRollback(sql);
    expect(rollback).toContain('DROP TABLE');

    await client.query(rollback);
    await client.query("DELETE FROM _relayd_migrations WHERE name = '0001_init.sql'");

    expect(await tableExists('relayd_init_check')).toBe(false);

    // And the runner reapplies it cleanly afterwards, which is what makes the
    // documented rollback worth having.
    const result = await runMigrations({
      connectionString: postgres.url,
      directory: migrationsDir,
    });
    expect(result.applied).toContain('0001_init.sql');
    expect(await tableExists('relayd_init_check')).toBe(true);
  }, 60_000);
});

describeIntegration('redis container', () => {
  let redis: StartedRedis;

  beforeAll(async () => {
    redis = await startRedis();
  }, 180_000);

  afterAll(async () => {
    await redis?.stop();
  }, 60_000);

  it('starts and answers PING', async () => {
    const { createRedisConnection, pingRedis } = await import('@relayd/queue');
    const connection = createRedisConnection({ url: redis.url, maxRetriesPerRequest: 3 });
    await expect(pingRedis(connection)).resolves.toBeUndefined();
    await connection.quit();
  }, 60_000);
});
