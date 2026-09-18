import { describe, expect, it } from 'vitest';
import {
  AGGREGATION_LAG_MS,
  AGGREGATION_PAGE,
  advanceWatermark,
  aggregateUsage,
  aggregateUsageFully,
  aggregationCutoff,
  compareUsageIds,
  foldLedger,
  isOverHardCap,
  overageFor,
  overageHardCap,
  reconcileAggregate,
  reconcileVerdict,
  usageIdempotencyKey,
  type AggregateKey,
  type AggregatePort,
  type AggregateRow,
  type LedgerRow,
} from '../src/metering/meter.js';

/**
 * Metering (INVARIANTS R14, R15).
 *
 * R15: "`usage_aggregates.last_usage_record_id` watermark; aggregation reads
 * `id > watermark` and advances it in the same transaction. Re-running is
 * idempotent." Its proving test is "run aggregation three times over the same
 * ledger; assert identical totals", and that is `the R15 property` below.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const PERIOD_START = new Date('2026-09-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

const KEY: AggregateKey = {
  workspaceId: 'ws-1',
  featureKey: 'emails.sent',
  periodStart: PERIOD_START,
};

/** A UUIDv7-shaped id whose lexical order is its sequence. */
function id(n: number): string {
  return `0192aaaa-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

function ledgerRow(n: number, over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: id(n),
    workspaceId: KEY.workspaceId,
    featureKey: KEY.featureKey,
    quantity: 1,
    periodStart: PERIOD_START,
    // Old enough to be outside the lag window by default.
    occurredAt: new Date(NOW.getTime() - 10 * 60_000),
    ...over,
  };
}

/**
 * A fake that behaves the way the SQL does, because a fake that is merely
 * convenient proves nothing about the statement it stands in for.
 *
 * Specifically: the read filters on `id > afterId` and `occurred_at < before`
 * and returns ascending, and `applyAggregate` is a compare-and-set that
 * refuses when the stored watermark has moved.
 */
function harness(input: { rows?: LedgerRow[]; aggregate?: Partial<AggregateRow> | null } = {}) {
  const rows = input.rows ?? [];

  let aggregate: AggregateRow | null =
    input.aggregate === null
      ? null
      : {
          ...KEY,
          periodEnd: PERIOD_END,
          used: 0,
          included: 10_000,
          overage: 0,
          lastUsageRecordId: null,
          ...input.aggregate,
        };

  const reads: { afterId: string | null; before: Date; limit: number }[] = [];
  const applies: { addUsed: number; watermark: string | null }[] = [];

  const port: AggregatePort = {
    async readAggregate() {
      return aggregate === null ? null : { ...aggregate };
    },

    async readLedgerAfter(args) {
      reads.push({ afterId: args.afterId, before: args.before, limit: args.limit });

      return rows
        .filter((row) => args.afterId === null || compareUsageIds(row.id, args.afterId) > 0)
        .filter((row) => row.occurredAt.getTime() < args.before.getTime())
        .sort((a, b) => compareUsageIds(a.id, b.id))
        .slice(0, args.limit);
    },

    async applyAggregate(args) {
      if (aggregate === null) return false;
      if (aggregate.lastUsageRecordId !== args.expectedWatermark) return false;

      applies.push({ addUsed: args.addUsed, watermark: args.watermark });
      aggregate = {
        ...aggregate,
        used: aggregate.used + args.addUsed,
        lastUsageRecordId: args.watermark,
      };
      return true;
    },

    async countLedger() {
      return rows.length;
    },
  };

  return {
    port,
    reads,
    applies,
    get used() {
      return aggregate?.used ?? 0;
    },
    get watermark() {
      return aggregate?.lastUsageRecordId ?? null;
    },
    moveWatermark(to: string, used: number) {
      if (aggregate !== null) aggregate = { ...aggregate, lastUsageRecordId: to, used };
    },
  };
}

describe('the ledger key', () => {
  it('is the recipient id and nothing else', () => {
    // An attempt number in here would make every retry a new key and defeat
    // the unique index, which is the second of the two guards on double
    // billing.
    expect(usageIdempotencyKey('rec-1')).toBe('send:rec-1');
  });

  it('is the same for two attempts at the same recipient', () => {
    expect(usageIdempotencyKey('rec-1')).toBe(usageIdempotencyKey('rec-1'));
  });
});

describe('the R15 property', () => {
  it('gives identical totals on the second and third run', async () => {
    // R15 verbatim. Three runs over one ledger; the first counts, the rest
    // read an empty range.
    const h = harness({ rows: Array.from({ length: 250 }, (_, i) => ledgerRow(i + 1)) });

    const first = await aggregateUsageFully({ key: KEY, now: NOW }, h.port);
    const afterFirst = h.used;

    const second = await aggregateUsageFully({ key: KEY, now: NOW }, h.port);
    const third = await aggregateUsageFully({ key: KEY, now: NOW }, h.port);

    expect(afterFirst).toBe(250);
    expect(h.used).toBe(250);

    expect(first.added).toBe(250);
    expect(second.added).toBe(0);
    expect(third.added).toBe(0);
    expect(second.counted).toBe(0);
    expect(third.counted).toBe(0);
  });

  it('reads strictly past the watermark', async () => {
    const h = harness({
      rows: Array.from({ length: 10 }, (_, i) => ledgerRow(i + 1)),
      aggregate: { lastUsageRecordId: id(4), used: 4 },
    });

    await aggregateUsage({ key: KEY, now: NOW }, h.port);

    // Six rows remain: 5..10. Not seven — the watermark row itself was
    // already counted, and `>=` here would bill it twice.
    expect(h.used).toBe(10);
    expect(h.reads[0]?.afterId).toBe(id(4));
  });

  it('advances the watermark to the highest row it folded', async () => {
    const h = harness({ rows: Array.from({ length: 10 }, (_, i) => ledgerRow(i + 1)) });

    await aggregateUsage({ key: KEY, now: NOW }, h.port);

    expect(h.watermark).toBe(id(10));
  });

  it('adds the total and moves the watermark together', async () => {
    // One `applyAggregate`, not two writes. Split across transactions, a
    // crash between them either loses the rows or counts them twice.
    const h = harness({ rows: [ledgerRow(1), ledgerRow(2)] });

    await aggregateUsage({ key: KEY, now: NOW }, h.port);

    expect(h.applies).toEqual([{ addUsed: 2, watermark: id(2) }]);
  });

  it('writes nothing when there is nothing to fold', async () => {
    const h = harness({ rows: [] });

    const result = await aggregateUsage({ key: KEY, now: NOW }, h.port);

    expect(result).toMatchObject({ counted: 0, added: 0, more: false });
    expect(h.applies).toEqual([]);
  });

  it('leaves the watermark alone when it writes nothing', async () => {
    const h = harness({ rows: [], aggregate: { lastUsageRecordId: id(7), used: 7 } });

    await aggregateUsage({ key: KEY, now: NOW }, h.port);

    expect(h.watermark).toBe(id(7));
    expect(h.used).toBe(7);
  });
});

describe('paging', () => {
  it('folds a page at a time', async () => {
    const h = harness({ rows: Array.from({ length: 25 }, (_, i) => ledgerRow(i + 1)) });

    const result = await aggregateUsage({ key: KEY, now: NOW, pageSize: 10 }, h.port);

    expect(result.counted).toBe(10);
    expect(result.more).toBe(true);
    expect(h.used).toBe(10);
  });

  it('drains every page', async () => {
    const h = harness({ rows: Array.from({ length: 25 }, (_, i) => ledgerRow(i + 1)) });

    const result = await aggregateUsageFully({ key: KEY, now: NOW, pageSize: 10 }, h.port);

    expect(result.counted).toBe(25);
    expect(h.used).toBe(25);
    expect(h.watermark).toBe(id(25));
  });

  it('stops at maxPages rather than looping forever', async () => {
    // A period written to faster than this reads it would otherwise hold the
    // job open indefinitely. The next tick continues from the watermark.
    const h = harness({ rows: Array.from({ length: 100 }, (_, i) => ledgerRow(i + 1)) });

    const result = await aggregateUsageFully(
      { key: KEY, now: NOW, pageSize: 10, maxPages: 3 },
      h.port,
    );

    expect(result.counted).toBe(30);
    expect(result.more).toBe(true);
    expect(h.used).toBe(30);
  });

  it('refuses a page size of zero', async () => {
    // `pageSize: 0` reads nothing, so `more` stays true and `aggregateUsageFully`
    // spins to maxPages doing no work. Floored to one instead.
    const h = harness({ rows: [ledgerRow(1), ledgerRow(2)] });

    const result = await aggregateUsage({ key: KEY, now: NOW, pageSize: 0 }, h.port);

    expect(h.reads[0]?.limit).toBe(1);
    expect(result.counted).toBe(1);
  });

  it('caps a page size above the maximum', async () => {
    const h = harness({ rows: [ledgerRow(1)] });

    await aggregateUsage({ key: KEY, now: NOW, pageSize: 1_000_000 }, h.port);

    expect(h.reads[0]?.limit).toBe(AGGREGATION_PAGE);
  });
});

describe('the lag window', () => {
  it('will not read a row younger than the lag', async () => {
    // The hazard: UUIDv7 is generated at statement time and the row becomes
    // visible at commit time. Consuming a row generated 2 seconds ago and
    // advancing past it strands any transaction that generated an earlier id
    // and has not committed yet — a row in the ledger, billed, missing from
    // the counter forever.
    const h = harness({
      rows: [
        ledgerRow(1),
        ledgerRow(2, { occurredAt: new Date(NOW.getTime() - 2_000) }),
      ],
    });

    const result = await aggregateUsage({ key: KEY, now: NOW }, h.port);

    expect(result.counted).toBe(1);
    expect(h.watermark).toBe(id(1));
  });

  it('reads it on a later run once it has aged out', async () => {
    const fresh = ledgerRow(2, { occurredAt: new Date(NOW.getTime() - 2_000) });
    const h = harness({ rows: [ledgerRow(1), fresh] });

    await aggregateUsage({ key: KEY, now: NOW }, h.port);
    await aggregateUsage({ key: KEY, now: new Date(NOW.getTime() + AGGREGATION_LAG_MS) }, h.port);

    expect(h.used).toBe(2);
    expect(h.watermark).toBe(id(2));
  });

  it('computes the cutoff from the lag', () => {
    expect(aggregationCutoff(NOW).getTime()).toBe(NOW.getTime() - AGGREGATION_LAG_MS);
    expect(aggregationCutoff(NOW, 5_000).getTime()).toBe(NOW.getTime() - 5_000);
  });

  it('falls back to the default for a nonsense lag', () => {
    // A zero lag reads to the present and reintroduces the hazard above.
    for (const bad of [0, -1, Number.NaN]) {
      expect(aggregationCutoff(NOW, bad).getTime()).toBe(NOW.getTime() - AGGREGATION_LAG_MS);
    }
  });

  it('uses a minute', () => {
    expect(AGGREGATION_LAG_MS).toBe(60_000);
  });
});

describe('when something else moved the watermark', () => {
  it('writes nothing', async () => {
    // The inline increment in the send transaction is the other writer. It
    // has already added its own row to `used`; adding this batch on top of a
    // watermark that has moved would count the overlap twice.
    const h = harness({ rows: Array.from({ length: 5 }, (_, i) => ledgerRow(i + 1)) });

    const port: AggregatePort = {
      ...h.port,
      async applyAggregate(args) {
        // Somebody commits between the read and the write.
        h.moveWatermark(id(3), 3);
        return h.port.applyAggregate(args);
      },
    };

    const result = await aggregateUsage({ key: KEY, now: NOW }, port);

    expect(result.contended).toBe(true);
    expect(result.added).toBe(0);
    expect(h.used).toBe(3);
  });

  it('says there is more to do', async () => {
    const h = harness({ rows: [ledgerRow(1)] });

    const port: AggregatePort = {
      ...h.port,
      async applyAggregate() {
        return false;
      },
    };

    expect((await aggregateUsage({ key: KEY, now: NOW }, port)).more).toBe(true);
  });

  it('stops draining rather than spinning on the conflict', async () => {
    let applies = 0;
    const h = harness({ rows: Array.from({ length: 50 }, (_, i) => ledgerRow(i + 1)) });

    const port: AggregatePort = {
      ...h.port,
      async applyAggregate() {
        applies += 1;
        return false;
      },
    };

    await aggregateUsageFully({ key: KEY, now: NOW, pageSize: 5, maxPages: 20 }, port);

    expect(applies).toBe(1);
  });
});

describe('a period with no counter row', () => {
  it('does nothing', async () => {
    // Opening the row belongs to the period-boundary job. Guessing
    // `period_end` and `included` here would be guessing an invoice.
    const h = harness({ rows: [ledgerRow(1)], aggregate: null });

    const result = await aggregateUsage({ key: KEY, now: NOW }, h.port);

    expect(result).toMatchObject({ counted: 0, added: 0, watermark: null });
    expect(h.applies).toEqual([]);
  });

  it('does not read the ledger', async () => {
    const h = harness({ rows: [ledgerRow(1)], aggregate: null });

    await aggregateUsage({ key: KEY, now: NOW }, h.port);

    expect(h.reads).toEqual([]);
  });
});

describe('folding', () => {
  it('sums quantities rather than counting rows', () => {
    const fold = foldLedger(null, [ledgerRow(1, { quantity: 3 }), ledgerRow(2, { quantity: 2 })]);

    expect(fold.added).toBe(5);
    expect(fold.counted).toBe(2);
  });

  it('ignores a quantity that would reduce the bill', () => {
    // The ledger is append-only evidence. A correction is a credit in Stripe,
    // never a negative row here.
    const fold = foldLedger(null, [ledgerRow(1, { quantity: -5 }), ledgerRow(2)]);

    expect(fold.added).toBe(1);
  });

  it('ignores a non-finite quantity', () => {
    // One NaN row makes `used` NaN, and a NaN counter compares false against
    // every limit — so the gate silently stops gating.
    const fold = foldLedger(null, [ledgerRow(1, { quantity: Number.NaN }), ledgerRow(2)]);

    expect(fold.added).toBe(1);
    expect(Number.isFinite(fold.added)).toBe(true);
  });

  it('still advances past a row it did not count', () => {
    // Otherwise the bad row is read again on every run, forever.
    const fold = foldLedger(null, [ledgerRow(1, { quantity: -5 })]);

    expect(fold.watermark).toBe(id(1));
  });
});

describe('the watermark itself', () => {
  it('keeps the current value over an empty page', () => {
    expect(advanceWatermark(id(4), [])).toBe(id(4));
  });

  it('never goes backwards', () => {
    // A page containing a row below the watermark means the caller read a
    // range it should not have. Retreating would re-count everything between.
    expect(advanceWatermark(id(9), [ledgerRow(2)])).toBe(id(9));
  });

  it('takes the highest id, not the last one', () => {
    expect(advanceWatermark(null, [ledgerRow(3), ledgerRow(9), ledgerRow(5)])).toBe(id(9));
  });

  it('compares case-insensitively', () => {
    // A backfill that inserted uppercase ids would otherwise sort every one
    // of them below every generated id, and the watermark would stop
    // advancing without anything failing.
    expect(compareUsageIds(id(5).toUpperCase(), id(5))).toBe(0);
    expect(compareUsageIds(id(6).toUpperCase(), id(5))).toBe(1);
  });
});

describe('overage', () => {
  it('is what was used beyond what the plan includes', () => {
    expect(overageFor(1_200, 1_000)).toBe(200);
  });

  it('is zero inside the allowance', () => {
    expect(overageFor(900, 1_000)).toBe(0);
    expect(overageFor(1_000, 1_000)).toBe(0);
  });

  it('is never possible on an unlimited feature', () => {
    // `null` is unlimited; `0` is a plan that includes nothing. The catalogue
    // already draws that line and this has to draw the same one.
    expect(overageFor(5_000_000, null)).toBe(0);
  });

  it('does accrue on a plan that includes nothing', () => {
    expect(overageFor(10, 0)).toBe(10);
  });

  it('caps at three times the allowance', () => {
    // docs/05: so a runaway campaign cannot produce a $40,000 invoice.
    expect(overageHardCap(1_000)).toBe(3_000);
    expect(isOverHardCap(3_000, 1_000)).toBe(false);
    expect(isOverHardCap(3_001, 1_000)).toBe(true);
  });

  it('has no cap on an unlimited feature', () => {
    expect(overageHardCap(null)).toBe(null);
    expect(isOverHardCap(10_000_000, null)).toBe(false);
  });

  it('takes a caller-supplied multiplier', () => {
    expect(overageHardCap(1_000, 2)).toBe(2_000);
  });
});

describe('reconciliation', () => {
  it('is exact when the counter matches the ledger', () => {
    expect(reconcileVerdict({ used: 100, ledgerCount: 100 })).toBe('exact');
  });

  it('names the direction', () => {
    // Behind under-bills, which is a revenue leak. Ahead over-bills, which
    // reaches a customer card. They are not the same alert.
    expect(reconcileVerdict({ used: 99, ledgerCount: 100 })).toBe('counter_behind');
    expect(reconcileVerdict({ used: 101, ledgerCount: 100 })).toBe('counter_ahead');
  });

  it('reports the drift', async () => {
    const h = harness({
      rows: Array.from({ length: 10 }, (_, i) => ledgerRow(i + 1)),
      aggregate: { used: 7 },
    });

    const report = await reconcileAggregate(KEY, h.port);

    expect(report).toMatchObject({
      verdict: 'counter_behind',
      used: 7,
      ledgerCount: 10,
      drift: -3,
    });
  });

  it('is exact after the catch-up has run', async () => {
    const h = harness({ rows: Array.from({ length: 40 }, (_, i) => ledgerRow(i + 1)) });

    await aggregateUsageFully({ key: KEY, now: NOW }, h.port);

    expect((await reconcileAggregate(KEY, h.port))?.verdict).toBe('exact');
  });

  it('has nothing to say about a period with no counter row', async () => {
    const h = harness({ rows: [ledgerRow(1)], aggregate: null });

    expect(await reconcileAggregate(KEY, h.port)).toBe(null);
  });
});
