/**
 * Metering (INVARIANTS R14, R15; CLAUDE.md section 10).
 *
 * The billable unit is one `campaign_recipients` row reaching `sent` for the
 * first time. Nothing else is: not a retry, not a failover, not a bounce, not
 * a complaint, not a `delivery_uncertain` recipient, not a suppressed one.
 * Refunds never claw usage back and an upgrade never resets the counter.
 *
 * Three structures, in the order money moves through them:
 *
 *   **`campaign_recipients.metered`** — write-once, enforced by a database
 *   trigger. The guarded `UPDATE ... WHERE metered = false` in the send
 *   transaction is the first idempotency guard.
 *
 *   **`usage_records`** — the ledger. One row per billable event, with a
 *   unique `idempotency_key = send:{recipientId}`. The second guard, and the
 *   evidence: every number we bill from can be traced back to rows here.
 *
 *   **`usage_aggregates`** — the counter the entitlement gate reads. Derived,
 *   and therefore rebuildable.
 *
 * Two guards rather than one because they fail differently. The `metered`
 * predicate protects against the same worker retrying; the unique index
 * protects against two workers racing, and against a bug in the first guard.
 * Either alone would be sufficient, which is the point.
 *
 * ## The watermark (R15)
 *
 * `usage_aggregates` is advanced two ways and they must not both count the
 * same ledger row:
 *
 *   1. **Inline**, inside the send transaction — the ledger insert and the
 *      counter increment commit together, and the increment carries the new
 *      row id forward as the watermark. This is the normal path.
 *
 *   2. **Catch-up**, this file's `aggregateUsage` — reads the ledger at
 *      `id > last_usage_record_id`, folds what it finds into `used`, and
 *      advances the watermark in the same transaction. This is the repair
 *      path: a micro-batched worker that deliberately skipped the inline
 *      increment, a counter rebuilt from scratch, a period whose rows were
 *      backfilled.
 *
 * Because the inline path only ever moves the watermark forward, a row it
 * already counted sits below the watermark and the catch-up will not see it.
 * Because the catch-up advances the watermark in the transaction that adds the
 * total, running it again reads an empty range and adds nothing. Running it
 * three times over the same ledger gives the totals of running it once, which
 * is exactly what R15 asks for.
 *
 * ## Why the lag window exists
 *
 * UUIDv7 is time-ordered, so `id > watermark` is a stable cursor — but *only*
 * over committed rows. A transaction that generated its id at t=100 and
 * commits at t=105 is invisible to a reader at t=104 that has already
 * consumed a row generated at t=102. Advance the watermark past t=102 and the
 * straggler is never seen again: a row in the ledger, billed, absent from the
 * counter.
 *
 * So the catch-up refuses to read rows newer than `AGGREGATION_LAG_MS`. A
 * transaction still open after a minute has larger problems, and
 * `reconcileVerdict` is the backstop that catches what the lag does not.
 * `docs/05-billing.md` does not discuss this; see docs/16 for the dated note.
 */

/** How far behind the clock the catch-up reads. See the note above. */
export const AGGREGATION_LAG_MS = 60_000;

/** Ledger rows per page. The fold is O(rows), so this bounds memory, not work. */
export const AGGREGATION_PAGE = 1_000;

/**
 * The ledger key for a send.
 *
 * `send:{recipientId}` and nothing else — the recipient id is already unique
 * per campaign per contact, so an attempt number in here would defeat the
 * whole guard by making every retry a new key.
 */
export function usageIdempotencyKey(recipientId: string): string {
  return `send:${recipientId}`;
}

export interface LedgerRow {
  id: string;
  workspaceId: string;
  featureKey: string;
  quantity: number;
  periodStart: Date;
  occurredAt: Date;
}

export interface AggregateKey {
  workspaceId: string;
  featureKey: string;
  periodStart: Date;
}

export interface AggregateRow extends AggregateKey {
  periodEnd: Date;
  used: number;
  included: number | null;
  overage: number;
  lastUsageRecordId: string | null;
}

/**
 * Compares two usage record ids.
 *
 * Ours are UUIDv7 rendered lowercase, so byte order is time order and a
 * string compare is the cursor. Case is normalised anyway: a hand-written
 * backfill that inserted uppercase ids would otherwise sort every one of them
 * below every generated id, and the watermark would silently stop advancing.
 */
