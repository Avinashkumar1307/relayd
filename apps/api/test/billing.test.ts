import { describe, expect, it } from 'vitest';
import { AppError } from '@relayd/types';
import type { WorkspaceScope } from '@relayd/db';
import { FEATURES, PLANS } from '@relayd/billing';
import {
  BillingService,
  checkoutError,
  conflictDetails,
  planChangeError,
  statusForEntitlementDenial,
  type BillingRepositoryLike,
  type BillingServiceOptions,
} from '../src/services/billing.js';

/**
 * The billing service.
 *
 * Thin on purpose, like the campaign service: R18's ordering, the plan-change
 * asymmetry and the entitlement decisions are all proved in
 * `packages/billing` against ports. What is genuinely an API concern is which
 * failure becomes which status and which envelope, and that is most of what
 * this file holds.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

const SUBSCRIPTION = {
  id: 'sub-row',
  providerSubscriptionId: 'sub_stripe',
  planCode: PLANS.growth,
  interval: 'month' as const,
  status: 'active',
  currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
  currentPeriodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  scheduledPlanCode: null,
  scheduledChangeAt: null,
  trialEnd: null,
};

function service(
  over: {
    repo?: Partial<BillingRepositoryLike>;
    provider?: Record<string, unknown>;
    checkout?: Record<string, unknown>;
    planChange?: Record<string, unknown>;
  } = {},
) {
  const calls: string[] = [];

  const repo: BillingRepositoryLike = {
    async readEntitlements() {
      return [
        { featureKey: FEATURES.emailsSent, limitValue: 100_000, flagValue: null },
        { featureKey: FEATURES.contactsStored, limitValue: 25_000, flagValue: null },
      ];
    },
    async readBillingState() {
      return {
        workspaceSuspended: false,
        subscriptionSuspended: false,
        pastDue: false,
        hasSubscription: true,
      };
    },
    async currentSubscription() {
      calls.push('subscription');
      return SUBSCRIPTION;
    },
    async usageForPeriod() {
      return [
        {
          featureKey: FEATURES.emailsSent,
          used: 40_000,
          included: 100_000,
          periodEnd: PERIOD_END,
        },
      ];
    },
    async currentUsageByFeature() {
      return { [FEATURES.contactsStored]: 48_210 };
    },
    async listInvoices() {
      calls.push('invoices');
      return [];
    },
    async defaultPaymentMethod() {
      return { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 };
    },
    async providerCustomerId() {
      return 'cus_123';
    },
    async billingEmail() {
      return 'owner@example.com';
    },
    ...over.repo,
  };

  const provider = {
    async createCustomer() {
      return { id: 'cus_123', email: 'a@example.com', deleted: false };
    },
    async createCheckoutSession() {
      calls.push('stripe-session');
      return { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1', expiresAt: PERIOD_END };
    },
    async createPortalSession() {
      calls.push('stripe-portal');
      return { url: 'https://billing.stripe.com/p/1' };
    },
    async updateSubscriptionPrice() {
      calls.push('stripe-update');
      return {};
    },
    async cancelSubscription() {
      calls.push('stripe-cancel');
      return {};
    },
    ...over.provider,
  };

  const options: BillingServiceOptions = {
    unitOfWork: async (fn) => fn({ billing: repo }),
    provider: provider as never,
    checkoutPort: () => ({
      async activeSubscription() {
        return null;
      },
      async findBillingCustomer() {
        return { id: 'bc-1', providerCustomerId: 'cus_123', status: 'active' as const };
      },
      async createPendingBillingCustomer() {
        calls.push('create-pending');
      },
      async attachProviderCustomer() {
        calls.push('attach');
      },
      async markBillingCustomerFailed() {
        calls.push('mark-failed');
      },
      async findPrice() {
        return { id: 'price-row', providerPriceId: 'price_123' };
      },
      async recordEvent() {
        calls.push('event');
      },
      ...over.checkout,
    }),
    planChangePort: () => ({
      async currentSubscription() {
        return SUBSCRIPTION;
      },
      async findPrice() {
        return { id: 'price-row', providerPriceId: 'price_business' };
      },
      async currentUsage() {
        return { [FEATURES.contactsStored]: 48_210 };
      },
      async applyPlanNow() {
        calls.push('apply-now');
      },
      async schedulePlanChange() {
        calls.push('schedule');
      },
      async recordEvent() {
        calls.push('event');
      },
      ...over.planChange,
    }),
    newId: () => 'bc-new',
    appUrl: 'https://app.relayd.test',
  };

  return { service: new BillingService(options), calls };
}

describe('the plan catalogue', () => {
  it('offers only self-serve plans', () => {
    // Enterprise is provisioned by hand. Listing it here would let anyone
    // post its code to the checkout endpoint.
    const codes = service().service.plans().map((plan) => plan.code);

    expect(codes).not.toContain(PLANS.enterprise);
    expect(codes).toContain(PLANS.growth);
  });

  it('carries the limits the page renders', () => {
    const growth = service().service.plans().find((plan) => plan.code === PLANS.growth);

    expect(growth?.limits[FEATURES.emailsSent]).toBe(100_000);
  });
});

describe('the overview', () => {
  it('returns the subscription, the state, usage and the card together', async () => {
    // One call rather than five. Five round trips is five chances for the
    // customer to see a half-loaded billing screen.
    const { service: s } = service();

    const overview = await s.overview(SCOPE);

    expect(overview.subscription?.planCode).toBe(PLANS.growth);
    expect(overview.state.hasSubscription).toBe(true);
    expect(overview.usage[0]?.used).toBe(40_000);
    expect(overview.paymentMethod?.last4).toBe('4242');
  });

  it('names the plan as well as coding it', async () => {
    const { service: s } = service();

    expect((await s.overview(SCOPE)).subscription?.planName).toBe('Growth');
  });

  it('handles a workspace with no subscription', async () => {
    const { service: s } = service({
      repo: {
        async currentSubscription() {
          return null;
        },
      },
    });

    expect((await s.overview(SCOPE)).subscription).toBe(null);
  });
});

describe('usage', () => {
  it('reports the percentage against the allowance', async () => {
    const { service: s } = service();

    expect((await s.usage(SCOPE))[0]).toMatchObject({ used: 40_000, percentUsed: 40 });
  });

  it('reports no percentage for an unlimited feature', async () => {
    // A percentage of unlimited is not a number, and rendering one as a
    // progress bar at 0% reads as "you have nothing".
    const { service: s } = service({
      repo: {
        async usageForPeriod() {
          return [
            {
              featureKey: FEATURES.emailsSent,
              used: 5_000_000,
              included: null,
              periodEnd: PERIOD_END,
            },
          ];
        },
      },
    });

    const usage = await s.usage(SCOPE);

    expect(usage[0]?.percentUsed).toBe(null);
    expect(usage[0]?.overage).toBe(0);
  });

  it('caps the percentage at a hundred', async () => {
    // Overage means used can exceed included, and a bar at 340% is a
    // rendering bug the customer reports as a billing bug.
    const { service: s } = service({
      repo: {
        async usageForPeriod() {
          return [
            {
              featureKey: FEATURES.emailsSent,
              used: 340_000,
              included: 100_000,
              periodEnd: PERIOD_END,
            },
          ];
        },
      },
    });

    const usage = await s.usage(SCOPE);

    expect(usage[0]?.percentUsed).toBe(100);
    expect(usage[0]?.overage).toBe(240_000);
  });

  it('does not divide by an allowance of zero', async () => {
    const { service: s } = service({
      repo: {
        async usageForPeriod() {
          return [
            { featureKey: FEATURES.emailsSent, used: 10, included: 0, periodEnd: PERIOD_END },
          ];
        },
      },
    });

    expect((await s.usage(SCOPE))[0]?.percentUsed).toBe(null);
  });
});

describe('the read-only entitlement check', () => {
  it('reports a decision rather than refusing', async () => {
    const { service: s } = service();

    const decision = await s.entitlementCheck(SCOPE, {
      feature: FEATURES.emailsSent,
      requested: 1_000,
    });

    expect(decision.allowed).toBe(true);
  });

  it('reports a denial with the shortfall', async () => {
    const { service: s } = service();

    const decision = await s.entitlementCheck(SCOPE, {
      feature: FEATURES.emailsSent,
      requested: 100_000,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.shortfall).toBe(40_000);
  });

  it('checks the feature alone when no quantity is asked about', async () => {
    const { service: s } = service();

    expect((await s.entitlementCheck(SCOPE, { feature: FEATURES.sendingPools })).allowed).toBe(
      false,
    );
  });
});

describe('checkout', () => {
  it('returns the session', async () => {
    const { service: s } = service();

    const session = await s.startCheckout(SCOPE, {
      planCode: PLANS.growth,
      interval: 'month',
    });

    expect(session?.url).toContain('checkout.stripe.com');
  });

  it('carries our redirect URLs', async () => {
    let seen: { successUrl?: string; cancelUrl?: string } = {};
    const { service: s } = service({
      provider: {
        async createCheckoutSession(args: never) {
          seen = args;
          return { id: 'cs', url: 'https://x', expiresAt: PERIOD_END };
        },
      },
    });

    await s.startCheckout(SCOPE, {
      planCode: PLANS.growth,
      interval: 'month',
    });

    expect(seen.successUrl).toContain('/billing/success');
    expect(seen.cancelUrl).toContain('/billing/cancel');
  });

  it('carries the Stripe session placeholder so the page can look itself up', async () => {
    // The server-side fallback after ten seconds needs the session id, and
    // Stripe only substitutes it into a URL containing the placeholder.
    let seen: { successUrl?: string } = {};
    const { service: s } = service({
      provider: {
        async createCheckoutSession(args: never) {
          seen = args;
          return { id: 'cs', url: 'https://x', expiresAt: PERIOD_END };
        },
      },
    });

    await s.startCheckout(SCOPE, {
      planCode: PLANS.growth,
      interval: 'month',
    });

    expect(seen.successUrl).toContain('{CHECKOUT_SESSION_ID}');
  });

  it('maps an existing subscription to 409', async () => {
    const { service: s } = service({
      checkout: {
        async activeSubscription() {
          return { id: 'sub-1', planCode: PLANS.growth };
        },
      },
    });

    await expect(
      s.startCheckout(SCOPE, { planCode: PLANS.growth, interval: 'month' }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('maps a plan nobody may select to 403', async () => {
    const { service: s } = service();

    await expect(
      s.startCheckout(SCOPE, { planCode: PLANS.enterprise, interval: 'month' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('maps a provider outage to 502, not 500', async () => {
    // Not our fault and worth retrying, and the two read very differently to
    // whoever is on call.
    const { service: s } = service({
      provider: {
        async createCheckoutSession() {
          throw new Error('stripe down');
        },
      },
    });

    await expect(
      s.startCheckout(SCOPE, { planCode: PLANS.growth, interval: 'month' }),
    ).rejects.toMatchObject({ status: 502, code: 'provider_unavailable' });
  });
});

describe('the success page', () => {
  it('reports ready once the subscription row exists', async () => {
    const { service: s } = service();

    expect(await s.checkoutStatus(SCOPE, { elapsedMs: 0 })).toMatchObject({
      ready: true,
      action: 'done',
    });
  });

  it('tells the page to keep polling early on', async () => {
    const { service: s } = service({
      repo: {
        async currentSubscription() {
          return null;
        },
      },
    });

    expect(await s.checkoutStatus(SCOPE, { elapsedMs: 2_000 })).toMatchObject({
      ready: false,
      action: 'poll',
    });
  });

  it('tells it to fall back after ten seconds', async () => {
    // A customer whose webhook is delayed by a Stripe incident otherwise sits
    // on a spinner having just been charged.
    const { service: s } = service({
      repo: {
        async currentSubscription() {
          return null;
        },
      },
    });

    expect(await s.checkoutStatus(SCOPE, { elapsedMs: 12_000 })).toMatchObject({
      action: 'fallback',
    });
  });

  it('polls on a nonsense elapsed time rather than giving up', async () => {
    const { service: s } = service({
      repo: {
        async currentSubscription() {
          return null;
        },
      },
    });

    for (const nonsense of [-5_000, Number.NaN]) {
      expect(await s.checkoutStatus(SCOPE, { elapsedMs: nonsense })).toMatchObject({
        action: 'poll',
      });
    }
  });
});

describe('the plan-change preview', () => {
  it('lists what blocks a downgrade', async () => {
    const { service: s } = service();

    const preview = await s.planChangePreview(SCOPE, { planCode: PLANS.starter });

    expect(preview.blocked).toBe(true);
    expect(preview.conflicts[0]).toMatchObject({
      feature: FEATURES.contactsStored,
      current: 48_210,
      targetLimit: 2_500,
    });
  });

  it('allows one that fits', async () => {
    const { service: s } = service({
      repo: {
        async currentUsageByFeature() {
          return { [FEATURES.contactsStored]: 100 };
        },
      },
    });

    expect((await s.planChangePreview(SCOPE, { planCode: PLANS.starter })).blocked).toBe(false);
  });

  it('404s an unknown plan', async () => {
    const { service: s } = service();

    await expect(s.planChangePreview(SCOPE, { planCode: 'platinum' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('changing plan', () => {
  it('applies an upgrade immediately', async () => {
    const { service: s, calls } = service();

    const result = await s.changePlan(SCOPE, { planCode: PLANS.business, interval: 'month' });

    expect(result).toMatchObject({ direction: 'upgrade', appliesAt: 'immediately' });
    expect(calls).toContain('apply-now');
  });

  it('schedules a downgrade', async () => {
    const { service: s, calls } = service({
      planChange: {
        async currentUsage() {
          return {};
        },
      },
    });

    const result = await s.changePlan(SCOPE, { planCode: PLANS.starter, interval: 'month' });

    expect(result).toMatchObject({ direction: 'downgrade', appliesAt: 'period_end' });
    expect(result.effectiveAt).toEqual(PERIOD_END);
    expect(calls).toContain('schedule');
  });

  it('refuses a blocked downgrade with 422 and the conflicts', async () => {
    // docs/05 is specific about this one: `plan_downgrade_blocked` listing the
    // offending features, so the UI can say what to delete.
    const { service: s } = service();

    const error = await s
      .changePlan(SCOPE, { planCode: PLANS.starter, interval: 'month' })
      .catch((caught: unknown) => caught as AppError);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 422, code: 'plan_downgrade_blocked' });
    expect((error as AppError).details?.[0]?.path).toBe(FEATURES.contactsStored);
  });

  it('puts both numbers in the detail', async () => {
    // "Over the limit" without them is an instruction the customer cannot
    // follow.
    const { service: s } = service();

    const error = (await s
      .changePlan(SCOPE, { planCode: PLANS.starter, interval: 'month' })
      .catch((caught: unknown) => caught)) as AppError;

    expect(error.details?.[0]?.message).toContain('48,210');
    expect(error.details?.[0]?.message).toContain('2,500');
  });

  it('groups those numbers the same way wherever it runs', async () => {
    // The server has no user locale, so an unpinned `toLocaleString` formats
    // by whatever the container booted with — 48,210 on one host and 48.210
    // on another, for the same account.
    const { service: s } = service();

    const error = (await s
      .changePlan(SCOPE, { planCode: PLANS.starter, interval: 'month' })
      .catch((caught: unknown) => caught)) as AppError;

    expect(error.details?.[0]?.message).toBe(
      '48,210 in use, 2,500 allowed on that plan',
    );
  });

  it('refuses a plan nobody may select themselves', async () => {
    // Enterprise is provisioned by hand. A plan-change endpoint that offered
    // it would let any owner assign themselves unlimited sending.
    const { service: s, calls } = service();

    await expect(
      s.changePlan(SCOPE, { planCode: PLANS.enterprise, interval: 'month' }),
    ).rejects.toMatchObject({ status: 403 });

    expect(calls).not.toContain('stripe-update');
  });
});

describe('cancelling', () => {
  it('returns the end date for a period-end cancellation', async () => {
    const { service: s, calls } = service();

    expect(await s.cancel(SCOPE, { immediately: false })).toEqual({ endsAt: PERIOD_END });
    expect(calls).toContain('stripe-cancel');
  });

  it('returns no end date for an immediate one', async () => {
    const { service: s } = service();

    expect(await s.cancel(SCOPE, { immediately: true })).toEqual({ endsAt: null });
  });

  it('404s a workspace with no subscription', async () => {
    const { service: s } = service({
      planChange: {
        async currentSubscription() {
          return null;
        },
      },
    });

    await expect(s.cancel(SCOPE, { immediately: false })).rejects.toMatchObject({ status: 404 });
  });
});

describe('the portal', () => {
  it('returns a URL', async () => {
    const { service: s } = service();

    expect((await s.portalSession(SCOPE)).url).toContain('billing.stripe.com');
  });

  it('404s a workspace with no Stripe customer', async () => {
    const { service: s } = service({
      repo: {
        async providerCustomerId() {
          return null;
        },
      },
    });

    await expect(s.portalSession(SCOPE)).rejects.toMatchObject({ status: 404 });
  });
});

describe('invoices', () => {
  it('bounds the page', async () => {
    let asked = 0;
    const { service: s } = service({
      repo: {
        async listInvoices(_scope, input) {
          asked = input.limit;
          return [];
        },
      },
    });

    await s.invoices(SCOPE, { limit: 10_000 });

    expect(asked).toBe(24);
  });

  it('refuses a page of nothing', async () => {
    let asked = 0;
    const { service: s } = service({
      repo: {
        async listInvoices(_scope, input) {
          asked = input.limit;
          return [];
        },
      },
    });

    await s.invoices(SCOPE, { limit: 0 });

    expect(asked).toBe(1);
  });
});

describe('the failure-to-status mapping', () => {
  it('uses codes the API envelope actually has', () => {
    // The billing package has its own vocabulary because it knows nothing
    // about HTTP. Leaking one of its strings into the envelope would put a
    // code in a response that docs/03 does not list.
    for (const failure of [
      'already_subscribed',
      'plan_not_self_serve',
      'no_price',
      'unknown_plan',
      'provider_failed',
      undefined,
    ]) {
      expect(typeof checkoutError(failure).code).toBe('string');
      expect(checkoutError(failure).code).not.toBe(failure);
    }
  });

  it('maps a provider failure to 502 on both paths', () => {
    expect(checkoutError('provider_failed')).toEqual({ code: 'provider_unavailable', status: 502 });
    expect(planChangeError('provider_failed')).toEqual({
      code: 'provider_unavailable',
      status: 502,
    });
  });

  it('maps an unknown plan to 404 on both paths', () => {
    expect(checkoutError('unknown_plan').status).toBe(404);
    expect(planChangeError('unknown_plan').status).toBe(404);
  });

  it('formats a conflict so the UI can highlight the right meter', () => {
    const [detail] = conflictDetails([
      { feature: FEATURES.teamSeats, current: 7, targetLimit: 3 },
    ]);

    expect(detail?.path).toBe(FEATURES.teamSeats);
    expect(detail?.message).toContain('7');
    expect(detail?.message).toContain('3');
  });

  it('turns an entitlement denial into the status the gated endpoint would use', () => {
    expect(statusForEntitlementDenial({ allowed: true })).toBe(200);
    expect(
      statusForEntitlementDenial({
        allowed: false,
        code: 'limit_reached',
        message: 'x',
      }),
    ).toBe(402);
    expect(
      statusForEntitlementDenial({
        allowed: false,
        code: 'workspace_suspended',
        message: 'x',
      }),
    ).toBe(403);
  });
});
