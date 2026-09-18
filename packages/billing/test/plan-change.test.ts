import { describe, expect, it, vi } from 'vitest';
import {
  cancelSubscription,
  changePlan,
  classifyChange,
  planChangeEffect,
  precheckDowngrade,
  type PlanChangePort,
} from '../src/plans/change.js';
import { FEATURES, PLANS } from '../src/plans/catalogue.js';
import type { BillingProviderAdapter } from '../src/port.js';

/**
 * Plan changes (docs/05 "Plan changes").
 *
 * The asymmetry is the whole design: an upgrade applies now and is prorated,
 * a downgrade waits for period end and issues no credit. The property that
 * costs the most when it breaks is neither of those — it is that both modify
 * the existing subscription. A second one bills twice and is discovered at
 * renewal.
 */

const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

function harness(
  over: { port?: Partial<PlanChangePort>; provider?: Partial<BillingProviderAdapter> } = {},
) {
  const calls: string[] = [];
  const scheduled: { planCode: string; effectiveAt: Date }[] = [];
  const applied: string[] = [];
  const prorations: boolean[] = [];

  const port: PlanChangePort = {
    async currentSubscription() {
      calls.push('read-subscription');
      return {
        id: 'sub-1',
        providerSubscriptionId: 'sub_stripe',
        planCode: PLANS.growth,
        interval: 'month',
        currentPeriodEnd: PERIOD_END,
        status: 'active',
      };
    },
    async findPrice() {
      calls.push('find-price');
      return { id: 'price-row', providerPriceId: 'price_123' };
    },
    async currentUsage() {
      calls.push('usage');
      return {};
    },
    async applyPlanNow(input) {
      calls.push('apply-now');
      applied.push(input.planCode);
    },
    async schedulePlanChange(input) {
      calls.push('schedule');
      scheduled.push({ planCode: input.planCode, effectiveAt: input.effectiveAt });
    },
    async recordEvent() {
      calls.push('event');
    },
    ...over.port,
  };

  const provider = {
    async updateSubscriptionPrice(args: { prorate: boolean }) {
      calls.push('provider-update');
      prorations.push(args.prorate);
      return {} as never;
    },
    async cancelSubscription() {
      calls.push('provider-cancel');
      return {} as never;
    },
    ...over.provider,
  } as unknown as BillingProviderAdapter;

  return { port, provider, calls, scheduled, applied, prorations };
}

function input(over: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    toPlanCode: PLANS.business,
    toInterval: 'month' as const,
    isSelfServe: () => true,
    ...over,
  };
}

describe('classifying a change', () => {
  it('reads rank, not price', () => {
    // A promotion making Business temporarily cheaper than Growth would
    // otherwise turn every upgrade into a downgrade for the length of the
    // sale — and a downgrade skips nothing, it *adds* the pre-check, so the
    // customer would be blocked from upgrading by their own usage.
    expect(
      classifyChange({
        fromPlanCode: PLANS.growth,
        toPlanCode: PLANS.business,
        fromInterval: 'month',
        toInterval: 'month',
      }),
    ).toBe('upgrade');
  });

  it('calls a lower rank a downgrade', () => {
    expect(
      classifyChange({
        fromPlanCode: PLANS.business,
        toPlanCode: PLANS.starter,
        fromInterval: 'month',
        toInterval: 'month',
      }),
    ).toBe('downgrade');
  });

  it('calls the same plan and interval nothing', () => {
    expect(
      classifyChange({
        fromPlanCode: PLANS.growth,
        toPlanCode: PLANS.growth,
        fromInterval: 'month',
        toInterval: 'month',
      }),
    ).toBe('none');
  });

  it('calls an interval move on the same plan an interval change', () => {
    expect(
      classifyChange({
        fromPlanCode: PLANS.growth,
        toPlanCode: PLANS.growth,
        fromInterval: 'month',
        toInterval: 'year',
      }),
    ).toBe('interval_only');
  });
});

describe('what each direction does', () => {
  it('applies an upgrade now, prorated', () => {
    // The customer paid for more capacity and expects it now.
    expect(planChangeEffect('upgrade')).toMatchObject({
      appliesAt: 'immediately',
      prorate: true,
      entitlementsAt: 'immediately',
    });
  });

  it('never pre-checks an upgrade', () => {
    // There is nothing to be over the limit of.
    expect(planChangeEffect('upgrade').requiresPrecheck).toBe(false);
  });

  it('waits for period end on a downgrade, with no credit', () => {
    // Refund complexity, and worse, capability disappearing mid-campaign.
    expect(planChangeEffect('downgrade')).toMatchObject({
      appliesAt: 'period_end',
      prorate: false,
      entitlementsAt: 'period_end',
      requiresPrecheck: true,
    });
  });

  it('treats monthly to annual as an upgrade in commitment', () => {
    // More paid up front; Stripe credits the unused month.
    expect(
      planChangeEffect('interval_only', { fromInterval: 'month', toInterval: 'year' }),
    ).toMatchObject({ appliesAt: 'immediately', prorate: true });
  });

  it('makes annual to monthly wait', () => {
    // They have already paid for the year. Applying now quietly stops
    // honouring it.
    expect(
      planChangeEffect('interval_only', { fromInterval: 'year', toInterval: 'month' }),
    ).toMatchObject({ appliesAt: 'period_end', prorate: false });
  });
});