export function compareUsageIds(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The watermark after folding in a page.
 *
 * Only ever forward. A page containing a row below the current watermark
 * means the caller read a range it should not have; keeping the higher value
 * means the next read cannot go backwards and re-count what is already in
 * `used`.
 */
export function advanceWatermark(current: string | null, rows: readonly LedgerRow[]): string | null {
  let highest = current;

  for (const row of rows) {
    if (highest === null || compareUsageIds(row.id, highest) > 0) {
      highest = row.id;
    }
  }

  return highest;
}

export interface Fold {
  added: number;
  counted: number;
  watermark: string | null;
}

/**
 * Folds a page of ledger rows into a total and a new watermark.
 *
 * Pure, so the arithmetic an invoice is computed from is testable without a
 * database.
 */
export function foldLedger(current: string | null, rows: readonly LedgerRow[]): Fold {
  let added = 0;

  for (const row of rows) {
    // A negative or non-finite quantity would silently reduce a bill. The
    // ledger has no correction path by design: a mistake is fixed by a credit
    // in Stripe, never by rewriting evidence.
    if (!Number.isFinite(row.quantity) || row.quantity <= 0) continue;
    added += Math.trunc(row.quantity);
  }

  return { added, counted: rows.length, watermark: advanceWatermark(current, rows) };
}

/** The newest `occurred_at` the catch-up will read. */
export function aggregationCutoff(now: Date, lagMs: number = AGGREGATION_LAG_MS): Date {
  const lag = Number.isFinite(lagMs) && lagMs > 0 ? lagMs : AGGREGATION_LAG_MS;
  return new Date(now.getTime() - lag);
}

export interface AggregatePort {
  /** The counter row, or null if the period has not been opened yet. */
  readAggregate(key: AggregateKey): Promise<AggregateRow | null>;

  /**
   * Ledger rows at `id > afterId`, `occurred_at < before`, ascending by id.
   *
   * Ascending matters: the fold takes the highest id as the new watermark,
   * and an unordered read truncated by `limit` would leave rows below it
   * unseen forever.
   */
  readLedgerAfter(input: {
    key: AggregateKey;
    afterId: string | null;
    before: Date;
    limit: number;
  }): Promise<LedgerRow[]>;

  /**
   * Adds to `used` and moves the watermark, in one transaction.
   *
   * `expectedWatermark` is a compare-and-set: the update carries
   * `WHERE last_usage_record_id IS NOT DISTINCT FROM $expected`, so a
   * concurrent inline increment that moved the watermark between the read and
   * the write loses this batch rather than double-counting it. Returns false
   * when it did not apply, and the caller re-reads.
   */
  applyAggregate(input: {
    key: AggregateKey;
    addUsed: number;
    watermark: string | null;
    expectedWatermark: string | null;
  }): Promise<boolean>;

  /** `COUNT(*)` over the ledger for the period. The reconciler's evidence. */
  countLedger(key: AggregateKey): Promise<number>;
}

export interface AggregationResult {
  /** Rows folded in this run. Zero on a second run, which is R15. */
  counted: number;
  added: number;
  watermark: string | null;
  /** True when the page limit was reached and there is more to do. */
  more: boolean;
  /** True when a concurrent writer moved the watermark and we backed off. */
  contended: boolean;
}

/**
 * The catch-up (R15).
 *
 * Reads at `id > watermark`, folds, and advances the watermark in the same
 * transaction as the total it adds. Run it three times over the same ledger
 * and the second and third runs read an empty range.
 */
export async function aggregateUsage(
  input: { key: AggregateKey; now: Date; lagMs?: number; pageSize?: number },
  port: AggregatePort,
): Promise<AggregationResult> {
  const aggregate = await port.readAggregate(input.key);

  if (aggregate === null) {
    // No counter row. Opening one is the period-boundary job's work, not this
    // one's — inventing a row here would guess `period_end` and `included`,
    // and a guessed `included` is a guessed invoice.
    return { counted: 0, added: 0, watermark: null, more: false, contended: false };
  }

  const limit = pageSizeFor(input.pageSize);
  const before = aggregationCutoff(input.now, input.lagMs ?? AGGREGATION_LAG_MS);

  const rows = await port.readLedgerAfter({
    key: input.key,
    afterId: aggregate.lastUsageRecordId,
    before,
    limit,
  });

  if (rows.length === 0) {
    return {
      counted: 0,
      added: 0,
      watermark: aggregate.lastUsageRecordId,
      more: false,
      contended: false,
    };
  }

  const fold = foldLedger(aggregate.lastUsageRecordId, rows);

  const applied = await port.applyAggregate({
    key: input.key,
    addUsed: fold.added,
    watermark: fold.watermark,
    expectedWatermark: aggregate.lastUsageRecordId,
  });

  if (!applied) {
    // Somebody else moved the watermark. Nothing was written; the next run
    // reads from wherever they left it.
    return {
      counted: 0,
      added: 0,
      watermark: aggregate.lastUsageRecordId,
      more: true,
      contended: true,
    };
  }

  return {
    counted: fold.counted,
    added: fold.added,
    watermark: fold.watermark,
    more: rows.length >= limit,
    contended: false,
  };
}

function pageSizeFor(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return AGGREGATION_PAGE;
  // Floor of one. A page size of zero reads nothing forever, and the caller
  // that loops on `more` would never stop.
  return Math.min(AGGREGATION_PAGE, Math.max(1, Math.floor(requested)));
}

/**
 * Drains the catch-up for one period.
 *
 * Bounded by `maxPages` rather than looping until empty: a period being
 * written to faster than this reads it would otherwise hold the job forever,
 * and the next tick is a better place to continue than a loop with no exit.
 */
export async function aggregateUsageFully(
  input: { key: AggregateKey; now: Date; lagMs?: number; pageSize?: number; maxPages?: number },
  port: AggregatePort,
): Promise<AggregationResult> {
  const maxPages = Math.max(1, Math.floor(input.maxPages ?? 50));

  let counted = 0;
  let added = 0;
  let watermark: string | null = null;
  let more = false;
  let contended = false;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await aggregateUsage(input, port);

    counted += result.counted;
    added += result.added;
    watermark = result.watermark;
    contended = contended || result.contended;
    more = result.more;

    if (!result.more) break;
    if (result.contended) break;
  }

  return { counted, added, watermark, more, contended };
}

