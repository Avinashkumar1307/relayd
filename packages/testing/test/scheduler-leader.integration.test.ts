import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireContainers, startPostgres } from '../src/containers.js';
import type { StartedPostgres } from '../src/containers.js';
import { SCHEDULER_LOCK_KEY, runTick } from '../../../apps/scheduler/src/tick.js';

/**
 * Leader election against a real Postgres (INVARIANTS R35).
 *
 * BUILD-PLAN Phase 5 item 8: "kill leader mid-tick → exactly one successor"
 * and "Redis flush → scheduler still enqueues due jobs".
 *
 * The unit tests in apps/scheduler cover the shape of a tick with a fake
 * client. They cannot cover the thing that actually matters here, which is
 * whether `pg_try_advisory_xact_lock` behaves as assumed: that a second
 * connection is refused while the first holds it, and that killing the first
 * connection releases it without anybody intervening. Those are properties of
 * Postgres, and only Postgres can demonstrate them.
 */

const gate = await requireContainers();
const describeIntegration = gate.available ? describe : describe.skip;

if (!gate.available) {
  process.stdout.write(`\n[scheduler] SKIPPED: ${gate.reason}\n`);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    name text PRIMARY KEY,
    cron text NOT NULL,
    queue text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    last_run_at timestamptz,
    next_run_at timestamptz NOT NULL,
    locked_until timestamptz,
    locked_by text,
    last_error text,
    consecutive_failures integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

describeIntegration('scheduler leader election', () => {
  let postgres: StartedPostgres;
  let admin: pg.Client;

  beforeAll(async () => {
    postgres = await startPostgres();
    admin = new pg.Client({ connectionString: postgres.url });
    await admin.connect();
    await admin.query(SCHEMA);
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    await postgres?.stop();
  });

  async function client(): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: postgres.url });
    await c.connect();
    return c;
  }

  async function seed(name: string, dueAt: Date): Promise<void> {
    await admin.query(
      `INSERT INTO scheduled_jobs (name, cron, queue, next_run_at)
       VALUES ($1, '* * * * *', 'analytics-rollup', $2)
       ON CONFLICT (name) DO UPDATE SET next_run_at = EXCLUDED.next_run_at,
         last_run_at = NULL, last_error = NULL, consecutive_failures = 0`,
      [name, dueAt],
    );
  }

  const nextRun = (_cron: string, after: Date): Date => new Date(after.getTime() + 60_000);

  function enqueuer() {
    const enqueued: string[] = [];
    return {
      enqueued,
      target: {
        async enqueue(input: { jobId: string }) {
          enqueued.push(input.jobId);
        },
      },
    };
  }

  it('grants the advisory lock to exactly one of two concurrent ticks', async () => {
    await seed('rollup-a', new Date(Date.now() - 1000));

    const first = await client();
    const second = await client();

    try {
      await first.query('BEGIN');
      await second.query('BEGIN');

      const a = enqueuer();
      const b = enqueuer();

      const resultA = await runTick({
        client: first,
        enqueuer: a.target,
        instanceId: 'a',
        nextRun,
      });
      const resultB = await runTick({
        client: second,
        enqueuer: b.target,
        instanceId: 'b',
        nextRun,
      });

      // One leader, one enqueue. The loser did not wait and did not act.
      expect([resultA.leader, resultB.leader].filter(Boolean)).toHaveLength(1);
      expect(a.enqueued.length + b.enqueued.length).toBe(1);

      await first.query('COMMIT');
      await second.query('COMMIT');
    } finally {
      await first.end();
      await second.end();
    }
  }, 60_000);

  it('releases the lock when the leader dies mid-tick, with no intervention', async () => {
    // The reason the lock must be the transaction-scoped variant. A session
    // lock would survive the dead connection until somebody noticed.
    await seed('rollup-b', new Date(Date.now() - 1000));

    const leader = await client();
    await leader.query('BEGIN');

    const held = await leader.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [SCHEDULER_LOCK_KEY],
    );
    expect(held.rows[0]?.acquired).toBe(true);

    // Killed, not closed: this is a crash, not a shutdown.
    const [{ pid }] = (await leader.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows as [
      { pid: number },
    ];
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await leader.end().catch(() => undefined);

    const successor = await client();
    try {
      await successor.query('BEGIN');
      const next = enqueuer();

      const result = await runTick({
        client: successor,
        enqueuer: next.target,
        instanceId: 'successor',
        nextRun,
      });

      expect(result.leader).toBe(true);
      expect(next.enqueued).toHaveLength(1);
      await successor.query('COMMIT');
    } finally {
      await successor.end();
    }
  }, 60_000);

  it('rolls the advance back when the tick fails, so the job is not lost', async () => {
    // The enqueue and the advance commit together. A crash between them rolls
    // the advance back, the schedule stays due, and the deterministic job id
    // makes the repeat a no-op.
    await seed('rollup-c', new Date(Date.now() - 1000));

    const first = await client();
    try {
      await first.query('BEGIN');
      const a = enqueuer();

      await runTick({ client: first, enqueuer: a.target, instanceId: 'a', nextRun });
      expect(a.enqueued).toHaveLength(1);

      await first.query('ROLLBACK');
    } finally {
      await first.end();
    }

    const { rows } = await admin.query<{ last_run_at: Date | null }>(
      'SELECT last_run_at FROM scheduled_jobs WHERE name = $1',
      ['rollup-c'],
    );

    // Still unrun, so the next tick picks it up again.
    expect(rows[0]?.last_run_at).toBeNull();
  }, 60_000);

  it('still enqueues due jobs when Redis has been flushed (R23)', async () => {
    /**
     * The point of driving schedules from Postgres.
     *
     * A flushed Redis is modelled by a brand-new enqueuer that knows nothing:
     * no repeatable definitions, no history. The schedules are still in the
     * database, so the tick still finds them. With BullMQ repeatables there
     * would be nothing left to find and nothing would error — things would
     * simply stop happening (F23).
     */
    await seed('rollup-d', new Date(Date.now() - 1000));

    const connection = await client();
    try {
      await connection.query('BEGIN');
      const afterFlush = enqueuer();

      const result = await runTick({
        client: connection,
        enqueuer: afterFlush.target,
        instanceId: 'after-flush',
        nextRun,
      });

      expect(result.leader).toBe(true);
      expect(afterFlush.enqueued).toHaveLength(1);
      await connection.query('COMMIT');
    } finally {
      await connection.end();
    }
  }, 60_000);

  it('does not re-enqueue a schedule whose next run is in the future', async () => {
    await seed('rollup-e', new Date(Date.now() + 3_600_000));

    const connection = await client();
    try {
      await connection.query('BEGIN');
      const none = enqueuer();

      const result = await runTick({
        client: connection,
        enqueuer: none.target,
        instanceId: 'a',
        nextRun,
      });

      expect(result.leader).toBe(true);
      expect(none.enqueued).toEqual([]);
      await connection.query('COMMIT');
    } finally {
      await connection.end();
    }
  }, 60_000);

  it('skips a disabled schedule even when it is due', async () => {
    await seed('rollup-f', new Date(Date.now() - 1000));
    await admin.query('UPDATE scheduled_jobs SET enabled = false WHERE name = $1', ['rollup-f']);

    const connection = await client();
    try {
      await connection.query('BEGIN');
      const none = enqueuer();

      await runTick({ client: connection, enqueuer: none.target, instanceId: 'a', nextRun });

      expect(none.enqueued.filter((id) => id.includes('rollup-f'))).toEqual([]);
      await connection.query('COMMIT');
    } finally {
      await connection.end();
    }
  }, 60_000);
});
