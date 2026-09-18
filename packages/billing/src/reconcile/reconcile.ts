import { grantsEntitlements } from '../entitlements/project.js';
import type { BillingProviderAdapter, ProviderSubscription } from '../port.js';

/**
 * Nightly reconciliation against the provider (INVARIANTS R19, review
 * finding F19).
 *
 * The webhook path is convergent and still not sufficient. Stripe retries a
 * failed delivery for about three days and then gives up; an endpoint
 * disabled for a weekend, a deploy that 500s for an hour, a signing secret
 * rotated without updating ours — each loses events permanently, and every one
 * of them is a subscription whose local status is wrong in a way nothing will
 * ever notice.
 *
 * So once a night: list what the provider changed in the last 48 hours,
 * compare it with what we hold, correct what is unambiguous, and count what
 * is not. Forty-eight rather than twenty-four so a job that fails once does
 * not open a gap, and because "modified recently" is the provider's clock
 * rather than ours.
 *
 * ## What gets corrected and what does not
 *
 * **Corrected:** a field whose provider value is simply newer than ours.
 * Status, period dates, cancel-at-period-end, the plan behind the price. The
 * provider owns every one of these and our copy is a mirror, so there is no
 * judgement in overwriting it.
 *
 * **Counted, never corrected:** a subscription the provider has and we do not.
 * That is either a customer created outside our checkout or a mapping we lost,
 * and inventing a local row for it means guessing which workspace it belongs
 * to. Guessing wrong attaches somebody else's card to a workspace, so it is
 * reported and left alone.
 *
 * Divergence is emitted as a metric whether or not it was corrected, because
 * a reconciler that silently fixes things every night is a reconciler nobody
 * knows is load-bearing.
 */

/** How far back to ask the provider for changes. */
export const RECONCILE_WINDOW_HOURS = 48;

export type DivergenceKind =
  | 'status'
  | 'plan'
  | 'period'
  | 'cancel_at_period_end'
  | 'missing_locally'
  | 'missing_remotely';

export interface Divergence {
  providerSubscriptionId: string;
  workspaceId: string | null;
  kind: DivergenceKind;
  local: string | null;
  remote: string | null;
  corrected: boolean;
}

export interface LocalSubscription {
  id: string;
  workspaceId: string;
  providerSubscriptionId: string;
  planCode: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  providerStateVersion: number;
}

/**
 * Everything that differs between one local row and the provider's copy.
 *
 * Returns all of them rather than the first: a subscription whose status and
 * plan both drifted is one event in Stripe and two corrections here, and
 * reporting one would leave the other to be found by a customer.
 */
export function compareSubscription(
  local: LocalSubscription,
  remote: ProviderSubscription,
  planForPrice: (priceId: string) => string | null,
): Divergence[] {
  const out: Divergence[] = [];

  const base = {
    providerSubscriptionId: remote.id,
    workspaceId: local.workspaceId,
    corrected: false,
  };

  if (local.status !== remote.status) {
    out.push({ ...base, kind: 'status', local: local.status, remote: remote.status });
  }

  const remotePlan = planFor(remote, planForPrice);
  if (remotePlan !== null && remotePlan !== local.planCode) {
    out.push({ ...base, kind: 'plan', local: local.planCode, remote: remotePlan });
  }

  if (
    local.currentPeriodStart.getTime() !== remote.currentPeriodStart.getTime() ||
    local.currentPeriodEnd.getTime() !== remote.currentPeriodEnd.getTime()
  ) {
    out.push({
      ...base,
      kind: 'period',
      local: `${local.currentPeriodStart.toISOString()}..${local.currentPeriodEnd.toISOString()}`,
      remote: `${remote.currentPeriodStart.toISOString()}..${remote.currentPeriodEnd.toISOString()}`,
    });
  }

  if (local.cancelAtPeriodEnd !== remote.cancelAtPeriodEnd) {
    out.push({
      ...base,
      kind: 'cancel_at_period_end',
      local: String(local.cancelAtPeriodEnd),
      remote: String(remote.cancelAtPeriodEnd),
    });
  }

  return out;
}

/**
 * The plan a remote subscription is on.
 *
 * Null when no price maps to a plan we know — a price created by hand in the
 * Stripe dashboard, most often. Correcting to null would wipe the customer's
 * plan, so the caller treats it as "leave the plan alone" rather than as an
 * answer.
 */
function planFor(
  remote: ProviderSubscription,
  planForPrice: (priceId: string) => string | null,
): string | null {
  for (const priceId of remote.priceIds) {
    const plan = planForPrice(priceId);
    if (plan !== null) return plan;
  }
  return null;
}

/** Whether a divergence is safe to correct without a human. */
export function isAutoCorrectable(kind: DivergenceKind): boolean {
  // The provider owns all four of these; our copy is a mirror, and
  // overwriting a mirror involves no judgement.
  return (
    kind === 'status' || kind === 'plan' || kind === 'period' || kind === 'cancel_at_period_end'
  );
}

