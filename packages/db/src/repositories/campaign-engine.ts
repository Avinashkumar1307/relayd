import { sql } from 'drizzle-orm';
import type { CampaignId, RecipientId } from '@relayd/types';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * The engine's statements.
 *
 * Separate from `campaigns.ts` because these are a different kind of code.
 * Each one is a single statement whose `WHERE` clause *is* an invariant, and
 * every one of them returns a count or a row that the caller checks: zero
 * rows always means "somebody else got there first", never an error.
 *
 * They are written as raw SQL rather than through the query builder. That is
 * a deliberate exception to how the rest of this package is written, for one
 * reason: these statements are the invariants. `UPDATE ... WHERE state IN
 * (...) RETURNING` needs to be readable as the thing INVARIANTS.md describes,
 * by someone checking whether the code matches the rule. A builder expression
 * that compiles to the same SQL is harder to audit and easier to change
 * accidentally.
 *
 * Every statement filters on `workspace_id` as well as its own key, even
 * where the id alone is unique and even where RLS would catch it. Defence in
 * depth is the point (docs/06 four layers), and a composite predicate costs
 * nothing on an index that leads with `workspace_id`.
 */

export interface LaunchSnapshotResult {
  inserted: number;
  suppressedAtSnapshot: number;
}

export class CampaignEngineRepository {
  constructor(private readonly db: Executor) {}

  // ---------------------------------------------------------------- launch

  /**
   * R29: the guarded transition into `validating`.
   *
   * Two concurrent launches cannot both pass. The loser sees zero rows and
   * the API turns that into a 409 — or, with an Idempotency-Key, into the
   * winner's result.
   */
  async claimForLaunch(scope: WorkspaceScope, campaignId: CampaignId): Promise<boolean> {
    const { rowCount } = await this.db.execute(sql`
      UPDATE campaigns
         SET status = 'validating', updated_at = now()
       WHERE id = ${campaignId}
         AND workspace_id = ${scope.workspaceId}
         AND deleted_at IS NULL
         AND status IN ('draft', 'scheduled')
    `);

    return (rowCount ?? 0) > 0;
  }

  /** Puts a failed pre-flight back where it came from, so the draft is editable. */
  async releaseLaunchClaim(
    scope: WorkspaceScope,
    campaignId: CampaignId,
    reason: string,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE campaigns
         SET status = CASE WHEN scheduled_at IS NULL THEN 'draft' ELSE 'scheduled' END,
             updated_at = now()
       WHERE id = ${campaignId}
         AND workspace_id = ${scope.workspaceId}
         AND status = 'validating'
    `);

    await this.recordEvent(scope, {
      campaignId,
      eventType: 'launch.rejected',
      detail: { reason },
    });
  }

  /**
   * R28: the entitlement row, locked `FOR SHARE`.
   *
   * The share lock blocks a concurrent downgrade from committing until this
   * transaction ends, so the limit cannot change underneath the snapshot.
   * Returns null when there is no row, which is the Phase 6 stub: unlimited
   * until billing lands in Phase 8.
   */
  async readEntitlementForShare(
    scope: WorkspaceScope,
  ): Promise<{ monthlySendLimit: number | null; used: number } | null> {
    const { rows } = await this.db.execute<{ monthly_send_limit: number | null; used: number }>(sql`
      SELECT monthly_send_limit, used
        FROM entitlements
       WHERE workspace_id = ${scope.workspaceId}
         FOR SHARE
    `);

    const row = rows[0];
    return row === undefined
      ? null
      : { monthlySendLimit: row.monthly_send_limit, used: Number(row.used) };
  }

  /**
   * The audience snapshot.
   *
   * One statement, because a snapshot assembled in the application would pull
   * half a million rows through Node to push them straight back. Suppressed
   * contacts are counted but not inserted — R30 re-checks at send time anyway,
   * and a recipient row for someone already unsubscribed would be a row that
   * exists only to be skipped.
   *
   * `ON CONFLICT DO NOTHING` against the unique index on
   * `(campaign_id, contact_id)`: a snapshot that somehow runs twice inserts
   * nothing the second time rather than doubling the campaign.
   */
  async snapshotAudience(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; listIds: readonly string[]; segmentIds: readonly string[] },
  ): Promise<LaunchSnapshotResult> {
    const { rows: suppressedRows } = await this.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
        FROM contacts c
        JOIN contact_list_members m ON m.contact_id = c.id AND m.workspace_id = c.workspace_id
       WHERE c.workspace_id = ${scope.workspaceId}
         AND m.list_id = ANY(${sql.raw(arrayLiteral(input.listIds))}::uuid[])
         AND EXISTS (
           SELECT 1 FROM suppressions s
            WHERE s.workspace_id = c.workspace_id AND s.email = c.email
         )
    `);

