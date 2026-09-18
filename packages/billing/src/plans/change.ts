import { isDowngrade, isUpgrade, planByCode, type FeatureKey } from './catalogue.js';
import { overLimitOnPlan } from '../entitlements/project.js';
import type { BillingProviderAdapter } from '../port.js';

/**
 * Changing plan (docs/05 "Plan changes").
 *
 * The asymmetry is the design, and it is not arbitrary:
 *
 *   **An upgrade applies immediately, prorated.** The customer paid for more
 *   capacity and expects it now. Anything else means taking money for
 *   headroom that arrives next month.
 *
 *   **A downgrade applies at period end, with no credit.** This avoids refund
 *   complexity, and more importantly avoids taking a capability away in the
 *   middle of a campaign that is relying on it. The customer keeps what they
 *   paid for until the period they paid for ends.
 *
 * Both modify the existing subscription. Never a second one: two live
 * subscriptions for one workspace bills twice, `uq_sub_active_ws` refuses it,
 * and by the time either is noticed the customer has been charged twice.
 *
 * ## The pre-check is mandatory
 *
 * A downgrade whose target limits sit below current usage is refused with
 * `422 plan_downgrade_blocked` and the specific offending features, so the UI
 * can say what to delete or archive. Accepting the money and then restricting
 * the account is the alternative, and it is much worse: the customer has paid
 * for a plan that does not work and has to be talked through why.
 */

export type ChangeDirection = 'upgrade' | 'downgrade' | 'interval_only' | 'none';

export interface PlanChangeEffect {
  appliesAt: 'immediately' | 'period_end';
  prorate: boolean;
  /** When the entitlement rows should reflect the new plan. */
  entitlementsAt: 'immediately' | 'period_end';
  /** Whether the pre-check has to pass first. */
  requiresPrecheck: boolean;
}

export type Interval = 'month' | 'year';

/**
 * What kind of change this is.
 *
 * Rank, never price. A promotion that makes a higher plan temporarily cheaper
 * would otherwise turn every upgrade into a downgrade for the duration of the
 * sale — which is the first week the pricing page runs a discount.
 *
 * A move to a longer interval on the same plan is an upgrade in commitment:
 * the customer is paying more up front and Stripe credits the unused
 * remainder, so it applies immediately like any other upgrade. The reverse,
 * annual to monthly, is a downgrade in commitment and waits — otherwise the
 * customer has already paid for a year and we quietly stop honouring it.
 */
export function classifyChange(input: {
  fromPlanCode: string;
  toPlanCode: string;
  fromInterval: Interval;
  toInterval: Interval;
}): ChangeDirection {
  if (isUpgrade(input.fromPlanCode, input.toPlanCode)) return 'upgrade';
  if (isDowngrade(input.fromPlanCode, input.toPlanCode)) return 'downgrade';

  if (input.fromInterval === input.toInterval) return 'none';
  return 'interval_only';
}

export function planChangeEffect(
  direction: ChangeDirection,
  intervals: { fromInterval: Interval; toInterval: Interval } = {
    fromInterval: 'month',
    toInterval: 'month',
  },
): PlanChangeEffect {
  if (direction === 'upgrade') {
    return {
      appliesAt: 'immediately',
      prorate: true,
      entitlementsAt: 'immediately',
      requiresPrecheck: false,
    };
  }

  if (direction === 'downgrade') {
    return {
      appliesAt: 'period_end',
      prorate: false,
      // Unchanged until the period rolls. Lowering them now would take away
      // capability the customer has already paid for.
      entitlementsAt: 'period_end',
      requiresPrecheck: true,
    };
  }

  if (direction === 'interval_only') {
    const lengthening = intervals.fromInterval === 'month' && intervals.toInterval === 'year';

    return {
      appliesAt: lengthening ? 'immediately' : 'period_end',
      prorate: lengthening,
      // The plan has not changed, so neither have the entitlements. Saying
      // `immediately` here would trigger a rebuild that writes identical rows
      // and moves `computed_at` for nothing.
      entitlementsAt: 'immediately',
      requiresPrecheck: false,
    };
  }

  return {
    appliesAt: 'immediately',
    prorate: false,
    entitlementsAt: 'immediately',
    requiresPrecheck: false,
  };
}

