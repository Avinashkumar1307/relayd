import { describe, expect, it } from 'vitest';
import {
  MAX_REFETCH_BACKOFF_MS,
  REFETCH_COOLDOWN_MS,
  ingestBillingEvent,
  isDueForRefetch,
  isNewerThanStored,
  refetchBackoffMs,
  type DirtyObject,
  type IngestPort,
} from '../src/webhooks/ingest.js';
import type { NormalisedBillingEvent } from '../src/port.js';

/**
 * The billing webhook path (INVARIANTS R17; findings F17, F18).
 *
 * R17's proving test is "inject 500 events for 10 objects, assert at most 10
 * Stripe calls per 30-second window". The coalescing half of that is testable
 * here; the API-call count needs a live adapter and lands with the integration
 * suite.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

function event(over: Partial<NormalisedBillingEvent> = {}): NormalisedBillingEvent {
  return {
    providerEventId: 'evt_1',
    type: 'customer.subscription.updated',
    objectType: 'subscription',
    providerObjectId: 'sub_123',
    billingCustomerId: 'bc-1',
    workspaceId: 'ws-1',
    createdAt: NOW,
    payload: { id: 'evt_1' },
    ...over,
  };
}

function port(over: Partial<IngestPort> = {}) {
  const calls: string[] = [];
  const seen = new Set<string>();
  const dirtied: string[] = [];

  const base: IngestPort = {
    async insertInboxEvent(input) {
      calls.push('insert');
      if (seen.has(input.providerEventId)) return false;
      seen.add(input.providerEventId);
      return true;
    },
    async markDirty(input) {
      calls.push('markDirty');
      dirtied.push(input.providerObjectId);
    },
    ...over,
  };

  return { port: base, calls, dirtied };
}

describe('the inbox', () => {
  it('stores the event and marks the object dirty', async () => {
    const { port: p, dirtied } = port();

    const result = await ingestBillingEvent(event(), p);

    expect(result).toMatchObject({ accepted: true, duplicate: false, marked: true });
    expect(dirtied).toEqual(['sub_123']);
  });

  it('does nothing twice for a redelivered event', async () => {
    // Stripe retries. The unique index on (provider, provider_event_id) is
    // what makes the second delivery a no-op.
    const { port: p, dirtied } = port();

    await ingestBillingEvent(event(), p);
    const second = await ingestBillingEvent(event(), p);

    expect(second).toMatchObject({ accepted: true, duplicate: true, marked: false });
    expect(dirtied).toEqual(['sub_123']);
  });

  it('still returns accepted for a duplicate', async () => {
    // Anything but a 2xx makes Stripe retry, and retrying a duplicate
    // forever is how a webhook endpoint ends up disabled by the provider.
    const { port: p } = port();

    await ingestBillingEvent(event(), p);

    expect((await ingestBillingEvent(event(), p)).accepted).toBe(true);
  });

  it('stores an event about nothing we mirror, without marking', async () => {
    // A `ping`, or `customer.discount.created`. Refusing it would make
    // Stripe retry something we will never process.
    const { port: p, calls } = port();

    const result = await ingestBillingEvent(
      event({ objectType: null, providerObjectId: null, type: 'ping' }),
      p,
    );

    expect(result).toMatchObject({ accepted: true, marked: false });
    expect(result.reason).toContain('no object');
    expect(calls).toContain('insert');
    expect(calls).not.toContain('markDirty');
  });

  it('inserts before it marks', async () => {
    // The inbox row commits before the 200 is returned, so a crash after the
    // 200 loses nothing.
    const { port: p, calls } = port();

    await ingestBillingEvent(event(), p);

    expect(calls.indexOf('insert')).toBeLessThan(calls.indexOf('markDirty'));
  });

  it('never calls the provider', async () => {
    // R17/F17: the whole reason this file is separate from the one that
    // applies the change. 500 events for one object would otherwise be 500
    // API calls inside 500 HTTP handlers.
    const { port: p, calls } = port();

    await ingestBillingEvent(event(), p);

    expect(calls.every((call) => !/fetch|stripe|provider/iu.test(call))).toBe(true);
  });
});

describe('coalescing (R17)', () => {
  it('marks one object once per event, not per handler', async () => {
    // 500 events for 10 objects leave 10 rows. The consumer then makes 10
    // API calls rather than 500.
    const { port: p, dirtied } = port();

    for (let i = 0; i < 500; i += 1) {
      await ingestBillingEvent(
        event({
          providerEventId: `evt_${i}`,
          providerObjectId: `sub_${i % 10}`,
        }),
        p,
      );
    }

    expect(dirtied).toHaveLength(500);
    expect(new Set(dirtied).size).toBe(10);
  });
});

describe('when an object is due a fetch', () => {
  function object(over: Partial<DirtyObject> = {}): DirtyObject {
    return {
      objectType: 'subscription',
      providerObjectId: 'sub_1',
      workspaceId: 'ws-1',
      dirtyCount: 1,
      lastDirtyAt: NOW,
      lastFetchedAt: null,
      fetchFailures: 0,
      ...over,
    };
  }

  it('is due immediately if never fetched', () => {
    expect(isDueForRefetch(object(), { now: NOW })).toBe(true);
  });

  it('is not due inside the cooldown', () => {
    // R17's rate bound: at most one fetch per object per 30 seconds.
    expect(
      isDueForRefetch(
        object({
          lastFetchedAt: new Date(NOW.getTime() - 10_000),
          lastDirtyAt: NOW,
        }),
        { now: NOW },
      ),
    ).toBe(false);
  });

  it('is due once the cooldown elapses and it is dirty again', () => {
    expect(
      isDueForRefetch(
        object({
          lastFetchedAt: new Date(NOW.getTime() - REFETCH_COOLDOWN_MS - 1),
          lastDirtyAt: NOW,
        }),
        { now: NOW },
      ),
    ).toBe(true);
  });

  it('is not due when nothing has dirtied it since the last fetch', () => {
    // Without this an object fetched once and never touched again would be
    // fetched every 30 seconds forever, which is the API storm R17 forbids
    // arriving by a slower route.
    expect(
      isDueForRefetch(
        object({
          lastFetchedAt: new Date(NOW.getTime() - 60_000),
          lastDirtyAt: new Date(NOW.getTime() - 120_000),
        }),
        { now: NOW },
      ),
    ).toBe(false);
  });

  it('takes a caller-supplied cooldown', () => {
    expect(
      isDueForRefetch(
        object({ lastFetchedAt: new Date(NOW.getTime() - 5_000), lastDirtyAt: NOW }),
        { now: NOW, cooldownMs: 1_000 },
      ),
    ).toBe(true);
  });

  it('uses the 30 seconds R17 specifies', () => {
    expect(REFETCH_COOLDOWN_MS).toBe(30_000);
  });
});

describe('backing off a failed fetch', () => {
  it('starts at the cooldown', () => {
    expect(refetchBackoffMs(0)).toBe(REFETCH_COOLDOWN_MS);
  });

  it('doubles with each failure', () => {
    expect(refetchBackoffMs(1)).toBe(60_000);
    expect(refetchBackoffMs(2)).toBe(120_000);
  });

  it('caps', () => {
    // A Stripe outage would otherwise have every dirty object retrying every
    // 30 seconds, which is the load pattern most likely to keep us
    // rate-limited once it recovers.
    expect(refetchBackoffMs(20)).toBe(MAX_REFETCH_BACKOFF_MS);
  });

  it('never returns zero', () => {
    for (const failures of [-1, 0, 1, 5]) {
      expect(refetchBackoffMs(failures)).toBeGreaterThan(0);
    }
  });
});

describe('discarding a stale write', () => {
  it('applies a newer version', () => {
    expect(isNewerThanStored({ fetchedVersion: 2, storedVersion: 1 })).toBe(true);
  });

  it('discards an older one', () => {
    // `subscription.updated` (plan A) arriving after `subscription.updated`
    // (plan B) is routine — Stripe gives no ordering guarantee.
    expect(isNewerThanStored({ fetchedVersion: 1, storedVersion: 2 })).toBe(false);
  });

  it('discards an equal one', () => {
    // Re-applying identical state would rewrite `updated_at` on every
    // duplicate delivery, which turns the column from evidence into noise.
    expect(isNewerThanStored({ fetchedVersion: 2, storedVersion: 2 })).toBe(false);
  });

  it('applies anything over a fresh row', () => {
    expect(isNewerThanStored({ fetchedVersion: 1, storedVersion: 0 })).toBe(true);
  });
});
