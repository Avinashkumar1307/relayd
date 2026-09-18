import { describe, expect, it, vi } from 'vitest';
import {
  PARTITIONED_TABLES,
  PARTITION_LEAD_DAYS,
  ensurePartitions,
  monthsToCover,
  partitionNameFor,
  partitionsAreHealthy,
  type PartitionPort,
} from '../src/rollup/partitions.js';

/**
 * Partition maintenance (INVARIANTS R25, review finding F25).
 *
 * The failure this prevents is slow and silent: nothing breaks on the day a
 * partition is missing, because the insert that needs it creates it — in that
 * insert's transaction, holding a lock on the parent, which is the write path
 * of the highest-volume table in the system.
 */

const port = (over: Partial<PartitionPort> = {}) => {
  const created: string[] = [];
  let existing: string[] = [];

  const base: PartitionPort = {
    async ensureMonthPartition(input) {
      const name = partitionNameFor(input.table, input.monthStart);
      if (!existing.includes(name)) {
        existing.push(name);
        created.push(name);
      }
      return name;
    },
    async existingPartitions() {
      return [...existing];
    },
    ...over,
  };

  return {
    port: base,
    created,
    seed: (names: string[]) => {
      existing = [...names];
    },
  };
};

describe('which months must exist', () => {
  it('covers this month', () => {
    const months = monthsToCover(new Date('2026-09-10T00:00:00.000Z'));
    expect(months[0]?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('covers next month when the lead time crosses the boundary', () => {
    // The case the whole job exists for. A naive "create next month on the
    // 1st" misses this by a week.
    const months = monthsToCover(new Date('2026-09-28T00:00:00.000Z'));

    expect(months.map((m) => m.toISOString())).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    ]);
  });

  it('does not cover next month early in the month', () => {
    expect(monthsToCover(new Date('2026-09-02T00:00:00.000Z'))).toHaveLength(1);
  });

  it('crosses a year boundary', () => {
    const months = monthsToCover(new Date('2026-12-30T00:00:00.000Z'));

    expect(months.map((m) => m.toISOString())).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
  });

  it('handles February in a leap year', () => {
    const months = monthsToCover(new Date('2028-02-26T00:00:00.000Z'));
    expect(months).toHaveLength(2);
    expect(months[1]?.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  it('uses the seven-day lead R25 specifies', () => {
    expect(PARTITION_LEAD_DAYS).toBe(7);
  });

  it('takes a wider lead when asked, for a backfill', () => {
    // 1 September plus 90 days is 30 November: September, October, November.
    const months = monthsToCover(new Date('2026-09-01T00:00:00.000Z'), 90);

    expect(months.map((m) => m.toISOString().slice(0, 7))).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
  });

  it('is bounded, so a nonsense lead time cannot spin', () => {
    expect(monthsToCover(new Date('2026-09-01T00:00:00.000Z'), 100_000).length).toBeLessThanOrEqual(24);
  });

  it('works in UTC regardless of the host timezone', () => {
    // A host in UTC+13 on the 1st is still on the previous month in UTC, and
    // a partition named for the wrong month covers the wrong range.
    const months = monthsToCover(new Date('2026-09-01T00:30:00.000Z'));
    expect(months[0]?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('the partition name', () => {
  it('matches what the SQL function builds', () => {
    // A mismatch would report every partition missing while the job reported
    // every one created — the two halves would never agree and neither would
    // be wrong on its own terms.
    expect(partitionNameFor('email_events', new Date('2026-09-01T00:00:00.000Z'))).toBe(
      'email_events_2026_09',
    );
  });

  it('zero-pads the month', () => {
    expect(partitionNameFor('usage_records', new Date('2026-01-01T00:00:00.000Z'))).toBe(
      'usage_records_2026_01',
    );
  });
});

describe('creating them', () => {
  it('creates what is missing', async () => {
    const { port: p, created } = port();

    const result = await ensurePartitions(p, { now: new Date('2026-09-28T00:00:00.000Z') });

    expect(created).toContain('email_events_2026_09');
    expect(created).toContain('email_events_2026_10');
    expect(result.failed).toEqual([]);
  });

  it('covers every partitioned table', async () => {
    const { port: p, created } = port();

    await ensurePartitions(p, { now: new Date('2026-09-10T00:00:00.000Z') });

    for (const table of PARTITIONED_TABLES) {
      expect(created.some((name) => name.startsWith(table)), table).toBe(true);
    }
  });

  it('is idempotent', async () => {
    // The scheduler runs this daily forever and must not need to remember
    // what it did yesterday.
    const { port: p, created } = port();
    const now = new Date('2026-09-28T00:00:00.000Z');

    await ensurePartitions(p, { now });
    const before = created.length;
    await ensurePartitions(p, { now });

    expect(created.length).toBe(before);
  });

  it('reports what already existed separately from what it made', async () => {
    const { port: p, seed } = port();
    seed(['email_events_2026_09']);

    const result = await ensurePartitions(p, { now: new Date('2026-09-10T00:00:00.000Z') });

    expect(result.existing).toContain('email_events_2026_09');
    expect(result.created).not.toContain('email_events_2026_09');
  });

  it('keeps going when one table fails', async () => {
    // A lock contention on `email_events` must not stop `usage_records`
    // getting the partition it needs tomorrow.
    const { port: p } = port({
      async ensureMonthPartition(input) {
        if (input.table === 'email_events') throw new Error('canceling statement due to lock timeout');
        return partitionNameFor(input.table, input.monthStart);
      },
    });

    const result = await ensurePartitions(p, { now: new Date('2026-09-10T00:00:00.000Z') });

    expect(result.failed).toHaveLength(1);
    expect(result.created.some((name) => name.startsWith('usage_records'))).toBe(true);
  });

  it('records why a creation failed', async () => {
    // A lock timeout is the expected failure and not an incident — the next
    // daily run gets it, which is what the seven-day lead is for. But it has
    // to be visible, or six silent days look identical to nothing to do.
    const { port: p } = port({
      async ensureMonthPartition() {
        throw new Error('canceling statement due to lock timeout');
      },
    });

    const result = await ensurePartitions(p, { now: new Date('2026-09-10T00:00:00.000Z') });

    expect(result.failed[0]?.reason).toContain('lock timeout');
    expect(result.failed[0]?.monthStart).toBe('2026-09-01');
  });

  it('does not throw when everything fails', async () => {
    // The job reports; it does not crash. A crashed scheduled job is retried
    // blindly, and this one has nothing to gain from an immediate retry.
    const { port: p } = port({
      async ensureMonthPartition() {
        throw new Error('nope');
      },
    });

    await expect(
      ensurePartitions(p, { now: new Date('2026-09-10T00:00:00.000Z') }),
    ).resolves.toBeDefined();
  });
});

describe('the health check', () => {
  it('is satisfied when every needed partition exists', async () => {
    const { port: p } = port();
    const now = new Date('2026-09-28T00:00:00.000Z');

    await ensurePartitions(p, { now });

    expect(await partitionsAreHealthy(p, { now })).toEqual({ healthy: true, missing: [] });
  });

  it('names what is missing', async () => {
    // The alarm condition, separate from the job that fixes it: a maintenance
    // job that has silently failed for six days looks exactly like one with
    // nothing to do.
    const { port: p } = port();

    const result = await partitionsAreHealthy(p, { now: new Date('2026-09-28T00:00:00.000Z') });

    expect(result.healthy).toBe(false);
    expect(result.missing).toContain('email_events_2026_10');
  });

  it('checks every partitioned table', async () => {
    const { port: p, seed } = port();
    seed(['email_events_2026_09']);

    const result = await partitionsAreHealthy(p, { now: new Date('2026-09-10T00:00:00.000Z') });

    expect(result.missing).toEqual(['usage_records_2026_09']);
  });

  it('does not create anything', async () => {
    // It answers a question. A health check with a side effect is a health
    // check that always passes.
    const ensure = vi.fn();
    const { port: p } = port({ ensureMonthPartition: ensure });

    await partitionsAreHealthy(p, { now: new Date('2026-09-28T00:00:00.000Z') });

    expect(ensure).not.toHaveBeenCalled();
  });
});

describe('what this job deliberately does not do', () => {
  it('has no drop or detach path', async () => {
    // Dropping a partition is destructive and irreversible, and a job that
    // both creates and drops is one bug away from dropping what it meant to
    // create. Archival is an operator-initiated path.
    const source = await import('../src/rollup/partitions.js');

    expect(Object.keys(source).some((key) => /drop|detach|delete|prune/iu.test(key))).toBe(false);
  });
});
