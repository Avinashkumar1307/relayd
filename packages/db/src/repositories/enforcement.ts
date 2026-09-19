import { eq, sql } from 'drizzle-orm';
import { workspaceEnforcement } from '../schema/abuse.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Enforcement state (migration 0017; docs/06 "Anti-abuse").
 *
 * The ladder's policy is in `packages/campaigns/src/abuse/enforcement.ts` and
 * is pure. This is the I/O: read the state, read the metrics the rates are
 * computed from, write the decision.
 */

export type EnforcementStage =
  | 'none'
  | 'warned'
  | 'review_required'
  | 'paused'
  | 'suspended'
  | 'terminated';

export interface EnforcementRow {
  stage: EnforcementStage;
  reason: string | null;
  observedRate: number | null;
  observedSends: number | null;
  enteredAt: Date;
  heldByOperator: boolean;
  note: string | null;
}

export class EnforcementRepository {
  constructor(private readonly db: Executor) {}

  /**
   * The workspace's enforcement state, or the `none` default.
   *
   * Returns a row rather than null so every caller does not have to
   * re-derive what "no row" means. The one place that decision belongs is
   * here, next to the migration that says the same thing.
   */
  async read(scope: WorkspaceScope, now: Date): Promise<EnforcementRow> {
    const [row] = await this.db
      .select()
      .from(workspaceEnforcement)
      .where(eq(workspaceEnforcement.workspaceId, scope.workspaceId));

    // A workspace with no row has never been acted on, which is `none`.
    // Inlined rather than a shared helper: a free function in a repository
    // file reads as a repository method to the scope reflection test, and
    // to a person.
    if (row === undefined) {
      return {
        stage: 'none',
        reason: null,
        observedRate: null,
        observedSends: null,
        enteredAt: now,
        heldByOperator: false,
        note: null,
      };
    }

    return {
      stage: row.stage as EnforcementStage,
      reason: row.reason,
      observedRate: row.observedRate === null ? null : Number(row.observedRate),
      observedSends: row.observedSends,
      enteredAt: row.enteredAt,
      heldByOperator: row.heldByOperator,
      note: row.note,
    };
  }

  /**
   * Moves a workspace to a stage.
   *
   * `enteredAt` is reset on every change, including a step down, so the
   * recovery clock runs from the current stage rather than from whenever the
   * workspace first went wrong. A workspace released from `paused` to
   * `review_required` has to be clean for another full window before it goes
   * back to `warned`.
   *
   * The guard is `stage <> $newStage`: writing the same stage again would
   * reset the clock and a workspace could sit one tick short of release
   * forever, which is the kind of bug that only shows up as "why has this
   * customer been in review for three months".
   */
  async setStage(
    scope: WorkspaceScope,
    input: {
      stage: EnforcementStage;
      reason: string;
      observedRate?: number | null;
      observedSends?: number | null;
      note?: string | null;
      at: Date;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .insert(workspaceEnforcement)
      .values({
        workspaceId: scope.workspaceId,
        stage: input.stage,
        reason: input.reason,
        observedRate: input.observedRate === undefined ? null : String(input.observedRate),
        observedSends: input.observedSends ?? null,
        enteredAt: input.at,
        note: input.note ?? null,
      })
      .onConflictDoUpdate({
        target: workspaceEnforcement.workspaceId,
        set: {
          stage: input.stage,
          reason: input.reason,
          observedRate: input.observedRate === undefined ? null : String(input.observedRate),
          observedSends: input.observedSends ?? null,
          enteredAt: input.at,
          ...(input.note === undefined ? {} : { note: input.note }),
          updatedAt: sql`now()`,
        },
        where: sql`${workspaceEnforcement.stage} <> ${input.stage}`,
      })
      .returning({ workspaceId: workspaceEnforcement.workspaceId });

    return rows.length > 0;
  }

  /**
   * Sets or clears an operator's hold.
   *
   * Separate from `setStage` because it is a different decision by a
   * different actor, and bundling them would let a job that only meant to
   * change a stage clear somebody's hold as a side effect.
   */
  async setHold(scope: WorkspaceScope, held: boolean, note?: string | null): Promise<void> {
    await this.db
      .insert(workspaceEnforcement)
      .values({
        workspaceId: scope.workspaceId,
        heldByOperator: held,
        ...(note === undefined ? {} : { note }),
      })
      .onConflictDoUpdate({
        target: workspaceEnforcement.workspaceId,
        set: {
          heldByOperator: held,
          ...(note === undefined ? {} : { note }),
          updatedAt: sql`now()`,
        },
      });
  }
}