/**
 * Overage: what was used beyond what the plan includes.
 *
 * `included === null` is unlimited and can never overage. `included === 0` is
 * a plan that includes nothing, which is a different statement and does
 * overage — the distinction `limitFor` already makes in the catalogue.
 */
export function overageFor(used: number, included: number | null): number {
  if (included === null) return 0;
  if (!Number.isFinite(used) || !Number.isFinite(included)) return 0;
  return Math.max(0, Math.trunc(used) - Math.trunc(included));
}

/** docs/05: a hard ceiling so a runaway campaign cannot generate a $40,000 invoice. */
export const OVERAGE_HARD_CAP_MULTIPLIER = 3;

export function overageHardCap(
  included: number | null,
  multiplier = OVERAGE_HARD_CAP_MULTIPLIER,
): number | null {
  if (included === null) return null;
  if (!Number.isFinite(included)) return null;
  return Math.max(0, Math.trunc(included)) * Math.max(1, Math.trunc(multiplier));
}

/**
 * Whether sending must stop.
 *
 * Only ever consulted when overage is allowed at all; a plan without overage
 * stops at `included`, which is the entitlement gate's job rather than this
 * one's.
 */
export function isOverHardCap(used: number, included: number | null, multiplier?: number): boolean {
  const cap = overageHardCap(included, multiplier);
  if (cap === null) return false;
  return Math.trunc(used) > cap;
}

export type ReconcileVerdict = 'exact' | 'counter_behind' | 'counter_ahead';

/**
 * docs/05's first reconciliation check: `used` versus `COUNT(*)`.
 *
 * Must be exact, and the direction is worth reporting separately. A counter
 * behind the ledger under-bills and is a revenue leak; a counter ahead of it
 * over-bills, which is the one that reaches a customer's card.
 */
export function reconcileVerdict(input: { used: number; ledgerCount: number }): ReconcileVerdict {
  const used = Math.trunc(input.used);
  const ledger = Math.trunc(input.ledgerCount);

  if (used === ledger) return 'exact';
  return used < ledger ? 'counter_behind' : 'counter_ahead';
}

export interface ReconcileReport extends AggregateKey {
  verdict: ReconcileVerdict;
  used: number;
  ledgerCount: number;
  drift: number;
}

export async function reconcileAggregate(
  key: AggregateKey,
  port: AggregatePort,
): Promise<ReconcileReport | null> {
  const aggregate = await port.readAggregate(key);
  if (aggregate === null) return null;

  const ledgerCount = await port.countLedger(key);

  return {
    ...key,
    verdict: reconcileVerdict({ used: aggregate.used, ledgerCount }),
    used: aggregate.used,
    ledgerCount,
    drift: Math.trunc(aggregate.used) - Math.trunc(ledgerCount),
  };
}
