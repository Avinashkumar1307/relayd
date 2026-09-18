import { projectEntitlements, entitlementsDiffer, type ActiveSubscription, type EntitlementRow } from './project.js';

/**
 * Rebuilding the entitlements projection.
 *
 * `entitlements` is derived from `subscriptions` x `plan_features`, so it can
 * always be thrown away and recomputed. That is not a nicety: it is the only
 * reason a bug in the webhook path is recoverable. Anything that cannot be
 * recomputed has to be right the first time, and nothing is right the first
 * time.
 *
 * The Phase 8 gate is "entitlements dropped and rebuilt with byte-identical
 * output", so the projection is deterministic and sorted and this file adds
 * nothing to it but ordering of the work: read the subscription, project,
 * compare, write only when the rows actually differ.
 *
 * The comparison is not an optimisation. Writing unconditionally rewrites
 * `computed_at` on every workspace on every nightly run, and a column that
 * changes every night cannot answer "when did this workspace's entitlements
 * last change" — which is the first question asked when a customer says they
 * lost a feature.
 */

export interface RebuildPort {
  /** The live subscription, including `unpaid`, or null. */
  activeSubscription(workspaceId: string): Promise<ActiveSubscription | null>;

  /** The rows as they stand, sorted by feature key. */
  readEntitlements(workspaceId: string): Promise<EntitlementRow[]>;

  /** Delete-then-insert, inside one transaction. */
  writeEntitlements(workspaceId: string, rows: readonly EntitlementRow[]): Promise<void>;

  /** Drops any cached copy. Called after a write, never instead of one. */
  invalidate(workspaceId: string): Promise<void>;
}

export interface RebuildResult {
  workspaceId: string;
  /** Rows the projection says the workspace should have. */
  projected: number;
  changed: boolean;
  /** Set when the workspace has no subscription granting anything. */
  revoked: boolean;
}

export async function rebuildEntitlements(
  workspaceId: string,
  port: RebuildPort,
): Promise<RebuildResult> {
  const subscription = await port.activeSubscription(workspaceId);
  const projected = projectEntitlements(subscription);
  const current = await port.readEntitlements(workspaceId);

  if (!entitlementsDiffer(current, projected)) {
    return {
      workspaceId,
      projected: projected.length,
      changed: false,
      revoked: projected.length === 0,
    };
  }

  await port.writeEntitlements(workspaceId, projected);

  // After the write. A cache dropped before it is a cache repopulated from
  // the old rows by any read that arrives in the gap, which is the failure
  // that looks like the write never happened.
  await port.invalidate(workspaceId);

  return {
    workspaceId,
    projected: projected.length,
    changed: true,
    revoked: projected.length === 0,
  };
}

export interface RebuildAllResult {
  checked: number;
  changed: number;
  revoked: number;
  failed: { workspaceId: string; error: string }[];
}

/**
 * Rebuilds a batch, and does not stop at the first failure.
 *
 * One workspace whose plan was deleted from the catalogue must not prevent
 * the other four thousand from being corrected. The failures come back named,
 * so the job can report them rather than the count being quietly short.
 */
export async function rebuildMany(
  workspaceIds: readonly string[],
  port: RebuildPort,
): Promise<RebuildAllResult> {
  const result: RebuildAllResult = { checked: 0, changed: 0, revoked: 0, failed: [] };

  for (const workspaceId of workspaceIds) {
    try {
      const one = await rebuildEntitlements(workspaceId, port);
      result.checked += 1;
      if (one.changed) result.changed += 1;
      if (one.revoked) result.revoked += 1;
    } catch (error) {
      result.failed.push({
        workspaceId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return result;
}
