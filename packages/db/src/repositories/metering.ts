import { sql } from 'drizzle-orm';
import type { WorkspaceId } from '@relayd/types';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Metering: the ledger and the counter (INVARIANTS R14, R15).
 *
 * Two statements matter here and the rest is reading.
 *
 * `recordSendUsage` is the billing half of the send transaction. It is meant
 * to be called inside the same transaction as the guarded
 * `UPDATE campaign_recipients ... WHERE metered = false`, never on its own —
 * splitting them means a crash between the two either bills a send that did
 * not happen or loses one that did. The ledger insert is
 * `ON CONFLICT DO NOTHING RETURNING id`, and the counter moves only when that
 * returns a row. A duplicate delivery inserts nothing and increments nothing.
 *
 * `applyAggregate` is the catch-up's write. It is a compare-and-set on the
 * watermark: `WHERE last_usage_record_id IS NOT DISTINCT FROM $expected`, so a
 * concurrent inline increment that moved the watermark between the read and
 * the write makes this update match zero rows rather than add a total on top
 * of one already counted. `IS NOT DISTINCT FROM` rather than `=` because the
 * expected value is null for a period nothing has been aggregated into yet,
 * and `= NULL` is null, not true.
 *
 * The arithmetic these two feed is in `@relayd/billing`'s `metering/meter.ts`,
 * which is where the R15 property is proved. This file is the SQL.
 */

export interface UsageAggregateRow {
  workspaceId: WorkspaceId;
  featureKey: string;
  periodStart: Date;
  periodEnd: Date;
  used: number;
  included: number | null;
  overage: number;
  lastUsageRecordId: string | null;
}

export interface UsageLedgerRow {
  id: string;
  workspaceId: WorkspaceId;
  featureKey: string;
  quantity: number;
  periodStart: Date;
  occurredAt: Date;
}

export interface AggregateKeyInput {
  featureKey: string;
  periodStart: Date;
}

export class MeteringRepository {
  constructor(private readonly db: Executor) {}

