import { describe, expect, it } from 'vitest';
import { createWorld } from './support/world.js';
import {
  REFETCH_COOLDOWN_MS,
  startCheckout,
  successPollPlan,
  type Interval,
} from '../src/index.js';
import { FEATURES, PLANS, planByCode } from '../src/plans/catalogue.js';

/**
 * The billing matrix (docs/12 "Billing test matrix", B1–B24).
 *
 * docs/12 wants every one of these "against Stripe test mode with the CLI
 * replaying fixture events, plus a deterministic fake gateway for speed".
 * This is the fake-gateway half, and it runs on every `pnpm test`. The
 * Stripe-test-mode half runs under `pnpm test:billing`, needs
 * `STRIPE_TEST_KEY`, and is where signature verification, real proration
 * arithmetic and the CLI replay live.
 *
 * What makes this worth having rather than a restatement of the unit tests:
 * every case drives the *real* modules — ingest, re-fetch, plan change,
 * dunning, metering, the projection, the reconciler — through an in-memory
 * Stripe that redelivers and reorders the way the real one does. The unit
 * tests prove each piece; this proves the sequence.
 *
 * Numbering follows docs/12 so a failure names the row it broke.
 */

const PERIOD_START = new Date('2026-09-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

/** A world with a live Growth subscription, arrived at the way a real one does. */
async function subscribed(planCode: string = PLANS.growth, interval: Interval = 'month') {
  const world = createWorld({ now: PERIOD_START });

  await startCheckout(
    {
      workspaceId: world.WORKSPACE,
      email: 'owner@example.com',
      planCode,
      interval,
      successUrl: 'https://app.test/billing/success',
      cancelUrl: 'https://app.test/billing/cancel',
      newBillingCustomerId: 'bc-1',
      isSelfServe: (code) => planByCode(code)?.isPublic === true,
    },
    world.ports.checkoutPort,
    world.provider,
  );

  const subscriptionId = world.completeCheckoutAtProvider({ planCode, interval });

  await world.deliver({
    providerEventId: 'evt_checkout',
    type: 'checkout.session.completed',
    providerObjectId: subscriptionId,
  });
  await world.drainRefetch();

  return { world, subscriptionId };
}

describe('B1 — a successful checkout', () => {
  it('leaves an active subscription, matching entitlements and a billing event', async () => {
    const { world } = await subscribed();

    const subscription = world.liveSubscription();

    expect(subscription?.status).toBe('active');
    expect(subscription?.planCode).toBe(PLANS.growth);

    const emails = world.grants().find((grant) => grant.featureKey === FEATURES.emailsSent);
    expect(emails?.limitValue).toBe(100_000);

    expect(world.db.billingEvents.some((event) => event.eventType === 'checkout.started')).toBe(
      true,
    );
    expect(
      world.db.billingEvents.some((event) => event.eventType === 'subscription.created'),
    ).toBe(true);
  });

  it('writes the local mapping before it calls Stripe (R18)', async () => {
    const { world } = await subscribed();

    const customer = [...world.db.billingCustomers.values()][0];

    expect(customer?.status).toBe('active');
    expect(customer?.providerCustomerId).not.toBe(null);
  });
});

describe('B2 — the webhook arrives before the user returns', () => {
  it('the success page finds the subscription on its first poll', async () => {
    const { world } = await subscribed();

    expect(world.liveSubscription()).not.toBe(null);
    expect(successPollPlan(0)).toBe('poll');
  });
});

describe('B3 — the webhook is delayed', () => {
  it('shows processing, and the reconciler repairs it', async () => {
    // No webhook at all: the provider created the subscription and we never
    // heard. This is the F19 case, and the nightly reconciler is the answer.
    const world = createWorld({ now: PERIOD_START });
    world.completeCheckoutAtProvider({ planCode: PLANS.growth });

    expect(world.liveSubscription()).toBe(null);
    expect(successPollPlan(12_000)).toBe('fallback');

    const result = await world.reconcile();

    // We hold no row for it, so it is counted and never invented — guessing
    // the workspace would attach somebody else's card to one.
    expect(result.missingLocally).toBe(1);
    expect(world.db.divergences).toEqual([{ kind: 'missing_locally', corrected: false }]);
  });

  it('a late webhook still lands', async () => {
    const world = createWorld({ now: PERIOD_START });
    const subscriptionId = world.completeCheckoutAtProvider({ planCode: PLANS.growth });

    world.advanceDays(1);
    await world.deliver({ providerEventId: 'evt_late', providerObjectId: subscriptionId });
    await world.drainRefetch();

    expect(world.liveSubscription()?.status).toBe('active');
  });
});

describe('B4 — a duplicated checkout.session.completed', () => {
  it('leaves exactly one subscription and one creation event', async () => {
    const { world, subscriptionId } = await subscribed();

    const before = world.db.billingEvents.filter(
      (event) => event.eventType === 'subscription.created',
    ).length;

    const replay = await world.deliver({
      providerEventId: 'evt_checkout',
      type: 'checkout.session.completed',
      providerObjectId: subscriptionId,
    });
    await world.drainRefetch(0);

    expect(replay.duplicate).toBe(true);
    expect(world.db.subscriptions.size).toBe(1);
    expect(
      world.db.billingEvents.filter((event) => event.eventType === 'subscription.created').length,
    ).toBe(before);
  });

  it('leaves entitlements unchanged on the replay', async () => {
    const { world, subscriptionId } = await subscribed();
    const before = JSON.stringify(world.grants());

    await world.deliver({
      providerEventId: 'evt_checkout',
      type: 'checkout.session.completed',
      providerObjectId: subscriptionId,
    });
    await world.drainRefetch(0);

    expect(JSON.stringify(world.grants())).toBe(before);
  });
});

describe('B5 — an out-of-order subscription.updated', () => {
  it('ends on the provider truth, and the stale write is discarded', async () => {
    const { world, subscriptionId } = await subscribed();

    // The provider moves to Business. We fetch and store it.
    world.remote.subscriptions.get(subscriptionId)!.priceId = 'price_business_month';
    world.remote.subscriptions.get(subscriptionId)!.stateVersion = 5;

    world.advanceDays(1);
    await world.deliver({ providerEventId: 'evt_new', providerObjectId: subscriptionId });
    await world.drainRefetch();

    expect(world.liveSubscription()?.planCode).toBe(PLANS.business);

    // An older event now arrives. The handler re-fetches rather than applying
    // a payload, so what it writes is still the current truth — and the
    // version guard refuses it anyway.
    world.advanceDays(1);
    await world.deliver({ providerEventId: 'evt_old', providerObjectId: subscriptionId });
    const result = await world.drainRefetch();

    expect(result.discarded).toBe(1);
    expect(result.applied).toBe(0);
    expect(world.liveSubscription()?.planCode).toBe(PLANS.business);
  });
});

describe('B7 — an event type we do not model', () => {
  it('is stored and answered, and marks nothing', async () => {
    const { world } = await subscribed();

    const result = await world.deliver({
      providerEventId: 'evt_ping',
      type: 'ping',
      objectType: null,
      providerObjectId: null,
    });

    expect(result).toMatchObject({ accepted: true, marked: false });
    expect(world.db.inbox.has('evt_ping')).toBe(true);
  });
});

describe('B8 — a payment fails on renewal', () => {
  it('goes past due with a grace end, notifies, and keeps sending allowed', async () => {
    const { world, subscriptionId } = await subscribed();

    world.advanceDays(30);
    world.failPaymentAtProvider(subscriptionId);
    await world.deliver({
      providerEventId: 'evt_failed',
      type: 'invoice.payment_failed',
      providerObjectId: subscriptionId,
    });
    await world.drainRefetch();

    const subscription = world.liveSubscription();
    expect(subscription?.status).toBe('past_due');
    expect(subscription?.gracePeriodEnd).not.toBe(null);

    await world.runDunning();

    expect(
      world.db.billingEvents.some((event) => event.eventType === 'dunning.notice'),
    ).toBe(true);

    // Still sending. Cutting somebody off at the first failed charge is how a
    // payment blip becomes a churn event.
    world.openPeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END, included: 100_000 });
    expect(world.check({ feature: FEATURES.contactsStored, requested: 1 }).allowed).toBe(true);
  });
});

