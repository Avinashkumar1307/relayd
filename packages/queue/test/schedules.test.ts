import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../src/queues.js';

/**
 * The seeded schedules against the queue catalogue (INVARIANTS R23).
 *
 * Recurring work lives in `scheduled_jobs` rather than in BullMQ repeatables
 * so that a Redis flush cannot lose it. The cost of that choice is that the
 * schedule and the queue it names are declared in two different languages in
 * two different files, and nothing but this test connects them.
 *
 * The failure it exists for is silent in both directions: a schedule naming a
 * queue that does not exist throws on every tick and looks like an infra
 * problem, and a reconciler with no schedule row simply never runs — which is
 * how `recipient-sweeper` and `campaign-reconcile` came to be written,
 * configured, and unreachable.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(root, 'packages/db/migrations');

/**
 * The statements, without the prose.
 *
 * Migrations here carry more comment than SQL, and the comments quote the SQL
 * — which is how the first version of this file came to assert that a
 * migration was idempotent because its header said the word "idempotent".
 * Every rule below reads the statements only.
 *
 * `--` inside a string literal would be mangled by this; no migration has one,
 * and a linter that is wrong about a value nobody writes is an acceptable
 * trade for one that cannot be fooled by a comment.
 */
function statementsOnly(sql: string): string {
  return sql.replaceAll(/--[^\n]*/gu, '');
}

/** Every `('name', 'cron', 'queue', ...)` tuple inserted into scheduled_jobs. */
async function seededSchedules(): Promise<{ name: string; cron: string; queue: string }[]> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const found: { name: string; cron: string; queue: string }[] = [];

  for (const file of files) {
    const sql = statementsOnly(await readFile(path.join(migrationsDir, file), 'utf8'));

    for (const block of sql.split(/INSERT\s+INTO\s+scheduled_jobs/iu).slice(1)) {
      const upTo = block.split(/;\s*$/mu)[0] ?? '';
      const tuple = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,/gu;

      for (const match of upTo.matchAll(tuple)) {
        const [, name, cron, queue] = match;
        if (name !== undefined && cron !== undefined && queue !== undefined) {
          found.push({ name, cron, queue });
        }
      }
    }
  }

  return found;
}

describe('the seeded schedules', () => {
  it('exist at all', async () => {
    // `scheduled_jobs` was created in 0008 and stayed empty until 0010, which
    // meant the scheduler read due rows from an empty table every minute.
    expect((await seededSchedules()).length).toBeGreaterThan(0);
  });

  it('name queues that exist', async () => {
    const queues = new Set<string>(QUEUE_NAMES);

    for (const schedule of await seededSchedules()) {
      expect(queues, `schedule ${schedule.name} names queue ${schedule.queue}`).toContain(
        schedule.queue,
      );
    }
  });

  it('include the two reconcilers the send path depends on', async () => {
    // R3 and R5 are unenforceable without the first; R12 and R13 without the
    // second. Both are the kind of job whose absence shows up only as
    // customer tickets about stuck campaigns.
    const names = (await seededSchedules()).map((s) => s.name);

    expect(names).toContain('recipient-sweeper');
    expect(names).toContain('campaign-reconcile');
  });

  it('run the recipient sweeper every minute, as R3 specifies', async () => {
    const sweeper = (await seededSchedules()).find((s) => s.name === 'recipient-sweeper');
    expect(sweeper?.cron).toBe('* * * * *');
  });

  it('have five-field cron expressions', async () => {
    // A six-field expression parses as something quite different, and the
    // mistake is invisible until the job runs at the wrong time.
    for (const schedule of await seededSchedules()) {
      expect(schedule.cron.trim().split(/\s+/u), schedule.name).toHaveLength(5);
    }
  });

  it('declare each schedule once across all migrations', async () => {
    // Two seeds for one name means the second is a dead ON CONFLICT no-op
    // that reads as though it changed something.
    const names = (await seededSchedules()).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('seed idempotently, so db:migrate can be re-run', async () => {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const sql = statementsOnly(await readFile(path.join(migrationsDir, file), 'utf8'));
      if (!/INSERT\s+INTO\s+scheduled_jobs/iu.test(sql)) continue;

      expect(sql, file).toMatch(/ON\s+CONFLICT[\s\S]*?DO\s+NOTHING/iu);
    }
  });
});
