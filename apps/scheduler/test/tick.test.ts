import { describe, expect, it, vi } from 'vitest';
import { SCHEDULER_LOCK_KEY, runTick, type TickClient, type TickEnqueuer } from '../src/tick.js';

/**
 * The scheduler tick (INVARIANTS R23 and R35).
 *
 * The properties under test are the ones that make a leader-elected ticker
 * safe: exactly one instance acts, a dead leader needs no intervention, and
 * no schedule is enqueued twice or starves another.
 */

const NOW = new Date('2026-01-01T10:00:00.000Z');

interface Recorded {
  text: string;
  values: readonly unknown[];
}

function fakeClient(options: {
  acquired?: boolean;
  due?: { name: string; queue: string; payload: unknown; cron: string }[];
  failUpdate?: boolean;
}) {
  const queries: Recorded[] = [];

  const client: TickClient = {
    async query<T>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });

      if (text.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ acquired: options.acquired ?? true }] as T[] };
      }
      if (text.includes('FROM scheduled_jobs')) {
        return { rows: (options.due ?? []) as T[] };
      }
      if (options.failUpdate === true && text.includes('UPDATE scheduled_jobs')) {
        throw new Error('update failed');
      }
      return { rows: [] as T[] };
    },
  };

  return { client, queries };
}

function schedule(name: string, overrides: Partial<{ queue: string; cron: string }> = {}) {
  return {
    name,
    queue: overrides.queue ?? 'analytics-rollup',
    payload: { scope: 'workspace' },
    cron: overrides.cron ?? '0 * * * *',
  };
}

function enqueuer() {
  const enqueued: { queue: string; jobId: string; name: string }[] = [];

  const target: TickEnqueuer = {
    async enqueue(input) {
      enqueued.push({ queue: input.queue, jobId: input.jobId, name: input.name });
    },
  };

  return { target, enqueued };
}

const nextRun = (_cron: string, after: Date): Date => new Date(after.getTime() + 3_600_000);

describe('leader election', () => {
  it('takes the transaction-scoped advisory lock first', async () => {
    // R35, and CLAUDE.md §12: never the session-scoped variant. A session
    // lock survives the transaction, so a crashed leader would hold it until
    // someone noticed.
    const { client, queries } = fakeClient({ due: [] });
    const { target } = enqueuer();

    await runTick({ client, enqueuer: target, instanceId: 'a', nextRun, now: () => NOW });

    expect(queries[0]?.text).toContain('pg_try_advisory_xact_lock');
    expect(queries[0]?.text).not.toContain('pg_advisory_lock(');
    expect(queries[0]?.values[0]).toBe(SCHEDULER_LOCK_KEY);
  });

  it('does nothing at all when another instance holds the lock', async () => {
    const { client, queries } = fakeClient({ acquired: false, due: [schedule('rollup')] });
    const { target, enqueued } = enqueuer();

    const result = await runTick({
      client,
      enqueuer: target,
      instanceId: 'b',
      nextRun,
      now: () => NOW,
    });

    expect(result).toEqual({ leader: false, enqueued: 0, failed: 0 });
    expect(enqueued).toEqual([]);
    // It did not even read the schedules.
    expect(queries).toHaveLength(1);
  });

  it('does not wait for the lock', async () => {
    // Waiting would queue every instance behind the leader and turn a
    // 60-second tick into a thundering herd when the leader is slow.
    const { client, queries } = fakeClient({ acquired: false });
    const { target } = enqueuer();

    await runTick({ client, enqueuer: target, instanceId: 'b', nextRun, now: () => NOW });

    expect(queries[0]?.text).toContain('pg_try_advisory_xact_lock');
  });

  it('lets exactly one of several instances act', async () => {
    // The database grants the lock to one. Modelled here by handing one
    // instance `acquired: true` and the rest false.
    const results = await Promise.all(
      ['a', 'b', 'c'].map(async (id, index) => {
        const { client } = fakeClient({ acquired: index === 0, due: [schedule('rollup')] });
        const { target } = enqueuer();

        return runTick({ client, enqueuer: target, instanceId: id, nextRun, now: () => NOW });
      }),
    );

    expect(results.filter((r) => r.leader)).toHaveLength(1);
    expect(results.reduce((sum, r) => sum + r.enqueued, 0)).toBe(1);
  });
});