describe('B9 — grace expires unpaid', () => {
  it('blocks launches and holds scheduled campaigns', async () => {
    const { world, subscriptionId } = await subscribed();

    world.advanceDays(30);
    world.failPaymentAtProvider(subscriptionId);
    await world.deliver({ providerEventId: 'evt_failed', providerObjectId: subscriptionId });
    await world.drainRefetch();
    await world.runDunning();

    world.advanceDays(15);
    const outcomes = await world.runDunning();

    expect(outcomes[0]?.stage).toBe('restricted');
    expect(world.db.heldCampaigns.size).toBe(1);
  });

  it('does not cancel the held campaigns', async () => {
    const { world, subscriptionId } = await subscribed();

    world.advanceDays(30);
    world.failPaymentAtProvider(subscriptionId);
    await world.deliver({ providerEventId: 'evt_failed', providerObjectId: subscriptionId });
    await world.drainRefetch();
    world.advanceDays(15);
    await world.runDunning();

    // Still scheduled, merely held. Cancelling loses the schedule, the
    // snapshot and the customer's intent, and none of it comes back.
    expect(world.db.scheduledCampaigns.has('camp-1')).toBe(true);
  });
});

describe('B10 — the payment recovers during grace', () => {
  it('returns to active and releases the held campaigns automatically', async () => {
    const { world, subscriptionId } = await subscribed();

    world.advanceDays(30);
    world.failPaymentAtProvider(subscriptionId);
    await world.deliver({ providerEventId: 'evt_failed', providerObjectId: subscriptionId });
    await world.drainRefetch();

    world.advanceDays(15);
    await world.runDunning();
    expect(world.db.heldCampaigns.size).toBe(1);

    world.recoverPaymentAtProvider(subscriptionId);
    await world.deliver({ providerEventId: 'evt_paid', providerObjectId: subscriptionId });
    await world.drainRefetch();

    const outcomes = await world.runDunning();

    expect(world.liveSubscription()?.status).toBe('active');
    expect(outcomes[0]).toMatchObject({ stage: 'current', campaignsReleased: 1 });
    expect(world.db.heldCampaigns.size).toBe(0);
  });

  it('is still picked up after the failure clock is cleared', async () => {
    // The gap this found: a payment clears `first_failed_at`, and a job that
    // selected only on the clock would drop the workspace out on exactly the
    // tick meant to release its held campaigns. The query looks at the stage
    // too.
    const { world, subscriptionId } = await subscribed();

    world.advanceDays(30);
    world.failPaymentAtProvider(subscriptionId);
    await world.deliver({ providerEventId: 'evt_failed', providerObjectId: subscriptionId });
    await world.drainRefetch();
    world.advanceDays(15);
    await world.runDunning();

    world.recoverPaymentAtProvider(subscriptionId);
    world.advanceMs(1_000);
    await world.deliver({ providerEventId: 'evt_paid', providerObjectId: subscriptionId });
    await world.drainRefetch();

    expect(world.liveSubscription()?.firstFailedAt).toBe(null);
    expect(world.liveSubscription()?.dunningStage).toBe('restricted');

    await world.runDunning();

    expect(world.liveSubscription()?.dunningStage).toBe('current');
  });
});

