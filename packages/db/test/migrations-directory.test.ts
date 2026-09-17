import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readMigrations } from '../src/migrate.js';

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/**
 * These run without a database. They assert that what is committed satisfies
 * the rules the runner enforces, so a malformed migration fails in unit tests
 * rather than against a live database.
 *
 * Actually applying them is the Testcontainers integration test.
 */
describe('committed migrations', () => {
  it('all parse, are correctly named, and document a rollback', async () => {
    const files = await readMigrations(directory);
    expect(files.length).toBeGreaterThan(0);
  });

  it('are numbered contiguously from 0001', async () => {
    const files = await readMigrations(directory);
    expect(files.map((f) => f.sequence)).toEqual(
      files.map((_, index) => index + 1),
    );
  });

  it('starts with the Phase 0 init migration', async () => {
    const files = await readMigrations(directory);
    expect(files[0]?.name).toBe('0001_init.sql');
    expect(files[0]?.runsInTransaction).toBe(true);
  });
});
