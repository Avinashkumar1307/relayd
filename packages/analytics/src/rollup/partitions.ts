/**
 * Partition maintenance (INVARIANTS R25, review finding F25).
 *
 * At ten million events a day a monthly partition is three hundred million
 * rows. The cost of getting this wrong is not a slow query — it is that
 * retro-fitting partitioning to a table that size is the one migration nobody
 * wants to run, and every day this job does not run brings that closer.
 *
 * Two rules from F25, and a third that follows from them:
 *
 *   **Ahead of time.** Partitions are created seven days before they are
 *   needed. A partition created on demand is created by whichever insert
 *   happens to arrive first, in that insert's transaction, holding a lock on
 *   the parent — which is the write path.
 *
 *   **With `lock_timeout`.** Attaching needs a brief lock on the parent. If a
 *   long-running query holds one, failing after five seconds and retrying
 *   tomorrow is far better than queueing every insert behind us. The timeout
 *   lives in the SQL function, set with `SET LOCAL` so it applies to that
 *   statement and nothing else.
 *
 *   **Idempotently.** The scheduler runs this daily forever and must not need
 *   to remember what it did yesterday. Creating a partition that exists is a
 *   no-op.
 *
 * Retention is deliberately not here. Dropping a partition is destructive and
 * irreversible, and a job that both creates and drops is one bug away from
 * dropping what it meant to create. Archival and detach are a separate,
 * operator-initiated path.
 */

/** How far ahead to keep partitions, per R25. */
export const PARTITION_LEAD_DAYS = 7;

/** The tables partitioned by range on a timestamp. */
export const PARTITIONED_TABLES = ['email_events', 'usage_records'] as const;

export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

export interface PartitionPort {
  /**
   * Creates one month's partition if it is missing, and returns its name.
   *
   * Backed by `ensure_month_partition`, which sets `lock_timeout` itself.
   */
  ensureMonthPartition(input: { table: PartitionedTable; monthStart: Date }): Promise<string>;

  /** Partition names that already exist for a parent. */
  existingPartitions(table: PartitionedTable): Promise<string[]>;
}

export interface PartitionResult {
  created: string[];
  existing: string[];
  failed: { table: PartitionedTable; monthStart: string; reason: string }[];
}

/**
 * The months that must exist to cover `now` plus the lead time.
 *
 * Returns first-of-month dates in UTC. Usually one, two when the lead window
 * crosses a month boundary — which is the case the whole job exists for, and
 * the case a naive "create next month on the 1st" would miss by a week.
 */
export function monthsToCover(now: Date, leadDays = PARTITION_LEAD_DAYS): Date[] {
  const horizon = new Date(now.getTime() + leadDays * 86_400_000);

  const months: Date[] = [];
  const cursor = startOfMonthUtc(now);

  // At most a handful of iterations; the bound is defensive rather than
  // expected, so a nonsense lead time cannot spin here.
  for (let i = 0; i < 24 && cursor.getTime() <= horizon.getTime(); i += 1) {
    months.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

/**
 * One pass of `partition-maintenance`.
 *
 * Every table, every month in the window. A failure on one is recorded and
 * the pass continues: a lock contention on `email_events` must not stop
 * `usage_records` from getting the partition it needs tomorrow.
 */
export async function ensurePartitions(
  port: PartitionPort,
  input: { now: Date; leadDays?: number },
): Promise<PartitionResult> {
  const months = monthsToCover(input.now, input.leadDays ?? PARTITION_LEAD_DAYS);

  const created: string[] = [];
  const existing: string[] = [];
  const failed: PartitionResult['failed'] = [];

  for (const table of PARTITIONED_TABLES) {
    const before = new Set(await port.existingPartitions(table));

    for (const monthStart of months) {
      try {
        const name = await port.ensureMonthPartition({ table, monthStart });
        (before.has(name) ? existing : created).push(name);
      } catch (error) {
        // A lock timeout is the expected failure and is not an incident: the
        // next daily run will get it, and the lead time is seven days for
        // exactly this reason.
        failed.push({
          table,
          monthStart: monthStart.toISOString().slice(0, 10),
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }

  return { created, existing, failed };
}

/**
 * Whether the partitions needed for the next `leadDays` all exist.
 *
 * The alarm condition, separate from the job that fixes it. A maintenance job
 * that silently failed for six days looks identical to one that had nothing
 * to do, and this is what tells them apart.
 */
export async function partitionsAreHealthy(
  port: PartitionPort,
  input: { now: Date; leadDays?: number },
): Promise<{ healthy: boolean; missing: string[] }> {
  const months = monthsToCover(input.now, input.leadDays ?? PARTITION_LEAD_DAYS);
  const missing: string[] = [];

  for (const table of PARTITIONED_TABLES) {
    const existing = new Set(await port.existingPartitions(table));

    for (const monthStart of months) {
      const name = partitionNameFor(table, monthStart);
      if (!existing.has(name)) missing.push(name);
    }
  }

  return { healthy: missing.length === 0, missing };
}

/**
 * The partition name for a month.
 *
 * Must match `ensure_month_partition` exactly — the function builds the same
 * string in SQL, and a mismatch here would report every partition missing
 * while the job reported every one created.
 */
export function partitionNameFor(table: PartitionedTable, monthStart: Date): string {
  const year = monthStart.getUTCFullYear();
  const month = String(monthStart.getUTCMonth() + 1).padStart(2, '0');
  return `${table}_${year}_${month}`;
}

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