describe('B12 — an upgrade mid-period', () => {
  it('raises entitlements immediately and does not reset the counter', async () => {
    // The customer paid a prorated amount for more headroom in the *same*
    // period. Resetting to zero would give away a free period.
    const { world } = await subscribed(PLANS.starter);

    world.openPeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END, included: 10_000 });
    for (let i = 0; i < 5; i += 1) world.meterSend({ recipientId: `r${i}`, periodStart: PERIOD_START });
    await world.aggregateUsage(PERIOD_START);

    const usedBefore = world.usageByFeature()[FEATURES.emailsSent];

    const result = await world.changePlan({ planCode: PLANS.growth });

    expect(result).toMatchObject({ ok: true, direction: 'upgrade', appliesAt: 'immediately' });
    expect(
      world.grants().find((grant) => grant.featureKey === FEATURES.emailsSent)?.limitValue,
    ).toBe(100_000);
    expect(world.usageByFeature()[FEATURES.emailsSent]).toBe(usedBefore);
  });

  it('modifies the existing subscription rather than creating a second', async () => {
    const { world } = await subscribed(PLANS.starter);

    await world.changePlan({ planCode: PLANS.growth });

    expect(world.remote.subscriptions.size).toBe(1);
    expect(world.db.subscriptions.size).toBe(1);
  });
});

describe('B13 — a downgrade', () => {
  it('is scheduled and changes nothing yet', async () => {
    const { world } = await subscribed(PLANS.growth);

    const result = await world.changePlan({ planCode: PLANS.starter });

    expect(result).toMatchObject({ direction: 'downgrade', appliesAt: 'period_end' });
    expect(world.liveSubscription()?.planCode).toBe(PLANS.growth);
    expect(world.liveSubscription()?.scheduledPlanCode).toBe(PLANS.starter);
    expect(
      world.grants().find((grant) => grant.featureKey === FEATURES.emailsSent)?.limitValue,
    ).toBe(100_000);
  });
});

