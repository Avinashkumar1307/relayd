import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  PLANS,
  PLAN_DEFINITIONS,
  flagFor,
  isDowngrade,
  isUpgrade,
  limitFor,
  planByCode,
  selfServePlans,
  type PlanDefinition,
} from '../src/plans/catalogue.js';
import {
  ENTITLING_STATUSES,
  entitlementsDiffer,
  grantsEntitlements,
  overLimitOnPlan,
  projectEntitlements,
  type ActiveSubscription,
} from '../src/entitlements/project.js';

/**
 * Plans and the entitlements projection (INVARIANTS R28; docs/05).
 *
 * The gate criterion is that entitlements can be dropped and rebuilt with
 * byte-identical output, so the projection is a pure function and most of
 * what follows checks that it stays one.
 */

function subscription(over: Partial<ActiveSubscription> = {}): ActiveSubscription {
  return {
    id: 'sub-1',
    workspaceId: 'ws-1',
    planCode: PLANS.growth,
    status: 'active',
    ...over,
  };
}

describe('the plan catalogue', () => {
  it('orders plans by rank, not by price', () => {
    // A promotion that makes Growth temporarily cheaper than Starter would
    // otherwise turn an upgrade into a downgrade — which skips the
    // over-limit pre-check and strands a workspace above its new limits.
    expect(isUpgrade(PLANS.starter, PLANS.growth)).toBe(true);
    expect(isDowngrade(PLANS.growth, PLANS.starter)).toBe(true);
  });

  it('calls a move to the same plan neither', () => {
    expect(isUpgrade(PLANS.growth, PLANS.growth)).toBe(false);
    expect(isDowngrade(PLANS.growth, PLANS.growth)).toBe(false);
  });

  it('refuses to judge a plan it does not know', () => {
    expect(isUpgrade('mystery', PLANS.growth)).toBe(false);
    expect(isDowngrade(PLANS.growth, 'mystery')).toBe(false);
  });

  it('gives every plan a distinct rank', () => {
    const ranks = PLAN_DEFINITIONS.map((plan) => plan.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('keeps enterprise off the self-serve list', () => {
    // A plan-change endpoint that offered it would let anyone assign
    // themselves unlimited sending.
    expect(selfServePlans().map((plan) => plan.code)).not.toContain(PLANS.enterprise);
  });

  it('has no free tier (D7)', () => {
    expect(PLAN_DEFINITIONS.some((plan) => plan.code === ('free' as never))).toBe(false);
  });

  it('distinguishes unlimited from zero', () => {
    // `null` is unlimited, `0` is none, and a plan with no campaigns is not
    // a plan with unlimited campaigns.
    const business = planByCode(PLANS.business);
    expect(business?.limits[FEATURES.campaignsPerMonth]).toBeNull();

    const starter = planByCode(PLANS.starter);
    expect(starter?.limits[FEATURES.campaignsPerMonth]).toBe(20);
  });

  it('gives the entry plan no overage', () => {
    // A customer who has not chosen to spend more should not discover that
    // they have.
    const starter = planByCode(PLANS.starter);
    expect(starter?.overage[FEATURES.emailsSent]?.allowed).toBe(false);
  });

  it('caps overage on every plan that allows it', () => {
    // A runaway automation must not be able to generate a $40,000 invoice.
    for (const plan of PLAN_DEFINITIONS) {
      for (const [feature, rule] of Object.entries(plan.overage)) {
        if (!rule.allowed) continue;
        expect(rule.hardCapMultiple, `${plan.code}/${feature}`).toBeGreaterThan(0);
        expect(rule.hardCapMultiple, `${plan.code}/${feature}`).toBeLessThanOrEqual(10);
      }
    }
  });
});

/**
 * A plan that mentions almost nothing.
 *
 * Every plan in the real catalogue defines every feature, so the difference
 * between "absent", "unlimited" and "zero" never arises there — and a
 * projection that collapsed them would pass every test written against the
 * catalogue alone. This is the plan that tells them apart.
 */
const SPARSE: PlanDefinition = {
  code: PLANS.starter,
  name: 'Sparse',
  description: 'Mentions one limit and nothing else.',
  rank: 1,
  isPublic: false,
  trialDays: 0,
  limits: { [FEATURES.contactsStored]: 100 },
  flags: {},
  overage: {},
};

describe('absent, unlimited and zero are three different things', () => {
  it('reports an unmentioned limit as undefined', () => {
    expect(limitFor(SPARSE, FEATURES.campaignsPerMonth)).toBeUndefined();
  });

  it('reports an unlimited limit as null', () => {
    const business = planByCode(PLANS.business);
    expect(limitFor(business!, FEATURES.campaignsPerMonth)).toBeNull();
  });

  it('reports a real limit as a number', () => {
    expect(limitFor(SPARSE, FEATURES.contactsStored)).toBe(100);
  });

  it('reports an unmentioned flag as undefined, not false', () => {
    // `false` means "this plan does not include it" and `undefined` means
    // "this plan forgot to say". The second should be visible rather than
    // silently read as a denial.
    expect(flagFor(SPARSE, FEATURES.sendingPools)).toBeUndefined();
  });

  it('reports a defined flag as its boolean', () => {
    const starter = planByCode(PLANS.starter);
    expect(flagFor(starter!, FEATURES.sendingPools)).toBe(false);
  });
});

describe('projecting entitlements', () => {
  it('produces a row per feature the plan mentions', () => {
    const rows = projectEntitlements(subscription());
    expect(rows.length).toBeGreaterThan(5);
  });

  it('is deterministic', () => {
    // The gate asks for byte-identical rebuilds, and object iteration order
    // is not a guarantee worth resting that on.
    expect(JSON.stringify(projectEntitlements(subscription()))).toBe(
      JSON.stringify(projectEntitlements(subscription())),
    );
  });

  it('is sorted by feature key', () => {
    const keys = projectEntitlements(subscription()).map((row) => row.featureKey);
    expect(keys).toEqual([...keys].sort());
  });

  it('records which subscription and plan produced each row', () => {
    // So a rebuild can be checked, and a stale row from a cancelled
    // subscription is visible rather than merely wrong.
    const rows = projectEntitlements(subscription());

    for (const row of rows) {
      expect(row.sourceSubscriptionId).toBe('sub-1');
      expect(row.sourcePlanCode).toBe(PLANS.growth);
    }
  });

  it('carries unlimited through as null', () => {
    const rows = projectEntitlements(subscription({ planCode: PLANS.business }));
    const campaigns = rows.find((row) => row.featureKey === FEATURES.campaignsPerMonth);

    expect(campaigns?.limitValue).toBeNull();
  });

  it('carries a flag through as a boolean', () => {
    const rows = projectEntitlements(subscription());
    const pools = rows.find((row) => row.featureKey === FEATURES.sendingPools);

    expect(pools?.flagValue).toBe(true);
  });

  it('writes no row for a feature the plan never mentions', () => {
    // A missing row reads as "not entitled", which is the right answer — and
    // writing a zero or a false row instead would give the same answer while
    // hiding a plan that forgot to mention the feature at all.
    const rows = projectEntitlements(
      { id: 's', workspaceId: 'ws-1', planCode: PLANS.starter, status: 'active' },
      SPARSE,
    );

    expect(rows.map((row) => row.featureKey)).toEqual([FEATURES.contactsStored]);
  });

  it('carries a disabled flag through as false, not as absence', () => {
    const rows = projectEntitlements(subscription({ planCode: PLANS.starter }));
    const pools = rows.find((row) => row.featureKey === FEATURES.sendingPools);

    expect(pools?.flagValue).toBe(false);
  });

  it('reads nothing from the previous projection', () => {
    // A projection that consulted its own output would drift, and the drift
    // would be invisible because the table is only read, never compared.
    const first = projectEntitlements(subscription());
    const second = projectEntitlements(subscription());

    expect(second).toEqual(first);
  });
});

describe('a workspace with no live subscription', () => {
  it('gets no rows at all', () => {
    // Not zeroed rows. "No entitlement to send" and "entitled to send zero"
    // must stay distinguishable: the first is fixed by subscribing, the
    // second looks like a plan.
    expect(projectEntitlements(null)).toEqual([]);
  });

  it('gets no rows once cancelled', () => {
    expect(projectEntitlements(subscription({ status: 'canceled' }))).toEqual([]);
  });

  it('gets no rows on an unknown plan', () => {
    expect(projectEntitlements(subscription({ planCode: 'mystery' }))).toEqual([]);
  });
});

describe('which statuses grant entitlements', () => {
  it('grants while trialing and active', () => {
    expect(grantsEntitlements('trialing')).toBe(true);
    expect(grantsEntitlements('active')).toBe(true);
  });

  it('still grants while past_due', () => {
    // A customer whose card failed this morning has not stopped being a
    // customer. Cutting them off at the first failed charge is how a payment
    // blip becomes a churn event; the dunning ladder restricts them later
    // and on purpose.
    expect(grantsEntitlements('past_due')).toBe(true);
  });

  it('stops granting once unpaid', () => {
    // By then the retries are exhausted and restriction is the intent.
    expect(grantsEntitlements('unpaid')).toBe(false);
  });

  it('grants nothing for a terminal status', () => {
    for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(grantsEntitlements(status), status).toBe(false);
    }
  });

  it('names the granting statuses once', () => {
    expect([...ENTITLING_STATUSES]).toEqual(['trialing', 'active', 'past_due']);
  });
});

describe('comparing two sets of entitlements', () => {
  it('sees no difference between a projection and itself', () => {
    const rows = projectEntitlements(subscription());
    expect(entitlementsDiffer(rows, rows)).toBe(false);
  });

  it('sees a difference in a limit', () => {
    const rows = projectEntitlements(subscription());
    const drifted = rows.map((row, index) =>
      index === 0 ? { ...row, limitValue: 999_999 } : row,
    );

    expect(entitlementsDiffer(rows, drifted)).toBe(true);
  });

  it('sees a difference in a flag', () => {
    const rows = projectEntitlements(subscription());
    const drifted = rows.map((row) =>
      row.featureKey === FEATURES.sendingPools ? { ...row, flagValue: false } : row,
    );

    expect(entitlementsDiffer(rows, drifted)).toBe(true);
  });

  it('sees a missing row', () => {
    const rows = projectEntitlements(subscription());
    expect(entitlementsDiffer(rows.slice(1), rows)).toBe(true);
  });

  it('ignores the order rows arrive in', () => {
    // The database returns them in whatever order it likes, and a
    // reconciler that reported that as divergence would fire every night.
    const rows = projectEntitlements(subscription());
    expect(entitlementsDiffer([...rows].reverse(), rows)).toBe(false);
  });

  it('is not fooled by a value running into a key', () => {
    const rows = [
      { workspaceId: 'ws-1', featureKey: 'a.b' as never, limitValue: 12, flagValue: null, sourceSubscriptionId: null, sourcePlanCode: null },
    ];
    const other = [
      { workspaceId: 'ws-1', featureKey: 'a.b1' as never, limitValue: 2, flagValue: null, sourceSubscriptionId: null, sourcePlanCode: null },
    ];

    expect(entitlementsDiffer(rows, other)).toBe(true);
  });
});

describe('the downgrade pre-check', () => {
  it('lists what would be over the limit', () => {
    // "You cannot downgrade" with no explanation is a support ticket. The
    // customer usually can, once they know they need to delete contacts.
    const over = overLimitOnPlan({
      targetPlanCode: PLANS.starter,
      currentUsage: { [FEATURES.contactsStored]: 9_000, [FEATURES.teamSeats]: 1 },
    });

    expect(over).toEqual([{ featureKey: FEATURES.contactsStored, used: 9_000, limit: 2_500 }]);
  });

  it('allows a downgrade that fits', () => {
    expect(
      overLimitOnPlan({
        targetPlanCode: PLANS.starter,
        currentUsage: { [FEATURES.contactsStored]: 100 },
      }),
    ).toEqual([]);
  });

  it('allows usage exactly at the new limit', () => {
    expect(
      overLimitOnPlan({
        targetPlanCode: PLANS.starter,
        currentUsage: { [FEATURES.contactsStored]: 2_500 },
      }),
    ).toEqual([]);
  });

  it('does not block on a metered feature', () => {
    // Metered features bill or stop; either way the customer is not holding
    // data they would have to delete first.
    expect(
      overLimitOnPlan({
        targetPlanCode: PLANS.starter,
        currentUsage: { [FEATURES.emailsSent]: 5_000_000 },
      }),
    ).toEqual([]);
  });

  it('does not block on an unlimited target', () => {
    expect(
      overLimitOnPlan({
        targetPlanCode: PLANS.enterprise,
        currentUsage: { [FEATURES.contactsStored]: 10_000_000 },
      }),
    ).toEqual([]);
  });

  it('reports several features at once', () => {
    const over = overLimitOnPlan({
      targetPlanCode: PLANS.starter,
      currentUsage: { [FEATURES.contactsStored]: 9_000, [FEATURES.teamSeats]: 8 },
    });

    expect(over.map((row) => row.featureKey).sort()).toEqual(
      [FEATURES.contactsStored, FEATURES.teamSeats].sort(),
    );
  });

  it('says nothing about a plan it does not know', () => {
    expect(
      overLimitOnPlan({ targetPlanCode: 'mystery', currentUsage: { [FEATURES.contactsStored]: 1 } }),
    ).toEqual([]);
  });
});