export interface ReconcilePort {
  /** Local rows for the provider ids we just listed. */
  findByProviderIds(ids: readonly string[]): Promise<LocalSubscription[]>;

  /** Overwrites the mirrored fields and bumps `provider_state_version`. */
  applyRemote(input: {
    subscriptionId: string;
    workspaceId: string;
    planCode: string | null;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    stateVersion: number;
  }): Promise<boolean>;

  /** Entitlements follow the plan and the status, so a correction rebuilds them. */
  rebuildEntitlements(workspaceId: string): Promise<void>;

  /** The plan a Stripe price belongs to, or null if we do not know it. */
  planForPrice(priceId: string): string | null;

  startRun(startedAt: Date): Promise<string>;

  finishRun(input: {
    runId: string;
    finishedAt: Date;
    objectsChecked: number;
    divergencesFound: number;
    divergencesCorrected: number;
    detail: unknown;
    error?: string;
  }): Promise<void>;

  /** R19's metric. Emitted for every divergence, corrected or not. */
  emitDivergence(divergence: Divergence): void;
}

export interface ReconcileResult {
  runId: string;
  objectsChecked: number;
  divergences: Divergence[];
  corrected: number;
  missingLocally: number;
}

export function reconcileSince(now: Date, windowHours = RECONCILE_WINDOW_HOURS): Date {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : RECONCILE_WINDOW_HOURS;
  return new Date(now.getTime() - hours * 3_600_000);
}

export async function reconcileBilling(
  input: { now: Date; windowHours?: number },
  port: ReconcilePort,
  provider: BillingProviderAdapter,
): Promise<ReconcileResult> {
  const runId = await port.startRun(input.now);
  const since = reconcileSince(input.now, input.windowHours ?? RECONCILE_WINDOW_HOURS);

  const result: ReconcileResult = {
    runId,
    objectsChecked: 0,
    divergences: [],
    corrected: 0,
    missingLocally: 0,
  };

  let remote: ProviderSubscription[];
  try {
    remote = await provider.listRecentlyChangedSubscriptions(since);
  } catch (error) {
    // The run is recorded as failed rather than silently absent. A
    // reconciler whose failures leave no trace is a reconciler that has been
    // broken for a month.
    await port.finishRun({
      runId,
      finishedAt: input.now,
      objectsChecked: 0,
      divergencesFound: 0,
      divergencesCorrected: 0,
      detail: [],
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }

  const locals = new Map(
    (await port.findByProviderIds(remote.map((row) => row.id))).map((row) => [
      row.providerSubscriptionId,
      row,
    ]),
  );

  for (const row of remote) {
    result.objectsChecked += 1;

    const local = locals.get(row.id);

    if (local === undefined) {
      // Counted, never invented. Guessing which workspace this belongs to
      // attaches somebody else's card to it.
      const divergence: Divergence = {
        providerSubscriptionId: row.id,
        workspaceId: null,
        kind: 'missing_locally',
        local: null,
        remote: row.status,
        corrected: false,
      };

      result.divergences.push(divergence);
      result.missingLocally += 1;
      port.emitDivergence(divergence);
      continue;
    }

    const differences = compareSubscription(local, row, port.planForPrice);
    if (differences.length === 0) continue;

    // One write for the whole row, not one per field: they came from a single
    // remote object and applying them separately would leave the row in a
    // state the provider never had.
    const applied = await port.applyRemote({
      subscriptionId: local.id,
      workspaceId: local.workspaceId,
      planCode: planFor(row, port.planForPrice),
      status: row.status,
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      stateVersion: row.stateVersion,
    });

    let rebuilt = false;

    for (const difference of differences) {
      const corrected = applied && isAutoCorrectable(difference.kind);
      const recorded = { ...difference, corrected };

      result.divergences.push(recorded);
      if (corrected) result.corrected += 1;
      port.emitDivergence(recorded);

      // A plan or a status change moves what the workspace may do, so the
      // projection has to follow. Once per subscription, not once per field.
      if (
        applied &&
        !rebuilt &&
        (difference.kind === 'plan' || difference.kind === 'status')
      ) {
        rebuilt = true;
      }
    }

    if (rebuilt) await port.rebuildEntitlements(local.workspaceId);
  }

  await port.finishRun({
    runId,
    finishedAt: input.now,
    objectsChecked: result.objectsChecked,
    divergencesFound: result.divergences.length,
    divergencesCorrected: result.corrected,
    detail: result.divergences,
  });

  return result;
}

/**
 * Whether a status change should revoke entitlements.
 *
 * Used by the caller that decides whether a correction needs to take effect
 * immediately rather than at the next rebuild. Exported because the same
 * question is asked by the webhook path, and two copies of it would drift.
 */
export function revokesEntitlements(input: { from: string; to: string }): boolean {
  return grantsEntitlements(input.from) && !grantsEntitlements(input.to);
}
