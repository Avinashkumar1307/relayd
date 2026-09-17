import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/** Numbered, immutable once merged: 0001_init.sql (CLAUDE.md section 8). */
const FILENAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/u;

/**
 * Every migration must document its reversal (CLAUDE.md section 8). Checked
 * here rather than in review, because review is the thing that gets skipped
 * at 6pm on a Friday.
 */
const ROLLBACK_MARKER = '-- ROLLBACK:';

/**
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and
 * CLAUDE.md section 8 requires it always be in its own migration. Such a
 * migration opts out of the wrapping transaction with this marker.
 */
const NO_TRANSACTION_MARKER = '-- RELAYD:no-transaction';

const MIGRATIONS_TABLE = '_relayd_migrations';

export interface MigrationFile {
  name: string;
  sequence: number;
  sql: string;
  checksum: string;
  runsInTransaction: boolean;
}

export type MigrationEvent =
  | { kind: 'start'; pending: number; alreadyApplied: number }
  | { kind: 'applied'; name: string; durationMs: number }
  | { kind: 'done'; applied: number; alreadyApplied: number };

export interface RunMigrationsOptions {
  connectionString: string;
  directory: string;
  log?: (event: MigrationEvent) => void;
}

export interface MigrationsResult {
  applied: string[];
  alreadyApplied: number;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

function checksum(contents: string): string {
  // Line endings are normalised first: the repository is developed on Windows
  // and built on Linux, and a checksum that changed with the checkout would
  // make every migration look tampered with on the other platform.
  return createHash('sha256').update(contents.replace(/\r\n/gu, '\n'), 'utf8').digest('hex');
}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

  const files: MigrationFile[] = [];
  const seen = new Set<number>();

  for (const name of entries) {
    const match = FILENAME_PATTERN.exec(name);
    if (match === null) {
      throw new MigrationError(
        `Migration "${name}" does not match NNNN_lower_snake_case.sql`,
      );
    }

    const sequence = Number.parseInt(match[1] ?? '', 10);
    if (seen.has(sequence)) {
      throw new MigrationError(`Duplicate migration sequence ${match[1]} ("${name}")`);
    }
    seen.add(sequence);

    const sql = await readFile(path.join(directory, name), 'utf8');
    if (!sql.includes(ROLLBACK_MARKER)) {
      throw new MigrationError(
        `Migration "${name}" has no "${ROLLBACK_MARKER}" comment describing its reversal`,
      );
    }

    files.push({
      name,
      sequence,
      sql,
      checksum: checksum(sql),
      runsInTransaction: !sql.includes(NO_TRANSACTION_MARKER),
    });
  }

  return files;
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  // The primary key on name is the concurrency guard. CLAUDE.md section 12
  // ranks a unique index above every other mutual-exclusion mechanism, and
  // above advisory locks in particular: two runners racing on the same
  // migration means one hits a unique violation and rolls back its whole
  // transaction, DDL included.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name        text        PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(client: pg.Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM ${MIGRATIONS_TABLE}`,
  );
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

/**
 * Applies every migration not yet recorded, in sequence order.
 *
 * Idempotent: a second run with nothing pending applies nothing, writes
 * nothing and returns an empty list.
 *
 * Never runs at container boot (CLAUDE.md section 12) — twenty tasks starting
 * at once would race on the migrations table. In ECS this is a one-off task
 * that completes before the service update begins.
 */
export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<MigrationsResult> {
  const files = await readMigrations(options.directory);
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await readApplied(client);

    // An applied migration whose contents changed means someone edited a file
    // that is immutable once merged. Fail loudly: the database and the
    // repository no longer agree on what was run.
    for (const file of files) {
      const recorded = applied.get(file.name);
      if (recorded !== undefined && recorded !== file.checksum) {
        throw new MigrationError(
          `Migration "${file.name}" has been modified after being applied ` +
            `(recorded ${recorded.slice(0, 12)}, found ${file.checksum.slice(0, 12)}). ` +
            `Migrations are immutable once merged; add a new migration instead.`,
        );
      }
    }

    const pending = files.filter((file) => !applied.has(file.name));
    options.log?.({ kind: 'start', pending: pending.length, alreadyApplied: applied.size });

    const appliedNames: string[] = [];

    for (const file of pending) {
      const startedAt = Date.now();

      if (file.runsInTransaction) {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`,
            [file.name, file.checksum],
          );
          await client.query(file.sql);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } else {
        // Cannot be atomic: the statement forbids a transaction block. The
        // record is written only after the statement succeeds, so a failure
        // leaves the migration pending and it is retried on the next run.
        await client.query(file.sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`,
          [file.name, file.checksum],
        );
      }

      appliedNames.push(file.name);
      options.log?.({ kind: 'applied', name: file.name, durationMs: Date.now() - startedAt });
    }

    options.log?.({
      kind: 'done',
      applied: appliedNames.length,
      alreadyApplied: applied.size,
    });

    return { applied: appliedNames, alreadyApplied: applied.size };
  } finally {
    await client.end();
  }
}
