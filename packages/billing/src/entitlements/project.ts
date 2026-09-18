import {
  FEATURE_DEFINITIONS,
  flagFor,
  limitFor,
  planByCode,
  type FeatureKey,
  type PlanDefinition,
} from '../plans/catalogue.js';

/**
 * The entitlements projection.
 *
 * `entitlements` is subscriptions × plan_features, flattened. Nothing in the
 * product reads a plan code to make a decision — it reads this table — and
 * that is what lets a plan change take effect everywhere at once instead of
 * in however many places somebody remembered to check.
 *
 * Rebuildable is the property that matters. The gate criterion is that
 * entitlements can be dropped and rebuilt with byte-identical output, so this
 * is a pure function of a subscription and the catalogue: no clocks, no
 * counters, no reading of what was there before. A projection that consulted
 * its own previous output would drift, and the drift would be invisible
 * because the table is only ever read, never compared.
 *
 * A workspace with no active subscription gets no rows. Not zeroed rows — no
 * rows — because "this workspace has no entitlement to send" and "this
 * workspace is entitled to send zero" would be indistinguishable, and the
 * first is recoverable by subscribing while the second looks like a plan.
 */

export interface EntitlementRow {
  workspaceId: string;
  featureKey: FeatureKey;
  /** Null is unlimited. Absent from the row set entirely means no entitlement. */
  limitValue: number | null;
  flagValue: boolean | null;
  sourceSubscriptionId: string | null;
  sourcePlanCode: string | null;
}

export interface ActiveSubscription {
  id: string;
  workspaceId: string;
  planCode: string;
  status: string;
}

/**
 * Subscription statuses that grant entitlements.
 *
 * `past_due` grants them deliberately: a customer whose card failed this
 * morning has not stopped being a customer, and cutting them off at the first
 * failed charge is how a payment blip becomes a churn event. The dunning
 * ladder restricts them later and on purpose.
 *
 * `unpaid` does not. By then the retries are exhausted and restriction is the
 * intended state.
 */
export const ENTITLING_STATUSES: readonly string[] = ['trialing', 'active', 'past_due'];

export function grantsEntitlements(status: string): boolean {
  return ENTITLING_STATUSES.includes(status);
}

/**
 * The rows one workspace should have.
 *
 * Deterministic and sorted, so two rebuilds produce identical output and a
 * diff between them means something.
 */
export function projectEntitlements(
  subscription: ActiveSubscription | null,
  /**
   * The plan to project against, when it is not the subscription's own.
   *
   * Used by the plan-change dry run — "what would this workspace be entitled
   * to on Growth" — and by tests that need a plan the catalogue does not
   * contain. Defaults to the subscription's plan, so the ordinary call is
   * unchanged.
   */
  planOverride?: PlanDefinition,
): EntitlementRow[] {
  if (subscription === null || !grantsEntitlements(subscription.status)) return [];

  const plan = planOverride ?? planByCode(subscription.planCode);
  if (plan === null) return [];

  const rows: EntitlementRow[] = [];

  for (const feature of FEATURE_DEFINITIONS) {
    const row = rowFor(subscription, plan, feature.key, feature.kind);
    if (row !== null) rows.push(row);
  }

  // Sorted by key. The gate asks for byte-identical rebuilds, and object
  // iteration order is not a guarantee worth resting that on.
  return rows.sort((a, b) => a.featureKey.localeCompare(b.featureKey));
}

function rowFor(
  subscription: ActiveSubscription,
  plan: PlanDefinition,
  key: FeatureKey,
  kind: 'limit' | 'flag' | 'metered',
): EntitlementRow | null {
  const base = {
    workspaceId: subscription.workspaceId,
    featureKey: key,
    sourceSubscriptionId: subscription.id,
    sourcePlanCode: plan.code,
  };

  if (kind === 'flag') {
    const value = flagFor(plan, key);
    // A plan that says nothing about a flag grants no row, which the gate
    // reads as "not entitled". Writing `false` would be the same answer with
    // more rows, but it would also hide a plan that forgot to mention a
    // feature — and those should be visible.
    return value === undefined ? null : { ...base, limitValue: null, flagValue: value };
  }

  const value = limitFor(plan, key);
  if (value === undefined) return null;

  return { ...base, limitValue: value, flagValue: null };
}

/**
 * Whether a set of rows differs from what the projection says it should be.
 *
 * Used by the reconciler and by the rebuild command's dry run. Compares the
 * fields that decide behaviour and ignores `computed_at`, which differs on
 * every rebuild by definition and would make every comparison a difference.
 */
export function entitlementsDiffer(
  actual: readonly EntitlementRow[],
  expected: readonly EntitlementRow[],
): boolean {
  if (actual.length !== expected.length) return true;

  // Length-prefixed rather than delimiter-joined, for the same reason as the
  // event dedupe key: a feature key and a value that run together are two
  // different rows comparing equal, and here that would report a real
  // divergence as agreement.
  const key = (row: EntitlementRow) =>
    [row.featureKey, String(row.limitValue), String(row.flagValue)]
      .map((field) => `${field.length}:${field}`)
      .join('');

  const left = [...actual].map(key).sort();
  const right = [...expected].map(key).sort();

  return left.some((value, index) => value !== right[index]);
}

/**
 * Features a workspace would exceed by moving to a plan.
 *
 * The downgrade pre-check. docs/05 wants a `422 plan_downgrade_blocked`
 * listing what is over the limit, because "you cannot downgrade" with no
 * explanation is a support ticket, and the customer usually can downgrade
 * once they know they need to delete four hundred contacts first.
 */
export function overLimitOnPlan(input: {
  targetPlanCode: string;
  currentUsage: Partial<Record<FeatureKey, number>>;
}): { featureKey: FeatureKey; used: number; limit: number }[] {
  const plan = planByCode(input.targetPlanCode);
  if (plan === null) return [];

  const over: { featureKey: FeatureKey; used: number; limit: number }[] = [];

  for (const feature of FEATURE_DEFINITIONS) {
    // Metered features are not a blocker: they bill or they stop, and either
    // way the customer is not holding data they would have to delete.
    if (feature.kind === 'metered') continue;

    const used = input.currentUsage[feature.key];
    if (used === undefined) continue;

    // A flag needs no separate check: flags live in `plan.flags`, so
    // `limitFor` returns `undefined` for one and the next line skips it. An
    // explicit `kind === 'flag'` guard here changed nothing, which is how a
    // reader comes to believe a dead branch is doing something.
    const limit = limitFor(plan, feature.key);
    // Unlimited, or unmentioned. Neither blocks.
    if (limit === undefined || limit === null) continue;

    if (used > limit) over.push({ featureKey: feature.key, used, limit });
  }

  return over;
}