describe('the downgrade pre-check', () => {
  it('blocks a target below current usage', () => {
    const result = precheckDowngrade({
      targetPlanCode: PLANS.starter,
      currentUsage: { [FEATURES.contactsStored]: 48_210 },
    });

    expect(result.blocked).toBe(true);
    expect(result.conflicts).toEqual([
      { feature: FEATURES.contactsStored, current: 48_210, targetLimit: 2_500 },
    ]);
  });

  it('returns every conflict, not the first', () => {
    // Telling a customer to delete contacts and then telling them to remove
    // seats is two support tickets where one message would have done.
    const result = precheckDowngrade({
      targetPlanCode: PLANS.starter,
      currentUsage: {
        [FEATURES.contactsStored]: 48_210,
        [FEATURES.teamSeats]: 7,
      },
    });

    expect(result.conflicts).toHaveLength(2);
  });

  it('allows a target that fits', () => {
    const result = precheckDowngrade({
      targetPlanCode: PLANS.starter,
      currentUsage: { [FEATURES.contactsStored]: 100, [FEATURES.teamSeats]: 1 },
    });

    expect(result).toEqual({ blocked: false, conflicts: [] });
  });

  it('allows usage exactly at the target limit', () => {
    // 2,500 contacts on a 2,500 plan is not over.
    const result = precheckDowngrade({
      targetPlanCode: PLANS.starter,
      currentUsage: { [FEATURES.contactsStored]: 2_500 },
    });

    expect(result.blocked).toBe(false);
  });
});

describe('an upgrade', () => {
  it('modifies the existing subscription', async () => {
    // Never a second. Two live subscriptions bill twice and are discovered at
    // renewal.
    const { port, provider, calls } = harness();

    await changePlan(input(), port, provider);

    expect(calls).toContain('provider-update');
    expect(calls.filter((c) => c === 'provider-update')).toHaveLength(1);
  });

  it('prorates', async () => {
    const { port, provider, prorations } = harness();

    await changePlan(input(), port, provider);

    expect(prorations).toEqual([true]);
  });

  it('applies the plan immediately', async () => {
    const { port, provider, applied, calls } = harness();

    const result = await changePlan(input(), port, provider);

    expect(result).toMatchObject({ ok: true, direction: 'upgrade', appliesAt: 'immediately' });
    expect(applied).toEqual([PLANS.business]);
    expect(calls).not.toContain('schedule');
  });

  it('does not run the pre-check', async () => {
    // A workspace over the Starter limit must still be able to upgrade — it
    // is the way out of being over the limit.
    const { port, provider, calls } = harness();

    await changePlan(input(), port, provider);

    expect(calls).not.toContain('usage');
  });
});

describe('a downgrade', () => {
  function downgrade(usage: Record<string, number> = {}) {
    return harness({
      port: {
        async currentUsage() {
          return usage;
        },
      },
    });
  }

  it('is scheduled to period end', async () => {
    const { port, provider, scheduled } = downgrade();

    const result = await changePlan(input({ toPlanCode: PLANS.starter }), port, provider);

    expect(result).toMatchObject({
      ok: true,
      direction: 'downgrade',
      appliesAt: 'period_end',
      effectiveAt: PERIOD_END,
    });
    expect(scheduled).toEqual([{ planCode: PLANS.starter, effectiveAt: PERIOD_END }]);
  });

  it('does not lower entitlements now', async () => {
    // The customer keeps what they paid for until the period they paid for
    // ends.
    const { port, provider, calls } = downgrade();

    await changePlan(input({ toPlanCode: PLANS.starter }), port, provider);

    expect(calls).not.toContain('apply-now');
  });

  it('issues no proration', async () => {
    const { port, provider, prorations } = downgrade();

    await changePlan(input({ toPlanCode: PLANS.starter }), port, provider);

    expect(prorations).toEqual([false]);
  });

  it('is refused when usage exceeds the target', async () => {
    // Accepting the money and then restricting the account is the
    // alternative, and it is much worse.
    const { port, provider } = downgrade({ [FEATURES.contactsStored]: 48_210 });

    const result = await changePlan(input({ toPlanCode: PLANS.starter }), port, provider);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('plan_downgrade_blocked');
    expect(result.conflicts?.[0]).toMatchObject({
      feature: FEATURES.contactsStored,
      current: 48_210,
      targetLimit: 2_500,
    });
  });

  it('touches nothing when the pre-check blocks', async () => {
    const { port, provider, calls } = downgrade({ [FEATURES.contactsStored]: 48_210 });

    await changePlan(input({ toPlanCode: PLANS.starter }), port, provider);

    expect(calls).not.toContain('provider-update');
    expect(calls).not.toContain('schedule');
    expect(calls).not.toContain('apply-now');
  });

  it('checks usage before it calls the provider', async () => {
    const { port, provider, calls } = downgrade();

    await changePlan(input({ toPlanCode: PLANS.starter }), port, provider);

    expect(calls.indexOf('usage')).toBeLessThan(calls.indexOf('provider-update'));
  });
});