describe('enqueueing due work', () => {
  it('enqueues each due schedule onto its own queue', async () => {
    const { client } = fakeClient({
      due: [
        schedule('hourly-rollup', { queue: 'analytics-rollup' }),
        schedule('sweep', { queue: 'recipient-sweeper' }),
      ],
    });
    const { target, enqueued } = enqueuer();

    const result = await runTick({
      client,
      enqueuer: target,
      instanceId: 'a',
      nextRun,
      now: () => NOW,
    });

    expect(result.enqueued).toBe(2);
    expect(enqueued.map((job) => job.queue)).toEqual(['analytics-rollup', 'recipient-sweeper']);
  });

  it('uses a job id that is the same for the same tick', async () => {
    // Two ticks in the same minute produce the same id, and BullMQ
    // deduplicates the second. That is what makes a rolled-back tick safe to
    // repeat.
    const first = enqueuer();
    const second = enqueuer();

    for (const target of [first, second]) {
      const { client } = fakeClient({ due: [schedule('hourly-rollup')] });
      await runTick({
        client,
        enqueuer: target.target,
        instanceId: 'a',
        nextRun,
        now: () => NOW,
      });
    }

    expect(second.enqueued[0]?.jobId).toBe(first.enqueued[0]?.jobId);
    expect(first.enqueued[0]?.jobId).toBe('sched:hourly-rollup:2026-01-01T10:00');
  });

  it('gives different schedules different job ids', async () => {
    const { client } = fakeClient({ due: [schedule('a'), schedule('b')] });
    const { target, enqueued } = enqueuer();

    await runTick({ client, enqueuer: target, instanceId: 'a', nextRun, now: () => NOW });

    expect(new Set(enqueued.map((job) => job.jobId)).size).toBe(2);
  });

  it('advances next_run_at after enqueueing', async () => {
    const { client, queries } = fakeClient({ due: [schedule('rollup')] });
    const { target } = enqueuer();

    await runTick({ client, enqueuer: target, instanceId: 'scheduler-1', nextRun, now: () => NOW });

    const update = queries.find((q) => q.text.includes('UPDATE scheduled_jobs'));
    expect(update?.values).toContain('rollup');
    expect(update?.values).toContain('scheduler-1');
    expect(update?.text).toContain('next_run_at');
  });

  it('claims rows with SKIP LOCKED', async () => {
    // Belt and braces under the advisory lock: it costs nothing, and it means
    // a future change that relaxes the election cannot silently produce
    // double enqueues.
    const { client, queries } = fakeClient({ due: [] });
    const { target } = enqueuer();

    await runTick({ client, enqueuer: target, instanceId: 'a', nextRun, now: () => NOW });

    const select = queries.find((q) => q.text.includes('FROM scheduled_jobs'));
    expect(select?.text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('reads only enabled schedules that are due', async () => {
    const { client, queries } = fakeClient({ due: [] });
    const { target } = enqueuer();

    await runTick({ client, enqueuer: target, instanceId: 'a', nextRun, now: () => NOW });

    const select = queries.find((q) => q.text.includes('FROM scheduled_jobs'));
    expect(select?.text).toContain('enabled');
    expect(select?.text).toContain('next_run_at <=');
  });
});

describe('a failing schedule', () => {
  it('does not stop the others', async () => {
    let calls = 0;
    const target: TickEnqueuer = {
      async enqueue() {
        calls += 1;
        if (calls === 1) throw new Error('redis is down');
      },
    };

    const { client } = fakeClient({ due: [schedule('broken'), schedule('fine')] });

    const result = await runTick({
      client,
      enqueuer: target,
      instanceId: 'a',
      nextRun,
      now: () => NOW,
    });

    expect(result).toMatchObject({ leader: true, enqueued: 1, failed: 1 });
  });

  it('still advances, so one broken schedule cannot starve the rest', async () => {
    // Leaving next_run_at in the past would make this the only thing every
    // subsequent tick sees, forever.
    const target: TickEnqueuer = {
      async enqueue() {
        throw new Error('redis is down');
      },
    };

    const { client, queries } = fakeClient({ due: [schedule('broken')] });

    await runTick({ client, enqueuer: target, instanceId: 'a', nextRun, now: () => NOW });

    const update = queries.find(
      (q) => q.text.includes('UPDATE scheduled_jobs') && q.text.includes('consecutive_failures'),
    );

    expect(update?.text).toContain('next_run_at');
    expect(update?.values.some((v) => String(v).includes('redis is down'))).toBe(true);
  });

  it('records the failure on the row, where an operator can see it', async () => {
    const target: TickEnqueuer = {
      async enqueue() {
        throw new Error('redis is down');
      },
    };

    const { client, queries } = fakeClient({ due: [schedule('broken')] });
    await runTick({ client, enqueuer: target, instanceId: 'a', nextRun, now: () => NOW });

    const update = queries.find((q) => q.text.includes('consecutive_failures'));
    expect(update?.text).toContain('last_error');
  });

  it('bounds the stored error', async () => {
    const target: TickEnqueuer = {
      async enqueue() {
        throw new Error('x'.repeat(5000));
      },
    };

    const { client, queries } = fakeClient({ due: [schedule('broken')] });
    await runTick({ client, enqueuer: target, instanceId: 'a', nextRun, now: () => NOW });

    const update = queries.find((q) => q.text.includes('last_error'));
    const message = update?.values.find((v) => typeof v === 'string' && v.startsWith('x'));
    expect(String(message).length).toBeLessThanOrEqual(500);
  });
});

describe('a tick with nothing due', () => {
  it('enqueues nothing and says so', async () => {
    const { client } = fakeClient({ due: [] });
    const { target, enqueued } = enqueuer();
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await runTick({
      client,
      enqueuer: target,
      instanceId: 'a',
      nextRun,
      now: () => NOW,
      logger,
    });

    expect(result).toEqual({ leader: true, enqueued: 0, failed: 0 });
    expect(enqueued).toEqual([]);
    // A quiet tick logs nothing: one line a minute, forever, buries the
    // lines that matter.
    expect(logger.info).not.toHaveBeenCalled();
  });
});