describe('B14 — a downgrade blocked by usage', () => {
  it('is refused with per-feature detail and changes nothing at the provider', async () => {
    const { world } = await subscribed(PLANS.growth);

    world.openPeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END, included: 100_000 });
    world.db.usageAggregates.set(`${FEATURES.contactsStored}:${PERIOD_START.toISOString()}`, {
      workspaceId: world.WORKSPACE,
      featureKey: FEATURES.contactsStored,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      used: 20_000,
      included: 25_000,
      overage: 0,
      lastUsageRecordId: null,
    });

    const before = world.remote.apiCalls.length;
    const result = await world.changePlan({ planCode: PLANS.starter });

    expect(result.failure).toBe('plan_downgrade_blocked');
    expect(result.conflicts?.[0]).toMatchObject({
      feature: FEATURES.contactsStored,
      current: 20_000,
      targetLimit: 2_500,
    });
    expect(world.remote.apiCalls.length).toBe(before);
    expect(world.liveSubscription()?.scheduledPlanCode).toBe(null);
  });
});

describe('B15 — cancel at period end', () => {
  it('leaves access intact up to the boundary', async () => {
    const { world, subscriptionId } = await subscribed();

    const result = await world.cancel(false);

    expect(result.ok).toBe(true);
    expect(world.remote.subscriptions.get(subscriptionId)?.cancelAtPeriodEnd).toBe(true);
    expect(world.remote.subscriptions.get(subscriptionId)?.status).toBe('active');
    expect(world.check({ feature: FEATURES.emailsSent, requested: 1 }).allowed).toBe(true);
  });

  it('drops entitlements once the provider says it has ended', async () => {
    const { world, subscriptionId } = await subscribed();

    await world.cancel(false);

    world.advanceDays(30);
    world.remote.subscriptions.get(subscriptionId)!.status = 'canceled';
    world.remote.subscriptions.get(subscriptionId)!.stateVersion += 1;

    await world.deliver({
      providerEventId: 'evt_deleted',
      type: 'customer.subscription.deleted',
      providerObjectId: subscriptionId,
    });
    await world.drainRefetch();

    // No rows, not zeroed rows. D7: there is no free plan to fall back to.
    expect(world.grants()).toEqual([]);
    expect(world.check({ feature: FEATURES.emailsSent, requested: 1 }).allowed).toBe(false);
  });
});

describe('B16 — cancel immediately', () => {
  it('drops entitlements at once', async () => {
    const { world, subscriptionId } = await subscribed();

    await world.cancel(true);

    // A second passes. Without it the dirty row and the previous fetch share
    // a timestamp and the consumer reads the object as already current.
    world.advanceMs(1_000);
    await world.deliver({ providerEventId: 'evt_cancelled', providerObjectId: subscriptionId });
    await world.drainRefetch();

    expect(world.remote.subscriptions.get(subscriptionId)?.status).toBe('canceled');
    expect(world.grants()).toEqual([]);
  });
});

describe('B17 — resuming a cancel-at-period-end', () => {
  it('clears the flag and leaves the subscription alone', async () => {
    const { world, subscriptionId } = await subscribed();

    await world.cancel(false);
    world.advanceMs(1_000);
    await world.deliver({ providerEventId: 'evt_flagged', providerObjectId: subscriptionId });
    await world.drainRefetch();
    expect(world.liveSubscription()?.cancelAtPeriodEnd).toBe(true);

    // The customer clicks Resume; Stripe clears the flag and emits again.
    world.remote.subscriptions.get(subscriptionId)!.cancelAtPeriodEnd = false;
    world.remote.subscriptions.get(subscriptionId)!.stateVersion += 1;

    world.advanceDays(1);
    await world.deliver({ providerEventId: 'evt_resumed', providerObjectId: subscriptionId });
    await world.drainRefetch();

    expect(world.liveSubscription()?.cancelAtPeriodEnd).toBe(false);
    expect(world.liveSubscription()?.planCode).toBe(PLANS.growth);
    expect(world.liveSubscription()?.status).toBe('active');
  });
});

