import { FEATURES, type FeatureKey } from '../plans/catalogue.js';

/**
 * The entitlement gate (CLAUDE.md section 10, docs/05, INVARIANTS R28).
 *
 * Two questions, asked everywhere, and no plan code in the answer to either:
 * *may this workspace do this at all* (a flag), and *has it got room* (a
 * limit). Both are answered from `entitlements` and `usage_aggregates`, never
 * from a plan name — which is what lets a plan change take effect everywhere
 * at once instead of everywhere a plan name was spelled.
 *
 * The decisions are pure. They take the rows and return a verdict, so the
 * transaction that reads `FOR SHARE` and the read-only pre-check the API
 * offers can run identical logic and cannot drift apart.
 *
 * ## No rows is a denial
 *
 * A workspace with no entitlement rows has no active subscription, and under
 * D7 there is no free tier. So absent rows deny. This replaces the Phase 6
 * stub, where a null entitlement meant "no limit enforced" — correct while
 * billing did not exist, and a way to send unlimited email for free once it
 * did.
 *
 * ## Why the check is inside the transaction
 *
 * A limit read before a snapshot is a limit that may have changed by the time
 * the snapshot is written. R28's answer is `FOR SHARE` on the entitlement row
 * inside the launch transaction: a downgrade committing concurrently blocks
 * until the launch ends, so the number the launch checked is the number that
 * was true when it committed.
 */

export type DenialCode =
  | 'no_subscription'
  | 'feature_not_in_plan'
  | 'limit_reached'
  | 'subscription_past_due'
  | 'subscription_suspended'
  | 'workspace_suspended';

export interface Grant {
  featureKey: FeatureKey;
  /** Null is unlimited. */
  limitValue: number | null;
  flagValue: boolean | null;
}

export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      code: DenialCode;
      featureKey?: FeatureKey;
      limit?: number;
      used?: number;
      requested?: number;
      shortfall?: number;
      message: string;
    };

/**
 * Workspace-level state that denies before any feature is consulted.
 *
 * Ordered deliberately: a suspended workspace is told it is suspended rather
 * than told it has run out of contacts, because the second is true and
 * useless.
 */
export interface WorkspaceBillingState {
  /** Suspended for abuse or non-payment. Nothing is permitted. */
  workspaceSuspended: boolean;
  /** The dunning ladder has passed `restricted`. Reads work; writes do not. */
  subscriptionSuspended: boolean;
  /** Card failed, inside the grace period. Most things still work. */
  pastDue: boolean;
  hasSubscription: boolean;
}

/** Actions that stay refused while a subscription is merely past due. */
const BLOCKED_WHILE_PAST_DUE: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  // Launching is the expensive one and the one a customer can be asked to
  // wait on. Everything else — editing, importing, reading — keeps working,
  // because a card that failed this morning is not a reason to take somebody
  // data hostage.
  FEATURES.emailsSent,
]);

function deny(
  code: DenialCode,
  message: string,
  extra: Omit<Extract<Decision, { allowed: false }>, 'allowed' | 'code' | 'message'> = {},
): Decision {
  return { allowed: false, code, message, ...extra };
}

/**
 * Whether the workspace may use a feature at all.
 *
 * `grants` is the entitlement row set. A feature absent from it is not in the
 * plan; a feature present with `flagValue === false` is in the plan and
 * switched off, which reads the same to a caller and is deliberately not
 * distinguished in the denial.
 */
export function canUseFeature(
  featureKey: FeatureKey,
  grants: readonly Grant[],
  state: WorkspaceBillingState,
): Decision {
  const blocked = blockedByState(featureKey, state);
  if (blocked !== null) return blocked;

  const grant = grants.find((row) => row.featureKey === featureKey);
  if (grant === undefined) {
    return deny('feature_not_in_plan', 'Your plan does not include this feature', { featureKey });
  }

  if (grant.flagValue === false) {
    return deny('feature_not_in_plan', 'Your plan does not include this feature', { featureKey });
  }

  return { allowed: true };
}

/**
 * Whether the workspace has room for `requested` more of a metered or
 * limited feature.
 *
 * `requested` defaults to one, because most callers are asking about a single
 * contact, seat or campaign. The launch path passes the snapshot count, and
 * passes it *after* the snapshot — an estimate taken before is an estimate.
 */
export function checkUsage(
  featureKey: FeatureKey,
  input: { used: number; requested?: number },
  grants: readonly Grant[],
  state: WorkspaceBillingState,
): Decision {
  const usable = canUseFeature(featureKey, grants, state);
  if (!usable.allowed) return usable;

  const grant = grants.find((row) => row.featureKey === featureKey);
  // `canUseFeature` already refused an absent grant; this is for the type.
  if (grant === undefined || grant.limitValue === null) return { allowed: true };

  const requested = Math.max(0, Math.trunc(input.requested ?? 1));
  const used = Math.max(0, Math.trunc(input.used));
  const limit = Math.max(0, Math.trunc(grant.limitValue));
  const remaining = Math.max(0, limit - used);

  if (requested <= remaining) return { allowed: true };

  return deny('limit_reached', usageMessage(featureKey, remaining, requested), {
    featureKey,
    limit,
    used,
    requested,
    shortfall: requested - remaining,
  });
}

function usageMessage(featureKey: FeatureKey, remaining: number, requested: number): string {
  if (featureKey === FEATURES.emailsSent) {
    return `This needs ${requested.toLocaleString()} sends and ${remaining.toLocaleString()} remain on your plan this period`;
  }
  return `This needs ${requested.toLocaleString()} and ${remaining.toLocaleString()} remain on your plan`;
}

function blockedByState(featureKey: FeatureKey, state: WorkspaceBillingState): Decision | null {
  if (state.workspaceSuspended) {
    return deny('workspace_suspended', 'This workspace is suspended');
  }

  if (!state.hasSubscription) {
    // D7: no free tier. No subscription is no entitlement, and saying so is
    // more useful than naming whichever feature was asked about.
    return deny('no_subscription', 'This workspace has no active subscription');
  }

  if (state.subscriptionSuspended) {
    return deny('subscription_suspended', 'Your subscription is suspended for non-payment');
  }

  if (state.pastDue && BLOCKED_WHILE_PAST_DUE.has(featureKey)) {
    return deny('subscription_past_due', 'Your payment is overdue. Update your card to continue sending', {
      featureKey,
    });
  }

  return null;
}

/**
 * The HTTP status a denial should carry.
 *
 * `402` for anything the customer fixes with money and `403` for anything
 * they cannot — the difference between "upgrade" and "contact us", which the
 * frontend renders very differently.
 */
export function statusForDenial(code: DenialCode): 402 | 403 {
  return code === 'workspace_suspended' ? 403 : 402;
}
