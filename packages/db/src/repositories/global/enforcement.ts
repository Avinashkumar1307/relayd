import { sql } from 'drizzle-orm';
import { workspaceEnforcement } from '../../schema/abuse.js';
import type { Executor } from '../executor.js';

/**
 * Workspaces under enforcement, across every tenant (docs/06 "Anti-abuse").
 *
 * Cross-tenant by nature, so it lives here rather than taking a
 * `WorkspaceScope` (CLAUDE.md section 6.2). It runs under `relayd_global`
 * from an allowlisted job type — the enforcement sweep — and nothing else
 * may call it.
 */
export class GlobalEnforcementRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Every workspace already under enforcement, oldest stage-entry first.
   *
   * Only the non-clean ones, which is what the partial index on
   * `stage <> 'none'` is for. A sweep over every workspace would read the
   * whole table nightly to discover that almost all of them are fine; the
   * ones not yet flagged are found by the metrics query instead, which is
   * bounded by who actually sent in the window.
   *
   * Ordered by `entered_at` so the workspaces closest to their recovery
   * deadline are handled first when the limit bites — the alternative
   * starves exactly the ones waiting to be released.
   */
  async underEnforcement(limit = 500): Promise<
    { workspaceId: string; stage: string; enteredAt: Date; heldByOperator: boolean }[]
  > {
    return this.db
      .select({
        workspaceId: workspaceEnforcement.workspaceId,
        stage: workspaceEnforcement.stage,
        enteredAt: workspaceEnforcement.enteredAt,
        heldByOperator: workspaceEnforcement.heldByOperator,
      })
      .from(workspaceEnforcement)
      .where(sql`${workspaceEnforcement.stage} <> 'none'`)
      .orderBy(workspaceEnforcement.enteredAt)
      .limit(limit);
  }
}
