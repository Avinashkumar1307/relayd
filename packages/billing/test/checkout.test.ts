import { describe, expect, it, vi } from 'vitest';
import {
  SUCCESS_FALLBACK_AFTER_MS,
  SUCCESS_GIVE_UP_AFTER_MS,
  startCheckout,
  successPollPlan,
  type CheckoutPort,
  type StartCheckoutInput,
} from '../src/checkout/checkout.js';
import type { BillingProviderAdapter } from '../src/port.js';

/**
 * Checkout (INVARIANTS R18, review finding F18).
 *
 * One property matters more than everything else here and it is an ordering:
 * the local row is written before Stripe is called. The natural order — create
 * in Stripe, store what comes back — loses the mapping when the process dies
 * between the two, leaving a Stripe customer that will be charged and that
 * nothing can connect to a workspace.
 */

function harness(over: { port?: Partial<CheckoutPort>; provider?: Partial<BillingProviderAdapter> } = {}) {
  const calls: string[] = [];

  const port: CheckoutPort = {
    async activeSubscription() {
      calls.push('activeSubscription');
      return null;
    },
    async findBillingCustomer() {
      calls.push('findBillingCustomer');
      return null;
    },
    async createPendingBillingCustomer() {
      calls.push('createPending');
    },
    async attachProviderCustomer() {
      calls.push('attachProvider');
    },
    async markBillingCustomerFailed() {
      calls.push('markFailed');
    },
    async findPrice() {
      calls.push('findPrice');
      return { id: 'price-row', providerPriceId: 'price_123' };
    },
    async recordEvent() {
      calls.push('recordEvent');
    },
    ...over.port,
  };

  const provider = {
    async createCustomer() {
      calls.push('stripeCreateCustomer');
      return { id: 'cus_123', email: 'a@example.com', deleted: false };
    },
    async createCheckoutSession() {
      calls.push('stripeCreateSession');
      return {
        id: 'cs_123',
        url: 'https://checkout.stripe.com/cs_123',
        expiresAt: new Date('2026-09-19T13:00:00.000Z'),
      };
    },
    ...over.provider,
  } as unknown as BillingProviderAdapter;

  return { port, provider, calls };
}

function input(over: Partial<StartCheckoutInput> = {}): StartCheckoutInput {
  return {
    workspaceId: 'ws-1',
    email: 'a@example.com',
    planCode: 'growth',
    interval: 'month',
    successUrl: 'https://app.relayd.test/billing/success',
    cancelUrl: 'https://app.relayd.test/billing/cancel',
    newBillingCustomerId: 'bc-new',
    isSelfServe: () => true,
    ...over,
  };
}

describe('the R18 ordering', () => {
  it('writes the local row before calling Stripe', async () => {
    // The whole invariant. Reversed, a crash between the two leaves a Stripe
    // customer nobody can map to a workspace, findable only by reading every
    // customer in the account by hand.
    const { port, provider, calls } = harness();

    await startCheckout(input(), port, provider);

    expect(calls.indexOf('createPending')).toBeLessThan(calls.indexOf('stripeCreateCustomer'));
  });

  it('writes the Stripe id back after the call', async () => {
    const { port, provider, calls } = harness();

    await startCheckout(input(), port, provider);

    expect(calls.indexOf('stripeCreateCustomer')).toBeLessThan(calls.indexOf('attachProvider'));
  });

  it('creates the session only once the customer exists', async () => {
    const { port, provider, calls } = harness();

    await startCheckout(input(), port, provider);

    expect(calls.indexOf('attachProvider')).toBeLessThan(calls.indexOf('stripeCreateSession'));
  });

  it('carries both identifiers into the session (R18)', async () => {
    // The webhook resolves through metadata and never creates a mapping of
    // its own — one that could would recreate the ambiguity this ordering
    // exists to remove.
    let seen: { billingCustomerId?: string; workspaceId?: string } = {};

    const { port, provider } = harness({
      provider: {
        async createCheckoutSession(args: never) {
          seen = args;
          return { id: 'cs', url: 'https://x', expiresAt: new Date() };
        },
      } as never,
    });

    await startCheckout(input(), port, provider);

    expect(seen.billingCustomerId).toBe('bc-new');
    expect(seen.workspaceId).toBe('ws-1');
  });
});