    const { rows: insertedRows } = await this.db.execute<{ count: string }>(sql`
      WITH inserted AS (
        INSERT INTO campaign_recipients
          (id, workspace_id, campaign_id, contact_id, email, merge_data, message_token, state)
        SELECT gen_random_uuid(), c.workspace_id, ${input.campaignId}, c.id, c.email,
               jsonb_build_object(
                 'first_name', c.first_name,
                 'last_name', c.last_name,
                 'email', c.email
               ) || coalesce(c.attributes, '{}'::jsonb),
               gen_random_bytes(16),
               'pending'
          FROM contacts c
          JOIN contact_list_members m ON m.contact_id = c.id AND m.workspace_id = c.workspace_id
         WHERE c.workspace_id = ${scope.workspaceId}
           AND c.status = 'subscribed'
           AND m.list_id = ANY(${sql.raw(arrayLiteral(input.listIds))}::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM suppressions s
              WHERE s.workspace_id = c.workspace_id AND s.email = c.email
           )
        ON CONFLICT (campaign_id, contact_id) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::text AS count FROM inserted
    `);

    return {
      inserted: Number(insertedRows[0]?.count ?? 0),
      suppressedAtSnapshot: Number(suppressedRows[0]?.count ?? 0),
    };
  }

  /** R13: counters exist from creation, so this sets the total rather than inserting. */
  async initialiseCounters(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; total: number },
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO campaign_counters (campaign_id, workspace_id, total, pending)
      VALUES (${input.campaignId}, ${scope.workspaceId}, ${input.total}, ${input.total})
      ON CONFLICT (campaign_id) DO UPDATE
        SET total = EXCLUDED.total, pending = EXCLUDED.pending, updated_at = now()
    `);
  }

  /** `validating -> queueing`, pinning the template version the snapshot will render. */
  async markQueueing(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; recipientCount: number; templateVersionId: string },
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE campaigns
         SET status = 'queueing',
             template_version_id = ${input.templateVersionId},
             recipient_count = ${input.recipientCount},
             snapshot_at = now(),
             launched_at = now(),
             updated_at = now()
       WHERE id = ${input.campaignId}
         AND workspace_id = ${scope.workspaceId}
         AND status = 'validating'
    `);
  }

  // -------------------------------------------------------------- dispatch

  /**
   * The dispatcher's claim: `FOR UPDATE SKIP LOCKED`.
   *
   * Safe with N concurrent dispatchers — a second one takes the next page
   * rather than blocking on this one. `ORDER BY id` makes the claim
   * deterministic, which matters for the chaos test more than for production.
   */
  async claimNextRecipients(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; limit: number },
  ): Promise<{ id: RecipientId; workspaceId: string }[]> {
    const { rows } = await this.db.execute<{ id: RecipientId; workspace_id: string }>(sql`
      WITH picked AS (
        SELECT id FROM campaign_recipients
         WHERE workspace_id = ${scope.workspaceId}
           AND campaign_id = ${input.campaignId}
           AND state = 'pending'
         ORDER BY id
         LIMIT ${input.limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE campaign_recipients cr
         SET state = 'queued', queued_at = now()
        FROM picked p
       WHERE cr.id = p.id
      RETURNING cr.id, cr.workspace_id
    `);

    // Counters move with the state, in the same transaction (R13).
    if (rows.length > 0) {
      await this.moveCounters(scope, input.campaignId, { pending: -rows.length, queued: rows.length });
    }

    return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id }));
  }

  /** F3's fast path: undo a claim whose enqueue failed, without waiting for the sweeper. */
  async releaseClaims(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; recipientIds: readonly string[] },
  ): Promise<number> {
    if (input.recipientIds.length === 0) return 0;

    const { rowCount } = await this.db.execute(sql`
      UPDATE campaign_recipients
         SET state = 'pending', queued_at = NULL
       WHERE workspace_id = ${scope.workspaceId}
         AND campaign_id = ${input.campaignId}
         AND state = 'queued'
         AND id = ANY(${sql.raw(arrayLiteral(input.recipientIds))}::uuid[])
    `);

    const moved = rowCount ?? 0;
    if (moved > 0) {
      await this.moveCounters(scope, input.campaignId, { pending: moved, queued: -moved });
    }

    return moved;
  }

  /** R13: `queued + sending`, one row, never a count over recipients. */
  async inFlightCount(scope: WorkspaceScope, campaignId: CampaignId): Promise<number> {
    const { rows } = await this.db.execute<{ in_flight: string }>(sql`
      SELECT (queued + sending)::text AS in_flight
        FROM campaign_counters
       WHERE campaign_id = ${campaignId} AND workspace_id = ${scope.workspaceId}
    `);

    return Number(rows[0]?.in_flight ?? 0);
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Every campaign state change, guarded (docs/04).
   *
   * Zero rows means an illegal transition or somebody got there first. The
   * caller turns that into a 409 and never retries blindly.
   */
  async transition(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; from: readonly string[]; to: string; reason?: string },
  ): Promise<string | null> {
    const { rows } = await this.db.execute<{ status: string }>(sql`
      UPDATE campaigns
         SET status = ${input.to},
             paused_at = CASE WHEN ${input.to} = 'paused' THEN now() ELSE paused_at END,
             cancelled_at = CASE WHEN ${input.to} = 'cancelled' THEN now() ELSE cancelled_at END,
             completed_at = CASE
               WHEN ${input.to} IN ('completed', 'completed_with_errors') THEN now()
               ELSE completed_at END,
             updated_at = now()
       WHERE id = ${input.campaignId}
         AND workspace_id = ${scope.workspaceId}
         AND status = ANY(${sql.raw(arrayLiteral(input.from))}::text[])
      RETURNING status
    `);

    const row = rows[0];
    if (row === undefined) return null;

    await this.recordEvent(scope, {
      campaignId: input.campaignId,
      eventType: `campaign.${input.to}`,
      detail: input.reason === undefined ? {} : { reason: input.reason },
    });

    return row.status;
  }

  /**
   * Cancel: everything not yet at the provider stops now.
   *
   * `sending` rows are deliberately untouched — those are already at a
   * provider and cannot be recalled. The sweeper resolves them.
   */
  async cancelOutstandingRecipients(
    scope: WorkspaceScope,
    campaignId: CampaignId,
  ): Promise<number> {
    const { rows } = await this.db.execute<{ state: string; count: string }>(sql`
      WITH cancelled AS (
        UPDATE campaign_recipients
           SET state = 'cancelled', terminal_at = now()
         WHERE workspace_id = ${scope.workspaceId}
           AND campaign_id = ${campaignId}
           AND state IN ('pending', 'queued')
        RETURNING state
      )
      SELECT 'total' AS state, count(*)::text AS count FROM cancelled
    `);

    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Guarded completion (F12): `pending + queued + sending = 0`, read from the
   * counter row rather than from the recipients.
   */
  async maybeComplete(scope: WorkspaceScope, campaignId: CampaignId): Promise<boolean> {
    const { rowCount } = await this.db.execute(sql`
      UPDATE campaigns c
         SET status = CASE WHEN cc.failed > 0 THEN 'completed_with_errors' ELSE 'completed' END,
             completed_at = now(),
             updated_at = now()
        FROM campaign_counters cc
       WHERE c.id = ${campaignId}
         AND c.workspace_id = ${scope.workspaceId}
         AND cc.campaign_id = c.id
         AND c.status IN ('queueing', 'sending', 'pausing')
         AND cc.pending = 0 AND cc.queued = 0 AND cc.sending = 0
    `);

    return (rowCount ?? 0) > 0;
  }

  // ----------------------------------------------------------------- retry

  /**
   * R14/F14: `retry-failed` never touches `metered`.
   *
   * The column is not in the SET list, and `trg_guard_metered` would reject
   * the statement if it were. Both guards are deliberate: this one fails at
   * review, that one fails at runtime.
   */
  async resetRetryableFailures(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; retryableCodes: readonly string[] },
  ): Promise<number> {
    if (input.retryableCodes.length === 0) return 0;

    const { rowCount } = await this.db.execute(sql`
      UPDATE campaign_recipients
         SET state = 'pending',
             attempt_count = 0,
             error_code = NULL,
             error_message = NULL,
             queued_at = NULL,
             provider_attempt_started_at = NULL,
             attempt_token = NULL
       WHERE workspace_id = ${scope.workspaceId}
         AND campaign_id = ${input.campaignId}
         AND state = 'failed'
         AND error_code = ANY(${sql.raw(arrayLiteral(input.retryableCodes))}::text[])
    `);

    const moved = rowCount ?? 0;
    if (moved > 0) {
      await this.moveCounters(scope, input.campaignId, { pending: moved, failed: -moved });
    }

    return moved;
  }

  async countPermanentFailures(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; retryableCodes: readonly string[] },
  ): Promise<Record<string, number>> {
    const { rows } = await this.db.execute<{ error_code: string | null; count: string }>(sql`
      SELECT error_code, count(*)::text AS count
        FROM campaign_recipients
       WHERE workspace_id = ${scope.workspaceId}
         AND campaign_id = ${input.campaignId}
         AND state = 'failed'
         AND (error_code IS NULL
              OR NOT (error_code = ANY(${sql.raw(arrayLiteral(input.retryableCodes))}::text[])))
       GROUP BY error_code
    `);

    // A GROUP BY over one campaign's failures, not over the table, and only
    // on an explicit user action rather than in a polling path. R13 forbids
    // the aggregate in a *request* path that runs continuously; this runs
    // once when somebody clicks retry.
    const result: Record<string, number> = {};
    for (const row of rows) result[row.error_code ?? 'unknown'] = Number(row.count);
    return result;
  }

  // ----------------------------------------------------------------- events

  async recordEvent(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; eventType: string; detail: unknown },
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO campaign_events (workspace_id, campaign_id, event_type, detail)
      VALUES (${scope.workspaceId}, ${input.campaignId}, ${input.eventType},
              ${JSON.stringify(input.detail ?? {})}::jsonb)
    `);
  }

  /**
   * Moves counters by a delta, in the same transaction as the state change.
   *
   * Deltas rather than absolute values: two transitions committing
   * concurrently would otherwise write over each other's totals, and the
   * counter is the number the customer watches.
   */
  private async moveCounters(
    scope: WorkspaceScope,
    campaignId: CampaignId,
    delta: Partial<Record<'pending' | 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed' | 'uncertain', number>>,
  ): Promise<void> {
    const entries = Object.entries(delta).filter(([, value]) => value !== 0);
    if (entries.length === 0) return;

    const assignments = entries
      .map(([column, value]) => `${column} = ${column} + ${Math.trunc(value as number)}`)
      .join(', ');

    await this.db.execute(sql`
      UPDATE campaign_counters
         SET ${sql.raw(assignments)}, updated_at = now()
       WHERE campaign_id = ${campaignId} AND workspace_id = ${scope.workspaceId}
    `);
  }
}

/**
 * A Postgres array literal from a list of ids.
 *
 * Every element is checked against a strict pattern before it is interpolated.
 * `sql.raw` is the one place in this file where a value is not parameterised,
 * so the pattern is the guard — anything that is not a plain identifier is
 * refused rather than escaped, because refusing is checkable and escaping is
 * a thing one gets subtly wrong.
 */
function arrayLiteral(values: readonly string[]): string {
  for (const value of values) {
    if (!/^[A-Za-z0-9_:.-]{1,64}$/u.test(value)) {
      throw new Error(`Refusing to interpolate an unexpected identifier: ${JSON.stringify(value)}`);
    }
  }

  return `ARRAY[${values.map((value) => `'${value}'`).join(', ')}]`;
}