describe('what a change refuses', () => {
  it('a plan that does not exist', async () => {
    const { port, provider } = harness();

    expect((await changePlan(input({ toPlanCode: 'platinum' }), port, provider)).failure).toBe(
      'unknown_plan',
    );
  });

  it('a plan nobody may select themselves', async () => {
    // Enterprise is provisioned by hand. An endpoint that offered it would
    // let anyone assign themselves unlimited sending.
    const { port, provider } = harness();

    const result = await changePlan(
      input({ toPlanCode: PLANS.enterprise, isSelfServe: () => false }),
      port,
      provider,
    );

    expect(result.failure).toBe('plan_not_self_serve');
  });

  it('a workspace with no subscription', async () => {
    const { port, provider } = harness({
      port: {
        async currentSubscription() {
          return null;
        },
      },
    });

    expect((await changePlan(input(), port, provider)).failure).toBe('no_subscription');
  });

  it('a plan with no price for the interval', async () => {
    const { port, provider } = harness({
      port: {
        async findPrice() {
          return null;
        },
      },
    });

    expect((await changePlan(input(), port, provider)).failure).toBe('no_price');
  });

  it('calls no provider when there is no price', async () => {
    const { port, provider, calls } = harness({
      port: {
        async findPrice() {
          return null;
        },
      },
    });

    await changePlan(input(), port, provider);

    expect(calls).not.toContain('provider-update');
  });

  it('writes nothing locally when the provider fails', async () => {
    // The local row would then claim a plan Stripe is not billing for.
    const { port, provider, calls } = harness({
      provider: {
        async updateSubscriptionPrice() {
          throw new Error('stripe down');
        },
      } as never,
    });

    const result = await changePlan(input(), port, provider);

    expect(result.failure).toBe('provider_failed');
    expect(calls).not.toContain('apply-now');
    expect(calls).not.toContain('schedule');
  });
});

describe('changing to the plan already held', () => {
  it('succeeds without touching anything', async () => {
    // A double-clicked button reaches here, and a 4xx for it is a support
    // ticket about a working system.
    const { port, provider, calls } = harness();

    const result = await changePlan(input({ toPlanCode: PLANS.growth }), port, provider);

    expect(result).toMatchObject({ ok: true, direction: 'none' });
    expect(calls).not.toContain('provider-update');
  });
});

describe('cancelling', () => {
  it('schedules to period end by default', async () => {
    const atPeriodEnd = vi.fn(async () => ({}) as never);
    const { port, provider } = harness({
      provider: { cancelSubscription: atPeriodEnd } as never,
    });

    const result = await cancelSubscription({ workspaceId: 'ws-1', immediately: false }, port, provider);

    expect(result).toMatchObject({ ok: true, endsAt: PERIOD_END });
    expect(atPeriodEnd).toHaveBeenCalledWith(
      expect.objectContaining({ atPeriodEnd: true }),
    );
  });

  it('cancels immediately when asked', async () => {
    const cancel = vi.fn(async () => ({}) as never);
    const { port, provider } = harness({ provider: { cancelSubscription: cancel } as never });

    const result = await cancelSubscription({ workspaceId: 'ws-1', immediately: true }, port, provider);

    expect(result.endsAt).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ atPeriodEnd: false }));
  });

  it('writes no local subscription state', async () => {
    // `customer.subscription.updated` carries the authoritative
    // `cancel_at_period_end` and `ended_at`. Guessing here would be a second
    // source of truth for a number Stripe owns.
    const { port, provider, calls } = harness();

    await cancelSubscription({ workspaceId: 'ws-1', immediately: false }, port, provider);

    expect(calls).not.toContain('apply-now');
    expect(calls).not.toContain('schedule');
  });

  it('refuses a workspace with no subscription', async () => {
    const { port, provider } = harness({
      port: {
        async currentSubscription() {
          return null;
        },
      },
    });

    expect(
      (await cancelSubscription({ workspaceId: 'ws-1', immediately: false }, port, provider))
        .failure,
    ).toBe('no_subscription');
  });

  it('records nothing when the provider fails', async () => {
    const { port, provider, calls } = harness({
      provider: {
        async cancelSubscription() {
          throw new Error('stripe down');
        },
      } as never,
    });

    const result = await cancelSubscription(
      { workspaceId: 'ws-1', immediately: false },
      port,
      provider,
    );

    expect(result.failure).toBe('provider_failed');
    expect(calls).not.toContain('event');
  });
});