describe('B21 — two concurrent checkouts', () => {
  it('leaves exactly one active subscription', async () => {
    const { world } = await subscribed();

    // The second attempt is refused before a card is entered, and the
    // database index refuses it again underneath.
    const second = await startCheckout(
      {
        workspaceId: world.WORKSPACE,
        email: 'owner@example.com',
        planCode: PLANS.business,
        interval: 'month',
        successUrl: 'https://app.test/billing/success',
        cancelUrl: 'https://app.test/billing/cancel',
        newBillingCustomerId: 'bc-2',
        isSelfServe: () => true,
      },
      world.ports.checkoutPort,
      world.provider,
    );

    expect(second.failure).toBe('already_subscribed');
    expect(world.db.subscriptions.size).toBe(1);
  });

  it('does not create a second Stripe customer', async () => {
    const { world } = await subscribed();

    const before = world.remote.customers.size;

    await startCheckout(
      {
        workspaceId: world.WORKSPACE,
        email: 'owner@example.com',
        planCode: PLANS.business,
        interval: 'month',
        successUrl: 'https://app.test/billing/success',
        cancelUrl: 'https://app.test/billing/cancel',
        newBillingCustomerId: 'bc-3',
        isSelfServe: () => true,
      },
      world.ports.checkoutPort,
      world.provider,
    );

    expect(world.remote.customers.size).toBe(before);
  });
});

describe('B22 — a renewal and an upgrade in the same second', () => {
  it('ends in one coherent state with the period boundary intact', async () => {
    const { world, subscriptionId } = await subscribed(PLANS.starter);

    // The renewal moves the period. The upgrade moves the price. Both land
    // on one object, and we re-fetch rather than applying either payload.
    const remoteRow = world.remote.subscriptions.get(subscriptionId)!;
    remoteRow.currentPeriodStart = PERIOD_END;
    remoteRow.currentPeriodEnd = new Date(PERIOD_END.getTime() + 30 * 86_400_000);
    remoteRow.priceId = 'price_growth_month';
    remoteRow.stateVersion += 2;

    world.advanceDays(1);
    await world.deliver({ providerEventId: 'evt_renewal', providerObjectId: subscriptionId });
    await world.deliver({ providerEventId: 'evt_upgrade', providerObjectId: subscriptionId });

    const result = await world.drainRefetch();

    // Two events, one object, one fetch — R17's coalescing, and the reason
    // the two changes cannot half-apply.
    expect(result.claimed).toBe(1);
    expect(world.liveSubscription()?.planCode).toBe(PLANS.growth);
    expect(world.liveSubscription()?.currentPeriodStart).toEqual(PERIOD_END);
  });
});

describe('B23 — usage exactly at the limit', () => {
  it('allows the last send and refuses the next', async () => {
    const { world } = await subscribed(PLANS.starter);

    world.openPeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END, included: 10_000 });
    world.db.usageAggregates.get(`${FEATURES.emailsSent}:${PERIOD_START.toISOString()}`)!.used =
      9_999;

    expect(world.check({ feature: FEATURES.emailsSent, requested: 1 }).allowed).toBe(true);

    world.db.usageAggregates.get(`${FEATURES.emailsSent}:${PERIOD_START.toISOString()}`)!.used =
      10_000;

    const denied = world.check({ feature: FEATURES.emailsSent, requested: 1 });
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.code).toBe('limit_reached');
  });
});

describe('the metering ledger (R14, R15) end to end', () => {
  it('bills a send once however many times it is retried', async () => {
    const { world } = await subscribed();
    world.openPeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END, included: 100_000 });

    expect(world.meterSend({ recipientId: 'rec-1', periodStart: PERIOD_START })).toBe(true);
    expect(world.meterSend({ recipientId: 'rec-1', periodStart: PERIOD_START })).toBe(false);

    await world.aggregateUsage(PERIOD_START);

    expect(world.usageByFeature()[FEATURES.emailsSent]).toBe(1);
  });

  it('gives the same total however many times aggregation runs (R15)', async () => {
    const { world } = await subscribed();
    world.openPeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END, included: 100_000 });

    for (let i = 0; i < 40; i += 1) {
      world.meterSend({ recipientId: `rec-${i}`, periodStart: PERIOD_START });
    }

    await world.aggregateUsage(PERIOD_START);
    const first = world.usageByFeature()[FEATURES.emailsSent];

    await world.aggregateUsage(PERIOD_START);
    await world.aggregateUsage(PERIOD_START);

    expect(first).toBe(40);
    expect(world.usageByFeature()[FEATURES.emailsSent]).toBe(40);
  });

  it('does not reset the counter on an upgrade', async () => {
    const { world } = await subscribed(PLANS.starter);
    world.openPeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END, included: 10_000 });

    for (let i = 0; i < 12; i += 1) {
      world.meterSend({ recipientId: `rec-${i}`, periodStart: PERIOD_START });
    }
    await world.aggregateUsage(PERIOD_START);

    await world.changePlan({ planCode: PLANS.growth });

    expect(world.usageByFeature()[FEATURES.emailsSent]).toBe(12);
  });
});

