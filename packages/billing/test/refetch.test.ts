import { describe, expect, it } from 'vitest';
import {
  refetchBatch,
  refetchObject,
  type RefetchPort,
} from '../src/webhooks/refetch.js';
import { REFETCH_COOLDOWN_MS, type DirtyObject } from '../src/webhooks/ingest.js';
import type { BillingProviderAdapter, ObjectType } from '../src/port.js';

/**
 * The coalesced re-fetch consumer (INVARIANTS R17, review finding F17).
 *
 * The property worth stating first is what this does *not* read: the webhook
 * payload. The event is a trigger. `subscription.updated` (plan A) arriving
 * after `subscription.updated` (plan B) is routine and unordered by design, so
 * a handler that applied payloads would write whichever arrived last, and one
 * that re-fetches writes what is true.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

function dirty(over: Partial<DirtyObject> = {}): DirtyObject {
  return {
    objectType: 'subscription',
    providerObjectId: 'sub_123',
    workspaceId: 'ws-1',
    dirtyCount: 5,
    lastDirtyAt: NOW,
    lastFetchedAt: null,
    fetchFailures: 0,
    ...over,
  };
}

function subscription(stateVersion: number) {
  return {
    id: 'sub_123',
    customerId: 'cus_1',
    status: 'active' as const,
    priceIds: ['price_growth'],
    currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEnd: null,
    stateVersion,
    items: [],
  };
}

function harness(
  over: {
    stored?: number;
    port?: Partial<RefetchPort>;
    provider?: Record<string, unknown>;
    remoteVersion?: number;
  } = {},
) {
  const calls: string[] = [];
  const applied: number[] = [];

  const port: RefetchPort = {
    async claimDirtyObjects() {
      calls.push('claim');
      return [dirty()];
    },
    async storedVersion() {
      calls.push('stored-version');
      return over.stored ?? 1;
    },
    async applySubscription(input) {
      calls.push('apply-subscription');
      applied.push(input.stateVersion);
      return true;
    },
    async applyInvoice(input) {
      calls.push('apply-invoice');
      applied.push(input.stateVersion);
      return true;
    },
    async applyCustomer() {
      calls.push('apply-customer');
      return true;
    },
    async markFetched() {
      calls.push('mark-fetched');
    },
    async markFetchFailed() {
      calls.push('mark-failed');
    },
    ...over.port,
  };

  const provider = {
    async fetchSubscription() {
      calls.push('fetch-subscription');
      return subscription(over.remoteVersion ?? 9);
    },
    async fetchInvoice() {
      calls.push('fetch-invoice');
      return { id: 'in_1', stateVersion: over.remoteVersion ?? 9 };
    },
    async fetchCustomer() {
      calls.push('fetch-customer');
      return { id: 'cus_1', email: 'a@example.com', deleted: false };
    },
    ...over.provider,
  } as unknown as BillingProviderAdapter;

  return { port, provider, calls, applied };
}

describe('re-fetching one object', () => {
  it('fetches and applies', async () => {
    const { port, provider, applied } = harness();

    const result = await refetchObject(dirty(), { now: NOW }, port, provider);

    expect(result.outcome).toBe('applied');
    expect(applied).toEqual([9]);
  });

  it('writes what the provider returned, not what the row said', async () => {
    // The event is a trigger. `subscription.updated` (plan A) arriving after
    // `subscription.updated` (plan B) is routine and unordered, so a handler
    // that applied payloads would write whichever arrived last.
    let written: { status?: string } = {};

    const { port, provider } = harness({
      provider: {
        async fetchSubscription() {
          return { ...subscription(9), status: 'past_due' as const };
        },
      },
      port: {
        async applySubscription(input) {
          written = input.subscription as { status?: string };
          return true;
        },
      },
    });

    await refetchObject(dirty(), { now: NOW }, port, provider);

    expect(written.status).toBe('past_due');
  });

  it('clears the dirty row after a successful fetch', async () => {
    const { port, provider, calls } = harness();

    await refetchObject(dirty(), { now: NOW }, port, provider);

    expect(calls).toContain('mark-fetched');
  });

  it('refuses to fetch inside the cooldown', async () => {
    // R17's rate bound. At the monthly boundary this is the difference
    // between staying inside Stripe's read budget and spending the morning
    // rate-limited.
    const { port, provider, calls } = harness();

    const result = await refetchObject(
      dirty({ lastFetchedAt: new Date(NOW.getTime() - 5_000), lastDirtyAt: NOW }),
      { now: NOW },
      port,
      provider,
    );

    expect(result.outcome).toBe('not_due');
    expect(calls).not.toContain('fetch-subscription');
  });

  it('fetches once the cooldown elapses', async () => {
    const { port, provider, calls } = harness();

    await refetchObject(
      dirty({
        lastFetchedAt: new Date(NOW.getTime() - REFETCH_COOLDOWN_MS - 1),
        lastDirtyAt: NOW,
      }),
      { now: NOW },
      port,
      provider,
    );

    expect(calls).toContain('fetch-subscription');
  });
});

describe('a stale answer', () => {
  it('is discarded rather than applied', async () => {
    // Two consumers, or a consumer racing the nightly reconciler. The older
    // answer must not overwrite the newer one whichever finished first.
    const { port, provider, calls } = harness({ stored: 9, remoteVersion: 5 });

    const result = await refetchObject(dirty(), { now: NOW }, port, provider);

    expect(result.outcome).toBe('discarded_stale');
    expect(calls).not.toContain('apply-subscription');
  });

  it('is discarded when the versions are equal', async () => {
    // Re-applying identical state rewrites `updated_at` on every duplicate
    // delivery, which turns the column from evidence into noise.
    const { port, provider } = harness({ stored: 9, remoteVersion: 9 });

    expect((await refetchObject(dirty(), { now: NOW }, port, provider)).outcome).toBe(
      'discarded_stale',
    );
  });

  it('still clears the dirty row', async () => {
    // Otherwise the object is fetched every thirty seconds forever, which is
    // the API storm R17 forbids arriving by a slower route.
    const { port, provider, calls } = harness({ stored: 9, remoteVersion: 5 });

    await refetchObject(dirty(), { now: NOW }, port, provider);

    expect(calls).toContain('mark-fetched');
  });

  it('reports a lost database race as stale, not applied', async () => {
    // The version guard exists in the database too, and that is the one that
    // actually holds: two consumers can both pass the in-memory check.
    const { port, provider } = harness({
      port: {
        async applySubscription() {
          return false;
        },
      },
    });

    expect((await refetchObject(dirty(), { now: NOW }, port, provider)).outcome).toBe(
      'discarded_stale',
    );
  });
});

describe('an object that is gone', () => {
  it('is recorded rather than retried', async () => {
    // A deleted subscription is a fact, not a transient failure.
    const { port, provider, calls } = harness({
      provider: {
        async fetchSubscription() {
          return null;
        },
      },
    });

    const result = await refetchObject(dirty(), { now: NOW }, port, provider);

    expect(result.outcome).toBe('gone');
    expect(calls).toContain('mark-fetched');
    expect(calls).not.toContain('mark-failed');
  });
});

describe('an invoice', () => {
  it('is applied when newer', async () => {
    const { port, provider, applied, calls } = harness({
      stored: 1,
      remoteVersion: 4,
    });

    const result = await refetchObject(
      dirty({ objectType: 'invoice', providerObjectId: 'in_1' }),
      { now: NOW },
      port,
      provider,
    );

    expect(result.outcome).toBe('applied');
    expect(calls).toContain('apply-invoice');
    expect(applied).toEqual([4]);
  });

  it('is discarded when not newer', async () => {
    // The same version guard as a subscription. An invoice rewritten from a
    // stale fetch shows the wrong amount due on the billing page.
    const { port, provider, calls } = harness({ stored: 9, remoteVersion: 4 });

    const result = await refetchObject(
      dirty({ objectType: 'invoice', providerObjectId: 'in_1' }),
      { now: NOW },
      port,
      provider,
    );

    expect(result.outcome).toBe('discarded_stale');
    expect(calls).not.toContain('apply-invoice');
  });

  it('that is gone is recorded rather than retried', async () => {
    const { port, provider, calls } = harness({
      provider: {
        async fetchInvoice() {
          return null;
        },
      },
    });

    const result = await refetchObject(
      dirty({ objectType: 'invoice', providerObjectId: 'in_1' }),
      { now: NOW },
      port,
      provider,
    );

    expect(result.outcome).toBe('gone');
    expect(calls).not.toContain('mark-failed');
  });
});

describe('a customer', () => {
  it('is applied without a version check', async () => {
    // Stripe customers carry nothing we order by, and the fields we mirror —
    // email, deleted — are last-write-wins by nature.
    const { port, provider, calls } = harness();

    const result = await refetchObject(
      dirty({ objectType: 'customer', providerObjectId: 'cus_1' }),
      { now: NOW },
      port,
      provider,
    );

    expect(result.outcome).toBe('applied');
    expect(calls).toContain('apply-customer');
    expect(calls).not.toContain('stored-version');
  });

  it('that is gone is recorded rather than written', async () => {
    // A customer deleted in the Stripe dashboard. Writing "applied" here
    // would claim we mirrored a customer that no longer exists.
    const { port, provider, calls } = harness({
      provider: {
        async fetchCustomer() {
          return null;
        },
      },
    });

    const result = await refetchObject(
      dirty({ objectType: 'customer', providerObjectId: 'cus_1' }),
      { now: NOW },
      port,
      provider,
    );

    expect(result.outcome).toBe('gone');
    expect(calls).not.toContain('apply-customer');
  });
});

describe('an object type we do not fetch', () => {
  it('is cleared rather than left dirty', async () => {
    // A payment method, a charge. Nothing will ever fetch it, and a row that
    // stays dirty forever is a queue that never drains — which looks exactly
    // like a backlog.
    const { port, provider, calls } = harness();

    const result = await refetchObject(
      dirty({ objectType: 'charge' as ObjectType }),
      { now: NOW },
      port,
      provider,
    );

    expect(result.outcome).toBe('unsupported');
    expect(calls).toEqual(['mark-fetched']);
  });
});

describe('a failed fetch', () => {
  it('is recorded with a backoff', async () => {
    const { port, provider, calls } = harness({
      provider: {
        async fetchSubscription() {
          throw new Error('rate limited');
        },
      },
    });

    const result = await refetchObject(dirty(), { now: NOW }, port, provider);

    expect(result.outcome).toBe('failed');
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(calls).toContain('mark-failed');
  });

  it('does not clear the dirty row', async () => {
    // Cleared, the object would never be fetched again and its local state
    // would stay wrong until the nightly reconciler noticed.
    const { port, provider, calls } = harness({
      provider: {
        async fetchSubscription() {
          throw new Error('rate limited');
        },
      },
    });

    await refetchObject(dirty(), { now: NOW }, port, provider);

    expect(calls).not.toContain('mark-fetched');
  });

  it('backs off further each time', async () => {
    const { port, provider } = harness({
      provider: {
        async fetchSubscription() {
          throw new Error('rate limited');
        },
      },
    });

    const first = await refetchObject(dirty({ fetchFailures: 0 }), { now: NOW }, port, provider);
    const later = await refetchObject(dirty({ fetchFailures: 4 }), { now: NOW }, port, provider);

    expect(later.retryAfterMs).toBeGreaterThan(first.retryAfterMs ?? 0);
  });
});

describe('a batch', () => {
  it('counts what it did', async () => {
    const { port, provider } = harness({
      port: {
        async claimDirtyObjects() {
          return [dirty(), dirty({ providerObjectId: 'sub_456' })];
        },
      },
    });

    const result = await refetchBatch({ now: NOW }, port, provider);

    expect(result).toMatchObject({ claimed: 2, applied: 2, discarded: 0, failed: 0 });
  });

  it('does not stop at a failure', async () => {
    // One subscription belonging to a deleted Stripe account must not hold up
    // every other customer's billing state, and that is exactly the row most
    // likely to fail repeatedly.
    let seen = 0;
    const { port, provider } = harness({
      port: {
        async claimDirtyObjects() {
          return [dirty(), dirty({ providerObjectId: 'sub_456' }), dirty({ providerObjectId: 'sub_789' })];
        },
      },
      provider: {
        async fetchSubscription() {
          seen += 1;
          if (seen === 2) throw new Error('boom');
          return subscription(9);
        },
      },
    });

    const result = await refetchBatch({ now: NOW }, port, provider);

    expect(result).toMatchObject({ claimed: 3, applied: 2, failed: 1 });
  });

  it('counts a discarded object as discarded, not applied', async () => {
    // `applied` is the number the operator reads to know the consumer is
    // working. Counting every non-failure into it makes a consumer that is
    // discarding everything look healthy.
    const { port, provider } = harness({
      stored: 9,
      remoteVersion: 4,
      port: {
        async claimDirtyObjects() {
          return [dirty(), dirty({ providerObjectId: 'sub_456' })];
        },
      },
    });

    const result = await refetchBatch({ now: NOW }, port, provider);

    expect(result).toMatchObject({ claimed: 2, applied: 0, discarded: 2, failed: 0 });
  });

  it('bounds what it claims', async () => {
    let asked = 0;
    const { port, provider } = harness({
      port: {
        async claimDirtyObjects(input) {
          asked = input.limit;
          return [];
        },
      },
    });

    await refetchBatch({ now: NOW, limit: 25 }, port, provider);

    expect(asked).toBe(25);
  });

  it('refuses a limit of zero', async () => {
    // Claiming nothing forever is a consumer that looks healthy and does
    // nothing.
    let asked = 0;
    const { port, provider } = harness({
      port: {
        async claimDirtyObjects(input) {
          asked = input.limit;
          return [];
        },
      },
    });

    await refetchBatch({ now: NOW, limit: 0 }, port, provider);

    expect(asked).toBe(1);
  });

  it('handles an empty queue', async () => {
    const { port, provider } = harness({
      port: {
        async claimDirtyObjects() {
          return [];
        },
      },
    });

    expect(await refetchBatch({ now: NOW }, port, provider)).toMatchObject({
      claimed: 0,
      applied: 0,
    });
  });
});

describe('coalescing (R17)', () => {
  it('makes one API call for an object dirtied five hundred times', async () => {
    // The arithmetic the invariant is about: one row per object, not per
    // event, so `dirty_count` of 500 costs one fetch.
    const { port, provider, calls } = harness();

    await refetchObject(dirty({ dirtyCount: 500 }), { now: NOW }, port, provider);

    expect(calls.filter((c) => c === 'fetch-subscription')).toHaveLength(1);
  });
});
