import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { readMigrations } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';

/**
 * The Drizzle schema and the SQL migrations must describe the same database.
 *
 * Nothing else checks this. The migrations are what actually runs; the schema
 * is what Drizzle builds queries from. When they disagree, `tsc` is perfectly
 * happy and the failure arrives at runtime as `column "foo" does not exist` —
 * from whichever query happens to touch the drifted column first, which may be
 * months later and in production.
 *
 * There is no database in this test run, so this reads the committed SQL
 * rather than introspecting a live catalogue. That makes it a weaker check
 * than `information_schema` would be, and a far stronger one than none.
 */

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Every table the migrations create, with its column names. */
async function tablesFromMigrations(): Promise<Map<string, Set<string>>> {
  const files = await readMigrations(directory);

  // Comments are stripped before anything else is parsed. A comma inside a
  // comment is not a column separator, and removing them afterwards means the
  // split has already happened in the wrong place.
  const sql = files
    .map((file) => file.sql)
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n');

  const tables = new Map<string, Set<string>>();
  const createTable = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(/giu;

  let match: RegExpExecArray | null;
  while ((match = createTable.exec(sql)) !== null) {
    const name = match[1] as string;
    const body = balancedBody(sql, createTable.lastIndex - 1);
    tables.set(name, columnNames(body));
  }

  // Columns added later by ALTER belong to the table too.
  const addColumn =
    /ALTER TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/giu;
  while ((match = addColumn.exec(sql)) !== null) {
    tables.get(match[1] as string)?.add(match[2] as string);
  }

  const dropColumn =
    /ALTER TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)\s+DROP COLUMN(?:\s+IF EXISTS)?\s+([a-z_][a-z0-9_]*)/giu;
  while ((match = dropColumn.exec(sql)) !== null) {
    tables.get(match[1] as string)?.delete(match[2] as string);
  }

  return tables;
}

/** Reads from an opening parenthesis to its match, so nested types survive. */
function balancedBody(sql: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i += 1) {
    const character = sql[i];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex + 1, i);
    }
  }
  throw new Error('Unbalanced parentheses in a CREATE TABLE');
}

/**
 * The column names in a CREATE TABLE body.
 *
 * Splits on top-level commas only, so `numeric(10, 2)` and a multi-column
 * constraint do not each look like a new column.
 */
function columnNames(body: string): Set<string> {
  const names = new Set<string>();
  const constraint = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)\b/iu;

  let depth = 0;
  let current = '';

  const take = (piece: string): void => {
    const trimmed = piece
      .split('\n')
      .map((line) => line.replace(/--.*$/u, '').trim())
      .filter((line) => line !== '')
      .join(' ')
      .trim();

    if (trimmed === '' || constraint.test(trimmed)) return;
    const name = /^([a-z_][a-z0-9_]*)/iu.exec(trimmed)?.[1];
    if (name !== undefined) names.add(name.toLowerCase());
  };

  for (const character of body) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;

    if (character === ',' && depth === 0) {
      take(current);
      current = '';
      continue;
    }
    current += character;
  }
  take(current);

  return names;
}

function drizzleTables(): { name: string; columns: Set<string> }[] {
  const out: { name: string; columns: Set<string> }[] = [];

  for (const value of Object.values(schema)) {
    // Table objects carry Drizzle's symbol-keyed config; everything else here
    // is a helper or a type-only export.
    if (typeof value !== 'object' || value === null) continue;

    let config;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      continue;
    }

    out.push({
      name: config.name,
      columns: new Set(config.columns.map((column) => column.name)),
    });
  }

  return out;
}


/**
 * Tables that deliberately have no Drizzle declaration.
 *
 * Kept short and explicit: a name added here is a decision, and an empty
 * allowlist would be better still.
 */
const NOT_MODELLED = new Set([
  // The migration runner's own bookkeeping, read by `readMigrations` and
  // never by a query Drizzle builds.
  'schema_migrations',
  // Migration 0001 creates it, asserts the extension set and drops it.
  'relayd_init_check',
]);

/** Whether `name` looks like a partition of a table Drizzle does declare. */
function isPartitionOf(name: string, declared: ReadonlySet<string>): boolean {
  const suffix = /_(\d{4}_\d{2}|default)$/u;
  if (!suffix.test(name)) return false;
  return declared.has(name.replace(suffix, ''));
}

describe('the schema and the migrations agree', () => {
  it('finds tables in both', async () => {
    const fromSql = await tablesFromMigrations();
    const fromDrizzle = drizzleTables();

    // A guard on the guard: if either parser silently returned nothing, every
    // assertion below would pass vacuously.
    expect(fromSql.size).toBeGreaterThan(10);
    expect(fromDrizzle.length).toBeGreaterThan(10);
  });

  it('defines every Drizzle table in a migration', async () => {
    const fromSql = await tablesFromMigrations();
    const missing = drizzleTables()
      .filter((table) => !fromSql.has(table.name))
      .map((table) => table.name);

    expect(missing).toEqual([]);
  });

  it('gives every Drizzle column a column in the migration', async () => {
    const fromSql = await tablesFromMigrations();
    const problems: string[] = [];

    for (const table of drizzleTables()) {
      const sqlColumns = fromSql.get(table.name);
      if (sqlColumns === undefined) continue;

      for (const column of table.columns) {
        if (!sqlColumns.has(column)) problems.push(`${table.name}.${column}`);
      }
    }

    // Drizzle referencing a column that does not exist is the dangerous
    // direction: every query touching it fails at runtime.
    expect(problems).toEqual([]);
  });

  it('lists the columns the migrations have but Drizzle does not', async () => {
    const fromSql = await tablesFromMigrations();
    const undeclared: string[] = [];

    for (const table of drizzleTables()) {
      const sqlColumns = fromSql.get(table.name);
      if (sqlColumns === undefined) continue;

      for (const column of sqlColumns) {
        if (!table.columns.has(column)) undeclared.push(`${table.name}.${column}`);
      }
    }

    // The harmless direction — a column Drizzle cannot see still exists — but
    // it is almost always an oversight, and an unreadable column is a column
    // nobody maintains.
    expect(undeclared).toEqual([]);
  });

  it('declares every table the migrations create', async () => {
    // The direction nothing checked until migration 0013 created nineteen
    // billing tables and the Drizzle schema knew about none of them. Every
    // test above walks Drizzle and looks the table up in the SQL, so a table
    // absent from Drizzle is absent from the walk and absent from the
    // failure.
    const declared = new Set(drizzleTables().map((table) => table.name));
    const undeclared: string[] = [];

    for (const name of (await tablesFromMigrations()).keys()) {
      if (declared.has(name)) continue;
      if (NOT_MODELLED.has(name)) continue;
      // A partition is the parent table under another name. Drizzle addresses
      // the parent; declaring each partition would add a table per week
      // forever, and the scheduler creates them without a migration anyway.
      if (isPartitionOf(name, declared)) continue;

      undeclared.push(name);
    }

    expect(undeclared).toEqual([]);
  });
});
