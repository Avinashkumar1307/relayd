import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { MeteringRepository } from '../src/repositories/metering.js';
import type { Executor } from '../src/repositories/executor.js';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The metering SQL, without a database.
 *
 * What is checkable here is the shape of the statements, and for this
 * repository the shape is most of the correctness: a missing `ORDER BY`
 * strands ledger rows, a `=` where `IS NOT DISTINCT FROM` belongs makes the
 * compare-and-set never match on a fresh period, and an increment that runs
 * whether or not the ledger insert took effect bills a retry.
 *
 * The arithmetic these statements feed is proved in
 * `packages/billing/test/metering.test.ts`, which is where R15 lives.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const PERIOD_START = new Date('2026-09-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');
const NOW = new Date('2026-09-19T12:00:00.000Z');

/** Captures the SQL each call would send, and the parameters bound to it. */
function capturing(results: { rows: unknown[] }[] = []) {
  const statements: { text: string; params: unknown[] }[] = [];
  let call = 0;

  const execute = vi.fn(async (query: unknown) => {
    statements.push(render(query));
    const result = results[call] ?? { rows: [] };
    call += 1;
    return { ...result, rowCount: result.rows.length };
  });

  return { statements, db: { execute } as unknown as Executor };
}

/**
 * The real SQL, not an approximation.
 *
 * Drizzle renders a `sql` template through its dialect, and going through the
 * dialect rather than reading the chunks by hand means these assertions are
 * about the statement Postgres would actually receive.
 */
function render(query: unknown): { text: string; params: unknown[] } {
  const { sql: text, params } = new PgDialect().sqlToQuery(query as SQL);
  return { text, params };
}

function sendInput(over: Record<string, unknown> = {}) {
  return {
    usageRecordId: '0192aaaa-0000-7000-8000-000000000001',
    featureKey: 'emails.sent',
    idempotencyKey: 'send:rec-1',
    campaignId: 'camp-1',
    recipientId: 'rec-1',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    occurredAt: NOW,
    ...over,
  };
}

describe('every statement is scoped to the workspace', () => {
  it('scopes all five', async () => {
    // Layer three of the four. RLS holds underneath, but a query without the
    // predicate is a query relying entirely on a `SET LOCAL` somebody else
    // remembered to do.
    const { statements, db } = capturing([{ rows: [{ id: 'u1' }] }]);
    const repo = new MeteringRepository(db);

    await repo.recordSendUsage(SCOPE, sendInput());
    await repo.readAggregate(SCOPE, { featureKey: 'emails.sent', periodStart: PERIOD_START });
    await repo.readLedgerAfter(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      afterId: null,
      before: NOW,
      limit: 100,
    });
    await repo.applyAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      addUsed: 5,
      watermark: 'w',
      expectedWatermark: null,
    });
    await repo.countLedger(SCOPE, { featureKey: 'emails.sent', periodStart: PERIOD_START });

    expect(statements).toHaveLength(6);
    for (const statement of statements) {
      expect(statement.params).toContain('ws-1');
    }
  });
});

describe('the send transaction', () => {
  it('writes the ledger row before it touches the counter', async () => {
    const { statements, db } = capturing([{ rows: [{ id: 'u1' }] }]);

    await new MeteringRepository(db).recordSendUsage(SCOPE, sendInput());

    expect(statements[0]?.text).toContain('INSERT INTO usage_records');
    expect(statements[1]?.text).toContain('INSERT INTO usage_aggregates');
  });

  it('leaves the counter alone when the ledger refuses the row', async () => {
    // A retry. The unique index on `(workspace_id, feature_key,
    // idempotency_key)` returns nothing, and incrementing anyway would bill
    // the same send twice — which is the failure the index exists to catch.
    const { statements, db } = capturing([{ rows: [] }]);

    const counted = await new MeteringRepository(db).recordSendUsage(SCOPE, sendInput());

    expect(counted).toBe(false);
    expect(statements).toHaveLength(1);
  });

  it('says it counted when it did', async () => {
    const { db } = capturing([{ rows: [{ id: 'u1' }] }]);

    expect(await new MeteringRepository(db).recordSendUsage(SCOPE, sendInput())).toBe(true);
  });

  it('inserts the ledger row on conflict do nothing', async () => {
    const { statements, db } = capturing([{ rows: [{ id: 'u1' }] }]);

    await new MeteringRepository(db).recordSendUsage(SCOPE, sendInput());

    expect(statements[0]?.text).toContain('ON CONFLICT DO NOTHING');
    expect(statements[0]?.text).toContain('RETURNING id');
  });

  it('moves the watermark forward only', async () => {
    // GREATEST, not assignment. An out-of-order commit whose id is below the
    // stored watermark would otherwise drag it backwards, and the catch-up
    // would re-read and re-count everything in between.
    const { statements, db } = capturing([{ rows: [{ id: 'u1' }] }]);

    await new MeteringRepository(db).recordSendUsage(SCOPE, sendInput());

    expect(statements[1]?.text).toContain('GREATEST(usage_aggregates.last_usage_record_id');
  });

  it('adds to the counter rather than replacing it', async () => {
    const { statements, db } = capturing([{ rows: [{ id: 'u1' }] }]);

    await new MeteringRepository(db).recordSendUsage(SCOPE, sendInput());

    expect(statements[1]?.text).toContain('used = usage_aggregates.used + EXCLUDED.used');
  });

  it('refuses a quantity below one', async () => {
    // A zero or negative quantity writes a ledger row that reduces the bill,
    // and the ledger has no correction path by design.
    const { statements, db } = capturing([{ rows: [{ id: 'u1' }] }]);

    await new MeteringRepository(db).recordSendUsage(SCOPE, sendInput({ quantity: -5 }));

    expect(statements[0]?.params).toContain(1);
  });
});

