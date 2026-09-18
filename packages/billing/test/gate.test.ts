import { describe, expect, it } from 'vitest';
import {
  canUseFeature,
  checkUsage,
  statusForDenial,
  type Grant,
  type WorkspaceBillingState,
} from '../src/entitlements/gate.js';
import { FEATURES } from '../src/plans/catalogue.js';

/**
 * The entitlement gate (INVARIANTS R28; CLAUDE.md section 10).
 *
 * The property that matters most is the one that reads like an omission: a
 * workspace with no entitlement rows is denied, not waved through. Phase 6
 * shipped the opposite as a deliberate stub — a null entitlement meant no
 * limit — and left it correct only for as long as billing did not exist.
 */

function state(over: Partial<WorkspaceBillingState> = {}): WorkspaceBillingState {
  return {
    workspaceSuspended: false,
    subscriptionSuspended: false,
    pastDue: false,
    hasSubscription: true,
    ...over,
  };
}

function grant(over: Partial<Grant> = {}): Grant {
  return {
    featureKey: FEATURES.emailsSent,
    limitValue: 10_000,
    flagValue: null,
    ...over,
  };
}

describe('no subscription', () => {
  it('is denied', async () => {
    // D7: no free tier. This is the line that replaces the Phase 6 stub.
    const decision = canUseFeature(FEATURES.emailsSent, [], state({ hasSubscription: false }));

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('no_subscription');
  });

  it('is denied even holding entitlement rows', async () => {
    // Stale rows from a cancelled subscription are visible by design, so the
    // rows alone cannot be the authority on whether a subscription exists.
    const decision = canUseFeature(
      FEATURES.emailsSent,
      [grant()],
      state({ hasSubscription: false }),
    );

    expect(decision.allowed === false && decision.code).toBe('no_subscription');
  });

  it('is denied for a usage check too', () => {
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 0, requested: 1 },
      [grant()],
      state({ hasSubscription: false }),
    );

    expect(decision.allowed).toBe(false);
  });
});

describe('features the plan does not have', () => {
  it('are denied when absent from the rows', () => {
    const decision = canUseFeature(FEATURES.sendingPools, [grant()], state());

    expect(decision.allowed === false && decision.code).toBe('feature_not_in_plan');
  });

  it('are denied when present and switched off', () => {
    const decision = canUseFeature(
      FEATURES.sendingPools,
      [grant({ featureKey: FEATURES.sendingPools, limitValue: null, flagValue: false })],
      state(),
    );

    expect(decision.allowed === false && decision.code).toBe('feature_not_in_plan');
  });

  it('are allowed when present and on', () => {
    const decision = canUseFeature(
      FEATURES.sendingPools,
      [grant({ featureKey: FEATURES.sendingPools, limitValue: null, flagValue: true })],
      state(),
    );

    expect(decision.allowed).toBe(true);
  });

  it('name the feature in the denial', () => {
    // So the frontend can say which one, rather than "upgrade".
    const decision = canUseFeature(FEATURES.apiAccess, [], state());

    expect(decision.allowed === false && decision.featureKey).toBe(FEATURES.apiAccess);
  });
});