describe('when Stripe fails', () => {
  it('leaves the local row behind, marked failed', async () => {
    // Marked rather than deleted: a deleted row loses the evidence that we
    // may already have created a Stripe customer whose id we never received.
    const { port, provider, calls } = harness({
      provider: {
        async createCustomer() {
          throw new Error('stripe down');
        },
      } as never,
    });

    const result = await startCheckout(input(), port, provider);

    expect(result.failure).toBe('provider_failed');
    expect(calls).toContain('createPending');
    expect(calls).toContain('markFailed');
  });

  it('says plainly that nothing was charged', async () => {
    const { port, provider } = harness({
      provider: {
        async createCustomer() {
          throw new Error('stripe down');
        },
      } as never,
    });

    expect((await startCheckout(input(), port, provider)).message).toContain('Nothing has been charged');
  });

  it('does not create a session', async () => {
    const createCheckoutSession = vi.fn();
    const { port, provider } = harness({
      provider: {
        async createCustomer() {
          throw new Error('stripe down');
        },
        createCheckoutSession,
      } as never,
    });

    await startCheckout(input(), port, provider);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('keeps the customer when only the session fails', async () => {
    // The customer is reusable. Tearing it down would make a retry create a
    // second Stripe customer for the same workspace.
    const { port, provider, calls } = harness({
      provider: {
        async createCheckoutSession() {
          throw new Error('rate limited');
        },
      } as never,
    });

    const result = await startCheckout(input(), port, provider);

    expect(result.failure).toBe('provider_failed');
    expect(calls).not.toContain('markFailed');
  });
});

describe('finishing an interrupted checkout', () => {
  it('reuses a pending row rather than creating a second', async () => {
    // A retry after the crash R18 protects against. Creating a new row would
    // leave two mappings for one workspace, which is the thing the unique
    // index then refuses at an unhelpful moment.
    let attachedTo: string | undefined;
    let sentToStripe: string | undefined;

    const { port, provider, calls } = harness({
      port: {
        async findBillingCustomer() {
          return { id: 'bc-existing', providerCustomerId: null, status: 'pending' as const };
        },
        async attachProviderCustomer(args) {
          attachedTo = args.billingCustomerId;
        },
      },
      provider: {
        async createCustomer(args: { billingCustomerId: string }) {
          sentToStripe = args.billingCustomerId;
          return { id: 'cus_123', email: 'a@example.com', deleted: false };
        },
      } as never,
    });

    await startCheckout(input(), port, provider);

    expect(calls).not.toContain('createPending');

    // Which id, not merely that one was used. Attaching the Stripe customer
    // to the freshly generated id instead of the pending row's leaves the
    // pending row orphaned forever and the mapping written to a row that
    // does not exist.
    expect(attachedTo).toBe('bc-existing');
    expect(sentToStripe).toBe('bc-existing');
  });

  it('reuses a completed mapping without calling Stripe again', async () => {
    const { port, provider, calls } = harness({
      port: {
        async findBillingCustomer() {
          return { id: 'bc-1', providerCustomerId: 'cus_existing', status: 'active' as const };
        },
      },
    });

    await startCheckout(input(), port, provider);

    expect(calls).not.toContain('stripeCreateCustomer');
    expect(calls).toContain('stripeCreateSession');
  });

  it('retries a failed mapping', async () => {
    // `failed` means the Stripe call did not complete. It is finishable in
    // exactly the same way as `pending`.
    const { port, provider, calls } = harness({
      port: {
        async findBillingCustomer() {
          return { id: 'bc-1', providerCustomerId: null, status: 'failed' as const };
        },
      },
    });

    await startCheckout(input(), port, provider);

    expect(calls).toContain('stripeCreateCustomer');
  });
});

describe('what checkout refuses', () => {
  it('a workspace that already subscribes', async () => {
    // `uq_sub_active_ws` refuses it at the database. This refuses it before
    // the customer has entered a card.
    const { port, provider } = harness({
      port: {
        async activeSubscription() {
          return { id: 'sub-1', planCode: 'growth' };
        },
      },
    });

    expect((await startCheckout(input(), port, provider)).failure).toBe('already_subscribed');
  });

  it('a plan that is not self-serve', async () => {
    // An enterprise plan reaching here means somebody posted a code the
    // pricing page never offered.
    const { port, provider } = harness();

    const result = await startCheckout(
      input({ planCode: 'enterprise', isSelfServe: () => false }),
      port,
      provider,
    );

    expect(result.failure).toBe('plan_not_self_serve');
  });

  it('checks the plan before touching anything', async () => {
    const { port, provider, calls } = harness();

    await startCheckout(input({ isSelfServe: () => false }), port, provider);

    expect(calls).toEqual([]);
  });

  it('a plan with no price for the interval', async () => {
    const { port, provider } = harness({
      port: {
        async findPrice() {
          return null;
        },
      },
    });

    expect((await startCheckout(input(), port, provider)).failure).toBe('no_price');
  });

  it('creates no customer when there is no price', async () => {
    // Otherwise a mis-configured plan leaves a Stripe customer behind on
    // every attempt.
    const { port, provider, calls } = harness({
      port: {
        async findPrice() {
          return null;
        },
      },
    });

    await startCheckout(input(), port, provider);

    expect(calls).not.toContain('stripeCreateCustomer');
  });
});

describe('the success page', () => {
  it('polls at first', () => {
    // The frontend never trusts the redirect. Stripe redirects as soon as
    // payment succeeds, and the webhook that creates the subscription row may
    // not have arrived.
    expect(successPollPlan(0)).toBe('poll');
    expect(successPollPlan(5_000)).toBe('poll');
  });

  it('falls back to a server-side lookup after ten seconds', () => {
    // A customer whose webhook is delayed by a Stripe incident otherwise sits
    // on a spinner having just been charged.
    expect(successPollPlan(SUCCESS_FALLBACK_AFTER_MS)).toBe('fallback');
    expect(SUCCESS_FALLBACK_AFTER_MS).toBe(10_000);
  });

  it('gives up eventually rather than polling forever', () => {
    expect(successPollPlan(SUCCESS_GIVE_UP_AFTER_MS)).toBe('give_up');
  });

  it('keeps trying the fallback in between', () => {
    expect(successPollPlan(30_000)).toBe('fallback');
  });
});