describe('reading the ledger', () => {
  it('orders by id', async () => {
    // Ascending, and the direction is the whole of it. The fold takes the
    // highest id it saw as the new watermark, so a descending read hands it
    // the newest row on the first page and strands every older one forever.
    const { statements, db } = capturing();

    await new MeteringRepository(db).readLedgerAfter(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      afterId: null,
      before: NOW,
      limit: 10,
    });

    expect(statements[0]?.text).toMatch(/ORDER BY id\s+LIMIT/u);
  });

  it('reads strictly past the watermark', async () => {
    const { statements, db } = capturing();

    await new MeteringRepository(db).readLedgerAfter(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      afterId: 'w',
      before: NOW,
      limit: 10,
    });

    expect(statements[0]?.text).toContain('id >');
    expect(statements[0]?.text).not.toContain('id >=');
  });

  it('applies the lag window', async () => {
    const { statements, db } = capturing();

    await new MeteringRepository(db).readLedgerAfter(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      afterId: null,
      before: NOW,
      limit: 10,
    });

    expect(statements[0]?.text).toContain('occurred_at <');
    expect(statements[0]?.params).toContain(NOW);
  });

  it('reads everything when there is no watermark yet', async () => {
    // `id > NULL` is null, which filters out every row. The null check is
    // what makes a period with no watermark read its ledger rather than none
    // of it.
    const { statements, db } = capturing();

    await new MeteringRepository(db).readLedgerAfter(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      afterId: null,
      before: NOW,
      limit: 10,
    });

    expect(statements[0]?.text).toContain('IS NULL OR id >');
  });

  it('refuses a limit below one', async () => {
    const { statements, db } = capturing();

    await new MeteringRepository(db).readLedgerAfter(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      afterId: null,
      before: NOW,
      limit: 0,
    });

    expect(statements[0]?.params).toContain(1);
  });
});

describe('the catch-up write', () => {
  it('is a compare-and-set on the watermark', async () => {
    const { statements, db } = capturing([{ rows: [{ workspace_id: 'ws-1' }] }]);

    await new MeteringRepository(db).applyAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      addUsed: 5,
      watermark: 'w2',
      expectedWatermark: 'w1',
    });

    expect(statements[0]?.text).toContain('last_usage_record_id IS NOT DISTINCT FROM');
  });

  it('does not use equality, which never matches a fresh period', async () => {
    // `last_usage_record_id = NULL` is null rather than true, so a period
    // nothing has been aggregated into would never be writable.
    const { statements, db } = capturing([{ rows: [{ workspace_id: 'ws-1' }] }]);

    await new MeteringRepository(db).applyAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      addUsed: 1,
      watermark: 'w',
      expectedWatermark: null,
    });

    // The SET clause assigns the new watermark with `=`, which is correct;
    // it is the predicate that must not.
    const where = (statements[0]?.text ?? '').split(' WHERE ')[1] ?? '';
    expect(where).toContain('last_usage_record_id IS NOT DISTINCT FROM');
    expect(where).not.toMatch(/last_usage_record_id\s*=/u);
  });

  it('adds and moves in one statement', async () => {
    // Two statements means a crash between them either loses the rows or
    // counts them twice.
    const { statements, db } = capturing([{ rows: [{ workspace_id: 'ws-1' }] }]);

    await new MeteringRepository(db).applyAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      addUsed: 5,
      watermark: 'w2',
      expectedWatermark: 'w1',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toContain('used = used +');
    expect(statements[0]?.text).toContain('last_usage_record_id =');
  });

  it('reports a lost race', async () => {
    const { db } = capturing([{ rows: [] }]);

    const applied = await new MeteringRepository(db).applyAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      addUsed: 5,
      watermark: 'w2',
      expectedWatermark: 'w1',
    });

    expect(applied).toBe(false);
  });

  it('reports a win', async () => {
    const { db } = capturing([{ rows: [{ workspace_id: 'ws-1' }] }]);

    const applied = await new MeteringRepository(db).applyAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      addUsed: 5,
      watermark: 'w2',
      expectedWatermark: 'w1',
    });

    expect(applied).toBe(true);
  });

  it('never subtracts', async () => {
    const { statements, db } = capturing([{ rows: [] }]);

    await new MeteringRepository(db).applyAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      addUsed: -10,
      watermark: 'w',
      expectedWatermark: null,
    });

    expect(statements[0]?.params).toContain(0);
  });
});

