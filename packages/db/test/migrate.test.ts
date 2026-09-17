import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, readMigrations } from '../src/migrate.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'relayd-migrations-'));
});

const write = (name: string, sql: string) => writeFile(path.join(dir, name), sql, 'utf8');

const valid = (body: string) => `${body}\n-- ROLLBACK: drop what this created\n`;

describe('readMigrations', () => {
  it('reads migrations in sequence order', async () => {
    await write('0002_second.sql', valid('SELECT 2;'));
    await write('0001_first.sql', valid('SELECT 1;'));
    const files = await readMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(files.map((f) => f.sequence)).toEqual([1, 2]);
  });

  it('rejects a filename that is not NNNN_lower_snake_case.sql', async () => {
    await write('init.sql', valid('SELECT 1;'));
    await expect(readMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('rejects a duplicate sequence number', async () => {
    await write('0001_first.sql', valid('SELECT 1;'));
    await write('0001_also_first.sql', valid('SELECT 2;'));
    await expect(readMigrations(dir)).rejects.toThrow(/Duplicate migration sequence/u);
  });

  it('rejects a migration with no ROLLBACK comment', async () => {
    await write('0001_first.sql', 'SELECT 1;');
    await expect(readMigrations(dir)).rejects.toThrow(/ROLLBACK/u);
  });

  it('ignores non-sql files', async () => {
    await write('0001_first.sql', valid('SELECT 1;'));
    await write('README.md', 'notes');
    const files = await readMigrations(dir);
    expect(files).toHaveLength(1);
  });

  it('defaults to running inside a transaction', async () => {
    await write('0001_first.sql', valid('SELECT 1;'));
    const [file] = await readMigrations(dir);
    expect(file?.runsInTransaction).toBe(true);
  });

  it('honours the no-transaction marker CREATE INDEX CONCURRENTLY needs', async () => {
    await write(
      '0001_index.sql',
      valid('-- RELAYD:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (c);'),
    );
    const [file] = await readMigrations(dir);
    expect(file?.runsInTransaction).toBe(false);
  });

  it('checksums identically across CRLF and LF checkouts', async () => {
    await write('0001_first.sql', 'SELECT 1;\n-- ROLLBACK: none\n');
    const [lf] = await readMigrations(dir);

    dir = await mkdtemp(path.join(tmpdir(), 'relayd-migrations-'));
    await write('0001_first.sql', 'SELECT 1;\r\n-- ROLLBACK: none\r\n');
    const [crlf] = await readMigrations(dir);

    expect(crlf?.checksum).toBe(lf?.checksum);
  });

  it('gives different content different checksums', async () => {
    await write('0001_first.sql', valid('SELECT 1;'));
    const [a] = await readMigrations(dir);

    dir = await mkdtemp(path.join(tmpdir(), 'relayd-migrations-'));
    await write('0001_first.sql', valid('SELECT 2;'));
    const [b] = await readMigrations(dir);

    expect(a?.checksum).not.toBe(b?.checksum);
  });
});