export interface DowngradeConflict {
  feature: FeatureKey;
  current: number;
  targetLimit: number;
}

export interface PrecheckResult {
  blocked: boolean;
  conflicts: DowngradeConflict[];
}

/**
 * The mandatory downgrade pre-check.
 *
 * Returns every conflict, not the first: telling a customer to delete four
 * hundred contacts and then telling them to remove three seats is two support
 * tickets where one message would have done.
 */
export function precheckDowngrade(input: {
  targetPlanCode: string;
  currentUsage: Partial<Record<FeatureKey, number>>;
}): PrecheckResult {
  const over = overLimitOnPlan(input);

  const conflicts = over.map((row) => ({
    feature: row.featureKey,
    current: row.used,
    targetLimit: row.limit,
  }));

  return { blocked: conflicts.length > 0, conflicts };
}

export type ChangeFailure =
  | 'unknown_plan'
  | 'plan_not_self_serve'
  | 'no_subscription'
  | 'no_price'
  | 'plan_downgrade_blocked'
  | 'provider_failed';

export interface ChangeResult {
  ok: boolean;
  direction?: ChangeDirection;
  appliesAt?: 'immediately' | 'period_end';
  effectiveAt?: Date;
  failure?: ChangeFailure;
  conflicts?: DowngradeConflict[];
  message?: string;
}

export interface PlanChangePort {
  currentSubscription(workspaceId: string): Promise<{
    id: string;
    providerSubscriptionId: string;
    planCode: string;
    interval: Interval;
    currentPeriodEnd: Date;
    status: string;
  } | null>;

  findPrice(input: { planCode: string; interval: Interval }): Promise<{
    id: string;
    providerPriceId: string;
  } | null>;

  /** Usage for every feature the pre-check compares. */
  currentUsage(workspaceId: string): Promise<Partial<Record<FeatureKey, number>>>;

  /** An immediate change: write the new plan and rebuild entitlements. */
  applyPlanNow(input: {
    subscriptionId: string;
    workspaceId: string;
    planCode: string;
  }): Promise<void>;

  /** A scheduled change: `scheduled_plan_code` + `scheduled_change_at`. */
  schedulePlanChange(input: {
    subscriptionId: string;
    workspaceId: string;
    planCode: string;
    effectiveAt: Date;
  }): Promise<void>;

  recordEvent(input: { workspaceId: string; eventType: string; detail: unknown }): Promise<void>;
}