describe('opening a period', () => {
  it('does not reset what has already accrued', async () => {
    // An upgrade mid-period raises `included` and leaves `used` alone: the
    // customer paid a prorated amount for more headroom in the same period,
    // and resetting to zero would give away a free one.
    const { statements, db } = capturing();

    await new MeteringRepository(db).openPeriod(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      included: 50_000,
      subscriptionId: 'sub-1',
    });

    const text = statements[0]?.text ?? '';
    expect(text).toContain('included = EXCLUDED.included');
    expect(text).not.toContain('used =');
    expect(text).not.toContain('last_usage_record_id =');
  });

  it('is an upsert', async () => {
    const { statements, db } = capturing();

    await new MeteringRepository(db).openPeriod(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      included: null,
      subscriptionId: null,
    });

    expect(statements[0]?.text).toContain(
      'ON CONFLICT (workspace_id, feature_key, period_start) DO UPDATE',
    );
  });
});

describe('reading the counter', () => {
  it('returns null for a period that was never opened', async () => {
    const { db } = capturing([{ rows: [] }]);

    expect(
      await new MeteringRepository(db).readAggregate(SCOPE, {
        featureKey: 'emails.sent',
        periodStart: PERIOD_START,
      }),
    ).toBe(null);
  });

  it('keeps unlimited distinct from zero', async () => {
    // `included: null` is unlimited; `included: 0` is a plan that includes
    // nothing. Collapsing them turns an unlimited plan into one that blocks
    // the first send.
    const { db } = capturing([
      {
        rows: [
          {
            workspace_id: 'ws-1',
            feature_key: 'emails.sent',
            period_start: PERIOD_START,
            period_end: PERIOD_END,
            used: '10',
            included: null,
            overage: '0',
            last_usage_record_id: null,
          },
        ],
      },
    ]);

    const row = await new MeteringRepository(db).readAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
    });

    expect(row?.included).toBe(null);
  });

  it('reads bigint columns as numbers', async () => {
    // `pg` returns bigint as a string. `'10' + 1` is `'101'`, and a counter
    // that concatenates is a counter that bills six figures on the eleventh
    // send.
    const { db } = capturing([
      {
        rows: [
          {
            workspace_id: 'ws-1',
            feature_key: 'emails.sent',
            period_start: PERIOD_START,
            period_end: PERIOD_END,
            used: '10',
            included: '50000',
            overage: '0',
            last_usage_record_id: null,
          },
        ],
      },
    ]);

    const row = await new MeteringRepository(db).readAggregate(SCOPE, {
      featureKey: 'emails.sent',
      periodStart: PERIOD_START,
    });

    expect(row?.used).toBe(10);
    expect(row?.included).toBe(50_000);
  });

  it('counts the ledger as a number', async () => {
    const { db } = capturing([{ rows: [{ n: '4210' }] }]);

    expect(
      await new MeteringRepository(db).countLedger(SCOPE, {
        featureKey: 'emails.sent',
        periodStart: PERIOD_START,
      }),
    ).toBe(4210);
  });

  it('counts zero when the ledger is empty', async () => {
    const { db } = capturing([{ rows: [] }]);

    expect(
      await new MeteringRepository(db).countLedger(SCOPE, {
        featureKey: 'emails.sent',
        periodStart: PERIOD_START,
      }),
    ).toBe(0);
  });
});
