import { and, eq, sql } from 'drizzle-orm';
import { workspaceSendQuota, workspaceTrust } from '../schema/abuse.js';
import { workspaces } from '../schema/identity.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * The new-workspace ramp (docs/06 "Anti-abuse"; migration 0015).
 *
 * The policy is in `packages/campaigns/src/abuse/ramp.ts` and is pure. This
 * is only the I/O: read the three inputs, increment the counter, lift the
 * ramp.
 */

export interface RampState {
  createdAt: Date;
  trust: {
    rampLiftedAt: Date | null;
    rampLiftedBy: 'automatic' | 'operator' | null;
    rampUntil: Date | null;
  } | null;
  sentToday: number;
}

export class RampRepository {
  constructor(private readonly db: Executor) {}

  /**
   * The workspace's creation time, its trust row, and today's send count.
   *
   * One query, deliberately. Dispatch reads this on every page, and three
   * round trips per page across a 500k-recipient campaign is a thousand
   * unnecessary round trips — but more importantly, three separate reads
   * could straddle UTC midnight and produce a count from one day compared
   * against a cap computed for another.
   *
   * `sentToday` is `COALESCE`d to zero: the quota row is created on the
   * first send of the day, so its absence means none.
   */
  async readState(scope: WorkspaceScope, day: string): Promise<RampState | null> {
    const [row] = await this.db
      .select({
        createdAt: workspaces.createdAt,
        rampLiftedAt: workspaceTrust.rampLiftedAt,
        rampLiftedBy: workspaceTrust.rampLiftedBy,
        rampUntil: workspaceTrust.rampUntil,
        hasTrust: sql<boolean>`${workspaceTrust.workspaceId} is not null`,
        sentToday: sql<number>`coalesce(${workspaceSendQuota.sent}, 0)`,
      })
      .from(workspaces)
      .leftJoin(workspaceTrust, eq(workspaceTrust.workspaceId, workspaces.id))
      .leftJoin(
        workspaceSendQuota,
        and(
          eq(workspaceSendQuota.workspaceId, workspaces.id),
          eq(workspaceSendQuota.day, day),
        ),
      )
      .where(eq(workspaces.id, scope.workspaceId));

    if (row === undefined) return null;

    return {
      createdAt: row.createdAt,
      trust: row.hasTrust
        ? {
            rampLiftedAt: row.rampLiftedAt,
            rampLiftedBy: row.rampLiftedBy as 'automatic' | 'operator' | null,
            rampUntil: row.rampUntil,
          }
        : null,
      sentToday: Number(row.sentToday),
    };
  }

  /**
   * Adds to today's count, creating the row on the first send of the day.
   *
   * An upsert rather than a read-then-write: N send workers increment this
   * concurrently, and a read-modify-write would lose increments under
   * exactly the load the cap exists to limit.
   *
   * Returns the new total so a caller can stop without a second read.
   */
  async recordSends(scope: WorkspaceScope, day: string, count: number): Promise<number> {
    if (count <= 0) {
      // Not an error, and not a write. A dispatch page that enqueued nothing
      // must not create a quota row, because an empty row and no row have to
      // mean the same thing for `readState`'s COALESCE to be honest.
      const state = await this.readState(scope, day);
      return state?.sentToday ?? 0;
    }

    const [row] = await this.db
      .insert(workspaceSendQuota)
      .values({ workspaceId: scope.workspaceId, day, sent: count })
      .onConflictDoUpdate({
        target: [workspaceSendQuota.workspaceId, workspaceSendQuota.day],
        set: {
          sent: sql`${workspaceSendQuota.sent} + ${count}`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ sent: workspaceSendQuota.sent });

    if (row === undefined) throw new Error('recordSends: upsert returned no row');
    return row.sent;
  }

  /**
   * Lifts the ramp.
   *
   * `WHERE ramp_lifted_at IS NULL` makes it idempotent and makes the *first*
   * lift the one that is recorded. Two lifts racing — the nightly automatic
   * job and an operator clicking at the same moment — would otherwise
   * overwrite each other's attribution, and the attribution is the reason
   * the column exists.
   */
  async lift(
    scope: WorkspaceScope,
    input: { by: 'automatic' | 'operator'; note?: string; at: Date },
  ): Promise<boolean> {
    const rows = await this.db
      .insert(workspaceTrust)
      .values({
        workspaceId: scope.workspaceId,
        rampLiftedAt: input.at,
        rampLiftedBy: input.by,
        ...(input.note === undefined ? {} : { rampLiftedNote: input.note }),
      })
      .onConflictDoUpdate({
        target: workspaceTrust.workspaceId,
        set: {
          rampLiftedAt: input.at,
          rampLiftedBy: input.by,
          ...(input.note === undefined ? {} : { rampLiftedNote: input.note }),
          updatedAt: sql`now()`,
        },
        where: sql`${workspaceTrust.rampLiftedAt} is null`,
      })
      .returning({ workspaceId: workspaceTrust.workspaceId });

    return rows.length > 0;
  }

  /**
   * Extends the ramp past the age threshold.
   *
   * Also clears any existing lift, because "keep this one capped" said about
   * a workspace that was lifted last month has to actually cap it — leaving
   * the lift in place would make `isInRamp` return true from `rampUntil`
   * while the row still claimed the workspace was trusted, and the next
   * operator to read it would draw the wrong conclusion.
   */
  async extend(scope: WorkspaceScope, until: Date, note?: string): Promise<void> {
    await this.db
      .insert(workspaceTrust)
      .values({
        workspaceId: scope.workspaceId,
        rampUntil: until,
        ...(note === undefined ? {} : { rampLiftedNote: note }),
      })
      .onConflictDoUpdate({
        target: workspaceTrust.workspaceId,
        set: {
          rampUntil: until,
          rampLiftedAt: null,
          rampLiftedBy: null,
          ...(note === undefined ? {} : { rampLiftedNote: note }),
          updatedAt: sql`now()`,
        },
      });
  }

  /** Drops quota rows older than the given day. For the cleanup job. */
  async pruneQuota(scope: WorkspaceScope, before: string): Promise<number> {
    const rows = await this.db
      .delete(workspaceSendQuota)
      .where(
        and(
          eq(workspaceSendQuota.workspaceId, scope.workspaceId),
          sql`${workspaceSendQuota.day} < ${before}`,
        ),
      )
      .returning({ day: workspaceSendQuota.day });

    return rows.length;
  }
}