export async function changePlan(
  input: {
    workspaceId: string;
    toPlanCode: string;
    toInterval: Interval;
    isSelfServe: (planCode: string) => boolean;
  },
  port: PlanChangePort,
  provider: BillingProviderAdapter,
): Promise<ChangeResult> {
  if (planByCode(input.toPlanCode) === null) {
    return { ok: false, failure: 'unknown_plan', message: 'No such plan' };
  }

  if (!input.isSelfServe(input.toPlanCode)) {
    return {
      ok: false,
      failure: 'plan_not_self_serve',
      message: 'That plan is not available for self-service changes',
    };
  }

  const subscription = await port.currentSubscription(input.workspaceId);
  if (subscription === null) {
    return {
      ok: false,
      failure: 'no_subscription',
      message: 'This workspace has no subscription to change',
    };
  }

  const direction = classifyChange({
    fromPlanCode: subscription.planCode,
    toPlanCode: input.toPlanCode,
    fromInterval: subscription.interval,
    toInterval: input.toInterval,
  });

  if (direction === 'none') {
    // Already on it. Not an error — a double-clicked button reaches here and
    // a 4xx for it would be a support ticket about a working system.
    return { ok: true, direction, appliesAt: 'immediately' };
  }

  const effect = planChangeEffect(direction, {
    fromInterval: subscription.interval,
    toInterval: input.toInterval,
  });

  if (effect.requiresPrecheck) {
    const precheck = precheckDowngrade({
      targetPlanCode: input.toPlanCode,
      currentUsage: await port.currentUsage(input.workspaceId),
    });

    if (precheck.blocked) {
      return {
        ok: false,
        failure: 'plan_downgrade_blocked',
        conflicts: precheck.conflicts,
        message: 'Current usage exceeds the target plan',
      };
    }
  }

  const price = await port.findPrice({
    planCode: input.toPlanCode,
    interval: input.toInterval,
  });

  if (price === null) {
    return { ok: false, failure: 'no_price', message: 'That plan has no price for this interval' };
  }

  try {
    // Modify, never create. A second subscription bills twice and is
    // discovered at renewal.
    await provider.updateSubscriptionPrice({
      providerSubscriptionId: subscription.providerSubscriptionId,
      priceId: price.providerPriceId,
      prorate: effect.prorate,
    });
  } catch {
    return {
      ok: false,
      failure: 'provider_failed',
      message: 'The payment provider could not apply the change',
    };
  }

  if (effect.appliesAt === 'immediately') {
    await port.applyPlanNow({
      subscriptionId: subscription.id,
      workspaceId: input.workspaceId,
      planCode: input.toPlanCode,
    });
  } else {
    await port.schedulePlanChange({
      subscriptionId: subscription.id,
      workspaceId: input.workspaceId,
      planCode: input.toPlanCode,
      effectiveAt: subscription.currentPeriodEnd,
    });
  }

  await port.recordEvent({
    workspaceId: input.workspaceId,
    eventType: direction === 'downgrade' ? 'plan.downgrade_scheduled' : 'plan.changed',
    detail: {
      from: subscription.planCode,
      to: input.toPlanCode,
      interval: input.toInterval,
      appliesAt: effect.appliesAt,
    },
  });

  return {
    ok: true,
    direction,
    appliesAt: effect.appliesAt,
    ...(effect.appliesAt === 'period_end' ? { effectiveAt: subscription.currentPeriodEnd } : {}),
  };
}

/**
 * Cancelling.
 *
 * At period end by default. Immediate cancellation exists and is deliberately
 * not the default: it ends a paid period early with no refund, which is a
 * decision the customer has to make explicitly rather than discover.
 */
export interface CancelResult {
  ok: boolean;
  endsAt?: Date;
  failure?: 'no_subscription' | 'provider_failed';
  message?: string;
}

export async function cancelSubscription(
  input: { workspaceId: string; immediately: boolean },
  port: PlanChangePort,
  provider: BillingProviderAdapter,
): Promise<CancelResult> {
  const subscription = await port.currentSubscription(input.workspaceId);
  if (subscription === null) {
    return { ok: false, failure: 'no_subscription', message: 'This workspace has no subscription' };
  }

  try {
    await provider.cancelSubscription({
      providerSubscriptionId: subscription.providerSubscriptionId,
      atPeriodEnd: !input.immediately,
    });
  } catch {
    return {
      ok: false,
      failure: 'provider_failed',
      message: 'The payment provider could not cancel the subscription',
    };
  }

  await port.recordEvent({
    workspaceId: input.workspaceId,
    eventType: input.immediately ? 'subscription.cancelled' : 'subscription.cancel_scheduled',
    detail: { planCode: subscription.planCode, immediately: input.immediately },
  });

  // The local row is not written here. `customer.subscription.updated` carries
  // the authoritative `cancel_at_period_end` and `ended_at`, and writing our
  // own guess would be a second source of truth for a number Stripe owns.
  return {
    ok: true,
    ...(input.immediately ? {} : { endsAt: subscription.currentPeriodEnd }),
  };
}