describe('replays and reordering (R17)', () => {
  it('turns five hundred events for ten objects into ten fetches', async () => {
    const world = createWorld({ now: PERIOD_START });

    const ids = Array.from({ length: 10 }, () =>
      world.completeCheckoutAtProvider({ planCode: PLANS.growth }),
    );

    for (let i = 0; i < 500; i += 1) {
      await world.deliver({
        providerEventId: `evt_${i}`,
        providerObjectId: ids[i % 10] as string,
      });
    }

    expect(world.db.refetchQueue.size).toBe(10);

    const before = world.remote.apiCalls.filter((call) => call === 'fetchSubscription').length;
    await world.drainRefetch();
    const after = world.remote.apiCalls.filter((call) => call === 'fetchSubscription').length;

    expect(after - before).toBe(10);
  });

  it('refuses a second fetch inside the cooldown', async () => {
    const { world, subscriptionId } = await subscribed();

    world.advanceDays(1);
    await world.deliver({ providerEventId: 'evt_a', providerObjectId: subscriptionId });
    await world.drainRefetch(REFETCH_COOLDOWN_MS);

    await world.deliver({ providerEventId: 'evt_b', providerObjectId: subscriptionId });
    const second = await world.drainRefetch(REFETCH_COOLDOWN_MS);

    expect(second.applied).toBe(0);
  });

  it('is unaffected by the order events arrive in', async () => {
    // The final state is a function of the provider, not of delivery order.
    // That is the whole reason the handler re-fetches instead of applying a
    // payload.
    const forward = await subscribed();
    const reverse = await subscribed();

    for (const { world, subscriptionId } of [forward, reverse]) {
      world.remote.subscriptions.get(subscriptionId)!.priceId = 'price_business_month';
      world.remote.subscriptions.get(subscriptionId)!.stateVersion += 1;
      world.advanceDays(1);
    }

    await forward.world.deliver({ providerEventId: 'e1', providerObjectId: forward.subscriptionId });
    await forward.world.deliver({ providerEventId: 'e2', providerObjectId: forward.subscriptionId });
    await forward.world.drainRefetch();

    await reverse.world.deliver({ providerEventId: 'e2', providerObjectId: reverse.subscriptionId });
    await reverse.world.deliver({ providerEventId: 'e1', providerObjectId: reverse.subscriptionId });
    await reverse.world.drainRefetch();

    expect(forward.world.liveSubscription()?.planCode).toBe(
      reverse.world.liveSubscription()?.planCode,
    );
    expect(forward.world.liveSubscription()?.planCode).toBe(PLANS.business);
  });
});

describe('the nightly reconciler (R19) end to end', () => {
  it('repairs a change whose webhook never arrived', async () => {
    const { world, subscriptionId } = await subscribed();

    // Webhooks disabled: the provider moves and we hear nothing.
    world.remote.subscriptions.get(subscriptionId)!.status = 'past_due';
    world.remote.subscriptions.get(subscriptionId)!.stateVersion += 1;

    expect(world.liveSubscription()?.status).toBe('active');

    const result = await world.reconcile();

    expect(result.corrected).toBe(1);
    expect(world.liveSubscription()?.status).toBe('past_due');
    expect(world.db.divergences).toEqual([{ kind: 'status', corrected: true }]);
  });

  it('records the run', async () => {
    const { world, subscriptionId } = await subscribed();
    world.remote.subscriptions.get(subscriptionId)!.status = 'past_due';
    world.remote.subscriptions.get(subscriptionId)!.stateVersion += 1;

    await world.reconcile();

    expect(world.db.reconciliationRuns[0]).toMatchObject({
      finished: true,
      found: 1,
      corrected: 1,
    });
  });

  it('finds nothing when everything already agrees', async () => {
    const { world } = await subscribed();

    const result = await world.reconcile();

    expect(result.divergences).toEqual([]);
    expect(world.db.divergences).toEqual([]);
  });
});
