import { sql } from 'drizzle-orm';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Entitlements: the projection everything is gated on (INVARIANTS R28).
 *
 * `entitlements` is derived from `subscriptions` x `plan_features` and is
 * rebuildable from them at any time. Nothing reads a plan code to make a
 * decision — the gate reads these rows — which is what lets a plan change
 * take effect everywhere at once rather than everywhere somebody wrote a plan
 * name.
 *
 * `readForShare` is R28. It takes a `FOR SHARE` lock on the rows inside the
 * caller's transaction, so a downgrade committing concurrently blocks until
 * the launch ends and the limit the launch checked is the limit that was true
 * when it committed. Share rather than update, because two launches in the
 * same workspace should not serialise behind each other — they only need to
 * exclude a writer.
 *
 * `rebuild` deletes and reinserts in one statement pair inside the caller's
 * transaction. Deterministic input, deterministic output: two rebuilds
 * produce byte-identical rows, which is the Phase 8 gate.
 */

export interface EntitlementRecord {
  featureKey: string;
  limitValue: number | null;
  flagValue: boolean | null;
  sourceSubscriptionId: string | null;
  sourcePlanCode: string | null;
}

export interface WorkspaceBillingStateRow {
  hasSubscription: boolean;
  pastDue: boolean;
  subscriptionSuspended: boolean;
  workspaceSuspended: boolean;
  subscriptionId: string | null;
  planCode: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

export class EntitlementsRepository {
  constructor(private readonly db: Executor) {}

  /**
   * R28: the entitlement rows, locked for the rest of the transaction.
   *
   * Call inside the launch transaction, before the snapshot. Outside a
   * transaction the lock is taken and released immediately, which is
   * indistinguishable from not taking it — so the caller owning a transaction
   * is part of the contract rather than an optimisation.
   */
  async readForShare(scope: WorkspaceScope): Promise<EntitlementRecord[]> {
    const result = await this.db.execute(sql`
      SELECT feature_key, limit_value, flag_value,
             source_subscription_id, source_plan_code
      FROM entitlements
      WHERE workspace_id = ${scope.workspaceId}::uuid
      ORDER BY feature_key
      FOR SHARE
    `);

    return (result.rows as Record<string, unknown>[]).map(toRecord);
  }

  /** The same rows without the lock, for reads that gate nothing. */
  async readAll(scope: WorkspaceScope): Promise<EntitlementRecord[]> {
    const result = await this.db.execute(sql`
      SELECT feature_key, limit_value, flag_value,
             source_subscription_id, source_plan_code
      FROM entitlements
      WHERE workspace_id = ${scope.workspaceId}::uuid
      ORDER BY feature_key
    `);

    return (result.rows as Record<string, unknown>[]).map(toRecord);
  }

  /**
   * Replaces a workspace's entitlement rows with the projection it should
   * have.
   *
   * Delete-then-insert rather than upsert-and-prune: a feature dropped from a
   * plan has to disappear, and an upsert leaves it behind. Both statements
   * belong to the caller's transaction, so a reader never sees the empty gap
   * between them.
   */
  async rebuild(scope: WorkspaceScope, rows: readonly EntitlementRecord[]): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM entitlements WHERE workspace_id = ${scope.workspaceId}::uuid
    `);

    if (rows.length === 0) {
      // No active subscription. No rows — not zeroed rows, because "not
      // entitled to send" and "entitled to send zero" would then be
      // indistinguishable, and only the first is fixed by subscribing.
      return;
    }

    const values = rows.map(
      (row) => sql`(
        ${scope.workspaceId}::uuid,
        ${row.featureKey},
        ${row.limitValue},
        ${row.flagValue},
        ${row.sourceSubscriptionId}::uuid,
        ${row.sourcePlanCode},
        now()
      )`,
    );

    await this.db.execute(sql`
      INSERT INTO entitlements
        (workspace_id, feature_key, limit_value, flag_value,
         source_subscription_id, source_plan_code, computed_at)
      VALUES ${sql.join(values, sql`, `)}
    `);
  }

  /**
   * Everything the gate needs to deny before it looks at a feature.
   *
   * One query rather than three, because the three are read together on every
   * gated action and a gate that costs three round trips is a gate somebody
   * caches wrongly.
   */
  async readBillingState(scope: WorkspaceScope): Promise<WorkspaceBillingStateRow> {
    const result = await this.db.execute(sql`
      SELECT
        w.status AS workspace_status,
        s.id     AS subscription_id,
        s.plan_code,
        s.status AS subscription_status,
        s.current_period_start,
        s.current_period_end
      FROM workspaces w
      LEFT JOIN subscriptions s
        ON s.workspace_id = w.id
       AND s.status IN ('trialing', 'active', 'past_due', 'unpaid')
      WHERE w.id = ${scope.workspaceId}::uuid
    `);

    const row = result.rows[0] as Record<string, unknown> | undefined;

    if (row === undefined) {
      // No workspace. Everything closed, which is the safe direction for a
      // row that should exist and does not.
      return {
        hasSubscription: false,
        pastDue: false,
        subscriptionSuspended: false,
        workspaceSuspended: true,
        subscriptionId: null,
        planCode: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      };
    }

    const subscriptionStatus =
      row['subscription_status'] === null || row['subscription_status'] === undefined
        ? null
        : String(row['subscription_status']);

    return {
      // `unpaid` is a row that exists and grants nothing. Counting it as a
      // subscription would answer `subscription_suspended` rather than
      // `no_subscription`, which is the more accurate of the two.
      hasSubscription:
        subscriptionStatus !== null && subscriptionStatus !== 'unpaid',
      pastDue: subscriptionStatus === 'past_due',
      subscriptionSuspended: subscriptionStatus === 'unpaid',
      workspaceSuspended: String(row['workspace_status'] ?? '') === 'suspended',
      subscriptionId: row['subscription_id'] === null ? null : String(row['subscription_id']),
      planCode: row['plan_code'] === null ? null : String(row['plan_code']),
      currentPeriodStart: (row['current_period_start'] as Date | null) ?? null,
      currentPeriodEnd: (row['current_period_end'] as Date | null) ?? null,
    };
  }

  /**
   * The workspace's live subscription, for the projection to be built from.
   *
   * `unpaid` is included so a rebuild can see it and produce no rows, rather
   * than produce nothing because it saw nothing and leave the old rows in
   * place.
   */
  async activeSubscription(scope: WorkspaceScope): Promise<{
    id: string;
    planCode: string;
    status: string;
  } | null> {
    const result = await this.db.execute(sql`
      SELECT id, plan_code, status
      FROM subscriptions
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND status IN ('trialing', 'active', 'past_due', 'unpaid')
      LIMIT 1
    `);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;

    return {
      id: String(row['id']),
      planCode: String(row['plan_code']),
      status: String(row['status']),
    };
  }
}

function toRecord(row: Record<string, unknown>): EntitlementRecord {
  return {
    featureKey: String(row['feature_key']),
    // Null is unlimited and must survive the round trip. `Number(null)` is 0,
    // which is a plan that includes nothing — the opposite statement.
    limitValue: row['limit_value'] === null ? null : Number(row['limit_value']),
    flagValue: row['flag_value'] === null ? null : Boolean(row['flag_value']),
    sourceSubscriptionId:
      row['source_subscription_id'] === null ? null : String(row['source_subscription_id']),
    sourcePlanCode: row['source_plan_code'] === null ? null : String(row['source_plan_code']),
  };
}