  /**
   * The billing half of the send transaction.
   *
   * Call inside the transaction that moves the recipient to `sent`. Returns
   * true when this call is what billed the send, false when the ledger
   * already held the row — which is a retry, and must leave every number
   * alone.
   */
  async recordSendUsage(
    scope: WorkspaceScope,
    input: {
      usageRecordId: string;
      featureKey: string;
      idempotencyKey: string;
      campaignId: string;
      recipientId: string;
      periodStart: Date;
      periodEnd: Date;
      occurredAt: Date;
      quantity?: number;
    },
  ): Promise<boolean> {
    const quantity = Math.max(1, Math.trunc(input.quantity ?? 1));

    const inserted = await this.db.execute(sql`
      INSERT INTO usage_records
        (id, workspace_id, feature_key, quantity, idempotency_key,
         campaign_id, resource_id, period_start, occurred_at)
      VALUES
        (${input.usageRecordId}::uuid, ${scope.workspaceId}::uuid, ${input.featureKey},
         ${quantity}, ${input.idempotencyKey}, ${input.campaignId}::uuid,
         ${input.recipientId}::uuid, ${input.periodStart}, ${input.occurredAt})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);

    // No row means the unique index refused it: this send is already in the
    // ledger. Incrementing the counter here would bill it twice, which is the
    // failure the index exists to prevent.
    if ((inserted.rows.length ?? 0) === 0) return false;

    await this.db.execute(sql`
      INSERT INTO usage_aggregates
        (workspace_id, feature_key, period_start, period_end, used, last_usage_record_id)
      VALUES
        (${scope.workspaceId}::uuid, ${input.featureKey}, ${input.periodStart},
         ${input.periodEnd}, ${quantity}, ${input.usageRecordId}::uuid)
      ON CONFLICT (workspace_id, feature_key, period_start) DO UPDATE
      SET used = usage_aggregates.used + EXCLUDED.used,
          -- Forward only. GREATEST ignores nulls, so a period whose watermark
          -- has never been set takes this row's id.
          last_usage_record_id =
            GREATEST(usage_aggregates.last_usage_record_id, EXCLUDED.last_usage_record_id),
          updated_at = now()
    `);

    return true;
  }

  async readAggregate(
    scope: WorkspaceScope,
    key: AggregateKeyInput,
  ): Promise<UsageAggregateRow | null> {
    const result = await this.db.execute(sql`
      SELECT workspace_id, feature_key, period_start, period_end,
             used, included, overage, last_usage_record_id
      FROM usage_aggregates
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND feature_key = ${key.featureKey}
        AND period_start = ${key.periodStart}
    `);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;

    return {
      workspaceId: String(row['workspace_id']) as WorkspaceId,
      featureKey: String(row['feature_key']),
      periodStart: row['period_start'] as Date,
      periodEnd: row['period_end'] as Date,
      used: Number(row['used']),
      included: row['included'] === null ? null : Number(row['included']),
      overage: Number(row['overage']),
      lastUsageRecordId:
        row['last_usage_record_id'] === null ? null : String(row['last_usage_record_id']),
    };
  }

  /**
   * Ledger rows past the watermark, ascending.
   *
   * `ORDER BY id` is not decoration: the fold takes the highest id it saw as
   * the new watermark, and an unordered read truncated by `LIMIT` would leave
   * rows below that id unread forever.
   *
   * `occurred_at < before` is the lag window. UUIDv7 is generated at
   * statement time and becomes visible at commit time, so reading to the
   * present and advancing past what is visible strands any transaction that
   * generated an earlier id and has not committed yet.
   */
  async readLedgerAfter(
    scope: WorkspaceScope,
    input: {
      featureKey: string;
      periodStart: Date;
      afterId: string | null;
      before: Date;
      limit: number;
    },
  ): Promise<UsageLedgerRow[]> {
    const limit = Math.max(1, Math.trunc(input.limit));

    const result = await this.db.execute(sql`
      SELECT id, workspace_id, feature_key, quantity, period_start, occurred_at
      FROM usage_records
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND feature_key = ${input.featureKey}
        AND period_start = ${input.periodStart}
        AND occurred_at < ${input.before}
        AND (${input.afterId}::uuid IS NULL OR id > ${input.afterId}::uuid)
      ORDER BY id
      LIMIT ${limit}
    `);

    return (result.rows as Record<string, unknown>[]).map((row) => ({
      id: String(row['id']),
      workspaceId: String(row['workspace_id']) as WorkspaceId,
      featureKey: String(row['feature_key']),
      quantity: Number(row['quantity']),
      periodStart: row['period_start'] as Date,
      occurredAt: row['occurred_at'] as Date,
    }));
  }

  /**
   * The catch-up write: add a total and move the watermark, together.
   *
   * Returns false when the watermark moved underneath us. Nothing was
   * written; the caller re-reads and starts from wherever the other writer
   * left it.
   */
  async applyAggregate(
    scope: WorkspaceScope,
    input: {
      featureKey: string;
      periodStart: Date;
      addUsed: number;
      watermark: string | null;
      expectedWatermark: string | null;
    },
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE usage_aggregates
      SET used = used + ${Math.max(0, Math.trunc(input.addUsed))},
          last_usage_record_id = ${input.watermark}::uuid,
          updated_at = now()
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND feature_key = ${input.featureKey}
        AND period_start = ${input.periodStart}
        -- The compare-and-set. IS NOT DISTINCT FROM rather than =, because
        -- the expected value is null for a period nothing has been
        -- aggregated into yet, and = NULL is null rather than true.
        AND last_usage_record_id IS NOT DISTINCT FROM ${input.expectedWatermark}::uuid
      RETURNING workspace_id
    `);

    return (result.rows.length ?? 0) > 0;
  }

  /** The reconciler's evidence: what the ledger actually holds. */
  async countLedger(scope: WorkspaceScope, key: AggregateKeyInput): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT count(*)::bigint AS n
      FROM usage_records
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND feature_key = ${key.featureKey}
        AND period_start = ${key.periodStart}
    `);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? 0 : Number(row['n']);
  }

  /**
   * Opens the counter for a period.
   *
   * Idempotent, and deliberately does not touch `used` or the watermark on
   * conflict: a period opened twice must not lose what has already accrued
   * into it. `included` is refreshed, because an upgrade mid-period raises
   * the allowance without resetting the counter.
   */
  async openPeriod(
    scope: WorkspaceScope,
    input: {
      featureKey: string;
      periodStart: Date;
      periodEnd: Date;
      included: number | null;
      subscriptionId: string | null;
    },
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO usage_aggregates
        (workspace_id, feature_key, period_start, period_end, included, subscription_id)
      VALUES
        (${scope.workspaceId}::uuid, ${input.featureKey}, ${input.periodStart},
         ${input.periodEnd}, ${input.included}, ${input.subscriptionId}::uuid)
      ON CONFLICT (workspace_id, feature_key, period_start) DO UPDATE
      SET period_end = EXCLUDED.period_end,
          included = EXCLUDED.included,
          subscription_id = EXCLUDED.subscription_id,
          updated_at = now()
    `);
  }

  /** Records the computed overage. Separate because the arithmetic is not SQL's. */
  async setOverage(
    scope: WorkspaceScope,
    input: { featureKey: string; periodStart: Date; overage: number },
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE usage_aggregates
      SET overage = ${Math.max(0, Math.trunc(input.overage))},
          updated_at = now()
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND feature_key = ${input.featureKey}
        AND period_start = ${input.periodStart}
    `);
  }
}