describe('limits', () => {
  it('allow what fits', () => {
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 1_000, requested: 500 },
      [grant({ limitValue: 10_000 })],
      state(),
    );

    expect(decision.allowed).toBe(true);
  });

  it('allow exactly the remainder', () => {
    // Off by one here is a customer who paid for 10,000 sends and got 9,999.
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 9_000, requested: 1_000 },
      [grant({ limitValue: 10_000 })],
      state(),
    );

    expect(decision.allowed).toBe(true);
  });

  it('refuse one more than the remainder', () => {
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 9_000, requested: 1_001 },
      [grant({ limitValue: 10_000 })],
      state(),
    );

    expect(decision.allowed === false && decision.code).toBe('limit_reached');
  });

  it('report the shortfall', () => {
    // docs/05 wants the number, because "upgrade" without it is a support
    // ticket and the customer usually can act once they know the size of it.
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 9_000, requested: 2_000 },
      [grant({ limitValue: 10_000 })],
      state(),
    );

    expect(decision.allowed === false && decision.shortfall).toBe(1_000);
  });

  it('never report a negative remainder', () => {
    // Already over — from an upgrade that lapsed, or a correction. The
    // message must not read "-400 remain".
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 10_400, requested: 1 },
      [grant({ limitValue: 10_000 })],
      state(),
    );

    expect(decision.allowed === false && decision.message).toContain('0 remain');
    expect(decision.allowed === false && decision.shortfall).toBe(1);
  });

  it('treat null as unlimited', () => {
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 50_000_000, requested: 1_000_000 },
      [grant({ limitValue: null })],
      state(),
    );

    expect(decision.allowed).toBe(true);
  });

  it('treat zero as a real limit', () => {
    // Unlimited is null. Zero is a plan that includes none of this, and
    // collapsing the two turns an unlimited plan into a blocked one or the
    // reverse.
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 0, requested: 1 },
      [grant({ limitValue: 0 })],
      state(),
    );

    expect(decision.allowed).toBe(false);
  });

  it('default a request to one', () => {
    const decision = checkUsage(
      FEATURES.contactsStored,
      { used: 500 },
      [grant({ featureKey: FEATURES.contactsStored, limitValue: 500 })],
      state(),
    );

    expect(decision.allowed).toBe(false);
  });

  it('allow a request of nothing', () => {
    // An empty import should not 402.
    const decision = checkUsage(
      FEATURES.contactsStored,
      { used: 500, requested: 0 },
      [grant({ featureKey: FEATURES.contactsStored, limitValue: 500 })],
      state(),
    );

    expect(decision.allowed).toBe(true);
  });
});

describe('workspace state', () => {
  it('suspends everything for a suspended workspace', () => {
    const decision = canUseFeature(
      FEATURES.emailsSent,
      [grant()],
      state({ workspaceSuspended: true }),
    );

    expect(decision.allowed === false && decision.code).toBe('workspace_suspended');
  });

  it('says suspended rather than out of quota', () => {
    // Both are true. Only one is worth reading.
    const decision = checkUsage(
      FEATURES.emailsSent,
      { used: 99_999, requested: 100_000 },
      [grant({ limitValue: 10 })],
      state({ workspaceSuspended: true }),
    );

    expect(decision.allowed === false && decision.code).toBe('workspace_suspended');
  });

  it('refuses a suspended subscription', () => {
    const decision = canUseFeature(
      FEATURES.emailsSent,
      [grant()],
      state({ subscriptionSuspended: true }),
    );

    expect(decision.allowed === false && decision.code).toBe('subscription_suspended');
  });

  it('refuses sending while past due', () => {
    const decision = canUseFeature(FEATURES.emailsSent, [grant()], state({ pastDue: true }));

    expect(decision.allowed === false && decision.code).toBe('subscription_past_due');
  });

  it('still allows everything else while past due', () => {
    // A card that failed this morning is not a reason to take somebody's data
    // hostage. The dunning ladder restricts later, on purpose.
    const decision = canUseFeature(
      FEATURES.contactsStored,
      [grant({ featureKey: FEATURES.contactsStored, limitValue: 1_000 })],
      state({ pastDue: true }),
    );

    expect(decision.allowed).toBe(true);
  });

  it('puts a workspace suspension ahead of a missing subscription', () => {
    const decision = canUseFeature(
      FEATURES.emailsSent,
      [],
      state({ workspaceSuspended: true, hasSubscription: false }),
    );

    expect(decision.allowed === false && decision.code).toBe('workspace_suspended');
  });
});

describe('the status a denial carries', () => {
  it('is 402 for anything money fixes', () => {
    // The frontend renders an upgrade prompt for these.
    for (const code of [
      'no_subscription',
      'feature_not_in_plan',
      'limit_reached',
      'subscription_past_due',
      'subscription_suspended',
    ] as const) {
      expect(statusForDenial(code)).toBe(402);
    }
  });

  it('is 403 for a suspension money does not fix', () => {
    expect(statusForDenial('workspace_suspended')).toBe(403);
  });
});
