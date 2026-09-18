import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A partial index must be partial in both places.
 *
 * A partial unique index without its predicate is not a laxer version of the
 * same index — it is a different index, and usually a far stricter one.
 *
 * `uq_pool_default` is the case that prompted this file. Migration 0009 has
 * `CREATE UNIQUE INDEX uq_pool_default ON sending_pools (workspace_id) WHERE
 * is_default`, which allows one *default* pool per workspace. The Drizzle
 * declaration had no `.where()`, which describes an index allowing a
 * workspace exactly one sending pool — the whole feature, gone.
 *
 * Nothing broke, because the migrations are what the database actually has
 * and Drizzle generates no DDL here. That is precisely why it could have sat
 * there for a year: the schema file is what a person reads to understand the
 * shape, and it was describing a database that does not exist.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');
const schemaDir = path.resolve(here, '../src/schema');

/** Index names that a migration creates with a WHERE clause. */
async function partialIndexNames(): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const names: string[] = [];

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');

    // One statement at a time, so a WHERE belonging to the *next* statement
    // cannot make this one look partial.
    for (const statement of sql.split(';')) {
      const created = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/iu.exec(
        statement,
      );

      if (created?.[1] === undefined) continue;
      if (!/\bWHERE\b/iu.test(statement)) continue;

      names.push(created[1]);
    }
  }

  return names;
}

/** Every schema source file, concatenated. */
async function schemaSource(): Promise<string> {
  const files = (await readdir(schemaDir)).filter((file) => file.endsWith('.ts'));
  const parts = await Promise.all(files.map((file) => readFile(path.join(schemaDir, file), 'utf8')));
  return parts.join('\n');
}

/**
 * The Drizzle declaration for one index name, as far as its terminating
 * comma. Returns null when the schema does not declare it at all.
 */
function declarationOf(source: string, name: string): string | null {
  const start = source.indexOf(`'${name}'`);
  if (start === -1) return null;

  // Runs to wherever the next index declaration begins, because a predicate
  // pushes the declaration onto three or four lines and stopping at the first
  // newline would read almost none of it — which is how the first version of
  // this helper reported every corrected index as still unqualified.
  const rest = source.slice(start + name.length + 2);
  const next = /\b(?:unique)?[iI]ndex\(|\bprimaryKey\(|\bforeignKey\(|\n\s*\],/u.exec(rest);

  return rest.slice(0, next?.index ?? Math.min(rest.length, 400));
}

describe('partial indexes', () => {
  it('finds some, so this test is not vacuous', async () => {
    // Without this, a regex that stops matching turns the assertion below
    // into a permanent pass over an empty list.
    expect((await partialIndexNames()).length).toBeGreaterThan(0);
  });

  it('keeps the predicate in the Drizzle declaration', async () => {
    const source = await schemaSource();
    const unqualified: string[] = [];

    for (const name of await partialIndexNames()) {
      const declaration = declarationOf(source, name);

      // An index the schema never mentions is a different problem and not
      // this test's business: drift needs both sides to declare it.
      if (declaration === null) continue;

      if (!declaration.includes('.where(')) unqualified.push(name);
    }

    expect(
      unqualified,
      `partial in SQL, unqualified in Drizzle: ${unqualified.join(', ')}`,
    ).toEqual([]);
  });

  it('holds for uq_pool_default specifically', async () => {
    // Named, because this is the one that was wrong and the one whose
    // breakage is silent — a workspace quietly limited to a single pool.
    const source = await schemaSource();
    const declaration = declarationOf(source, 'uq_pool_default');

    expect(declaration).not.toBeNull();
    expect(declaration).toContain('.where(');
  });
});
