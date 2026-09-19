import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@relayd/utils';
import {
  BASE_BACKOFF_MS,
  DISABLE_THRESHOLD,
  FAILING_THRESHOLD,
  MAX_BACKOFF_MS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_STORED_RESPONSE_BYTES,
  SECRET_OVERLAP_MS,
  activeSecrets,
  backoffMs,
  buildDelivery,
  classifyResponse,
  nextAttempt,
  nextEndpointHealth,
  shouldDeliver,
  truncateResponse,
  type EndpointHealth,
} from '../src/webhooks/delivery.js';

/**
 * Outbound webhook delivery.
 *
 * Everything interesting here is about failure, because the endpoint belongs
 * to somebody else and will be down at some point. The four rules under test:
 * a stable event id across retries, jittered backoff so a recovering endpoint
 * is not knocked over by our cohort, a two-step path to disabling, and no
 * retrying of a 4xx that will be a 4xx next time too.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const SECRET = 'whsec_' + 'a'.repeat(32);

function health(over: Partial<EndpointHealth> = {}): EndpointHealth {
  return { status: 'active', consecutiveFailures: 0, ...over };
}

describe('classifying a response', () => {
  it('treats 2xx as delivered', () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(classifyResponse({ status })).toBe('delivered');
    }
  });

  it('treats 5xx as retryable', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyResponse({ status })).toBe('retry');
    }
  });

  it('does not retry a 4xx', () => {
    // A 400 means the payload is wrong and it will be wrong next time too.
    // Twelve retries are twelve identical rejections.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyResponse({ status })).toBe('permanent_failure');
    }
  });

  it('retries the two 4xx codes that mean "not now"', () => {
    expect(classifyResponse({ status: 408 })).toBe('retry');
    expect(classifyResponse({ status: 429 })).toBe('retry');
  });

  it('retries a network error', () => {
    // No status is the case where we do not know whether the request
    // arrived. The consumer deduplicating on the event id is what makes
    // trying again safe.
    expect(classifyResponse({ status: null })).toBe('retry');
  });

  it('retries a 3xx rather than following it', () => {
    // Following a redirect from a webhook is how a delivery ends up at a host
    // the customer never subscribed.
    expect(classifyResponse({ status: 302 })).toBe('retry');
  });
});

describe('backoff', () => {
  it('grows with the attempt', () => {
    const first = backoffMs(1, { random: () => 1 });
    const third = backoffMs(3, { random: () => 1 });

    expect(third).toBeGreaterThan(first);
  });

  it('starts at the base delay', () => {
    expect(backoffMs(1, { random: () => 1 })).toBe(BASE_BACKOFF_MS);
  });

  it('caps', () => {
    // The eighth attempt should not be next week.
    expect(backoffMs(40, { random: () => 1 })).toBe(MAX_BACKOFF_MS);
  });

  it('jitters across the whole window rather than adding to it', () => {
    // Added jitter only ever lengthens. The point is to *spread* a cohort:
    // every delivery queued during an outage otherwise retries at the same
    // instant when it ends, and the endpoint that just came back goes down
    // again.
    const low = backoffMs(5, { random: () => 0 });
    const high = backoffMs(5, { random: () => 1 });

    expect(low).toBe(BASE_BACKOFF_MS);
    expect(high).toBeGreaterThan(low);
  });

  it('never returns less than the base', () => {
    for (const attempt of [1, 2, 5, 8]) {
      expect(backoffMs(attempt, { random: () => 0 })).toBeGreaterThanOrEqual(BASE_BACKOFF_MS);
    }
  });

  it('survives a nonsense attempt number', () => {
    for (const attempt of [0, -5]) {
      expect(backoffMs(attempt, { random: () => 0 })).toBe(BASE_BACKOFF_MS);
    }
  });

  it('does not overflow on a large attempt', () => {
    expect(Number.isFinite(backoffMs(1_000, { random: () => 1 }))).toBe(true);
  });
});

describe('endpoint health', () => {
  it('clears the failure count on a success', () => {
    // A consumer who fixed their endpoint is not on probation. Letting the
    // count decay instead would disable them for an outage they resolved.
    expect(nextEndpointHealth(health({ consecutiveFailures: 4 }), 'delivered')).toEqual({
      status: 'active',
      consecutiveFailures: 0,
    });
  });

  it('counts a failure', () => {
    expect(nextEndpointHealth(health(), 'retry').consecutiveFailures).toBe(1);
  });

  it('marks failing at the threshold', () => {
    expect(
      nextEndpointHealth(health({ consecutiveFailures: FAILING_THRESHOLD - 1 }), 'retry').status,
    ).toBe('failing');
  });

  it('stays active one short of it', () => {
    expect(
      nextEndpointHealth(health({ consecutiveFailures: FAILING_THRESHOLD - 2 }), 'retry').status,
    ).toBe('active');
  });

  it('disables only after a great many', () => {
    // An endpoint down for an hour is not the same as one gone since March.
    expect(
      nextEndpointHealth(health({ status: 'failing', consecutiveFailures: DISABLE_THRESHOLD - 1 }), 'retry')
        .status,
    ).toBe('disabled');
  });

  it('recovers a failing endpoint on one success', () => {
    expect(
      nextEndpointHealth(health({ status: 'failing', consecutiveFailures: 9 }), 'delivered'),
    ).toEqual({ status: 'active', consecutiveFailures: 0 });
  });

  it('never reactivates a paused endpoint', () => {
    // Paused is the customer's choice. Silently reactivating because a stray
    // delivery succeeded would be the product overruling them.
    const paused = health({ status: 'paused', consecutiveFailures: 3 });

    expect(nextEndpointHealth(paused, 'delivered')).toEqual(paused);
    expect(nextEndpointHealth(paused, 'retry')).toEqual(paused);
  });

  it('never reactivates a disabled endpoint', () => {
    const disabled = health({ status: 'disabled', consecutiveFailures: 60 });

    expect(nextEndpointHealth(disabled, 'delivered')).toEqual(disabled);
  });

  it('uses the thresholds a caller supplies', () => {
    expect(
      nextEndpointHealth(health({ consecutiveFailures: 1 }), 'retry', { failing: 2 }).status,
    ).toBe('failing');
  });

  it('counts a permanent failure too', () => {
    // An endpoint returning 400 to everything is as broken as one timing out,
    // and costs us the same to keep trying.
    expect(nextEndpointHealth(health(), 'permanent_failure').consecutiveFailures).toBe(1);
  });
});

describe('who receives an event', () => {
  it('an active endpoint subscribed to the type', () => {
    expect(
      shouldDeliver({
        status: 'active',
        subscribedEvents: ['campaign.sent'],
        eventType: 'campaign.sent',
      }),
    ).toBe(true);
  });

  it('a failing endpoint, still', () => {
    // `failing` is a warning, not a stop. Dropping events from an endpoint
    // having a bad hour loses them permanently.
    expect(
      shouldDeliver({
        status: 'failing',
        subscribedEvents: ['campaign.sent'],
        eventType: 'campaign.sent',
      }),
    ).toBe(true);
  });

  it('not a paused or disabled one', () => {
    for (const status of ['paused', 'disabled'] as const) {
      expect(
        shouldDeliver({ status, subscribedEvents: ['*'], eventType: 'campaign.sent' }),
      ).toBe(false);
    }
  });

  it('not for a type it did not subscribe to', () => {
    expect(
      shouldDeliver({
        status: 'active',
        subscribedEvents: ['campaign.sent'],
        eventType: 'contact.created',
      }),
    ).toBe(false);
  });

  it('everything, for a wildcard subscription', () => {
    // Without it every new event type is a support conversation with every
    // integrator.
    expect(
      shouldDeliver({ status: 'active', subscribedEvents: ['*'], eventType: 'anything.new' }),
    ).toBe(true);
  });

  it('nothing, for an empty subscription', () => {
    expect(
      shouldDeliver({ status: 'active', subscribedEvents: [], eventType: 'campaign.sent' }),
    ).toBe(false);
  });
});

describe('secret rotation', () => {
  it('signs with the current secret alone when nothing was rotated', () => {
    expect(
      activeSecrets({ secret: 'new', previousSecret: null, rotatedAt: null, now: NOW }),
    ).toEqual(['new']);
  });

  it('keeps the previous secret live during the overlap', () => {
    expect(
      activeSecrets({
        secret: 'new',
        previousSecret: 'old',
        rotatedAt: new Date(NOW.getTime() - 3_600_000),
        now: NOW,
      }),
    ).toEqual(['new', 'old']);
  });

  it('drops it once the overlap closes', () => {
    expect(
      activeSecrets({
        secret: 'new',
        previousSecret: 'old',
        rotatedAt: new Date(NOW.getTime() - SECRET_OVERLAP_MS - 1),
        now: NOW,
      }),
    ).toEqual(['new']);
  });

  it('puts the current secret first', () => {
    // So a delivery signs with the new one and only *verification* accepts
    // both. Signing with the old one would never let anybody move off it.
    const secrets = activeSecrets({
      secret: 'new',
      previousSecret: 'old',
      rotatedAt: NOW,
      now: NOW,
    });

    expect(secrets[0]).toBe('new');
  });

  it('ignores a previous secret with no rotation time', () => {
    expect(
      activeSecrets({ secret: 'new', previousSecret: 'old', rotatedAt: null, now: NOW }),
    ).toEqual(['new']);
  });

  it('overlaps for a day', () => {
    expect(SECRET_OVERLAP_MS).toBe(24 * 3_600_000);
  });
});

describe('building a delivery', () => {
  function delivery(over: Record<string, unknown> = {}) {
    return buildDelivery({
      url: 'https://example.test/hooks',
      secret: SECRET,
      eventId: '018f7d00-0000-7000-8000-000000000001',
      eventType: 'campaign.sent',
      occurredAt: NOW,
      data: { campaignId: 'c1' },
      at: NOW,
      attempt: 1,
      ...over,
    });
  }

  it('signs the body it sends', () => {
    // Signed as serialised. Signing a structure and serialising it again is
    // how a signature stops matching for reasons nobody can reproduce.
    const built = delivery();

    expect(
      verifyWebhookSignature({
        body: built.body,
        header: built.headers['relayd-signature'] as string,
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ valid: true });
  });

  it('carries the event id in a header as well as the body', () => {
    // So a consumer can deduplicate before parsing, which is what they will
    // want to do under load.
    const built = delivery();

    expect(built.headers['relayd-event-id']).toBe('018f7d00-0000-7000-8000-000000000001');
    expect(JSON.parse(built.body).id).toBe('018f7d00-0000-7000-8000-000000000001');
  });

  it('keeps the event id stable across retries', () => {
    // The property at-least-once delivery rests on. A retry with a new id
    // would leave a consumer no way to tell it from a second event.
    const first = delivery({ attempt: 1 });
    const fourth = delivery({ attempt: 4 });

    expect(JSON.parse(fourth.body).id).toBe(JSON.parse(first.body).id);
  });

  it('says which attempt it is', () => {
    expect(delivery({ attempt: 4 }).headers['relayd-delivery-attempt']).toBe('4');
  });

  it('floors a nonsense attempt at one', () => {
    expect(delivery({ attempt: 0 }).headers['relayd-delivery-attempt']).toBe('1');
  });

  it('never puts the secret in a header', () => {
    const built = delivery();

    expect(JSON.stringify(built.headers)).not.toContain(SECRET);
    expect(built.body).not.toContain(SECRET);
  });

  it('sends JSON and says so', () => {
    expect(delivery().headers['content-type']).toBe('application/json');
  });
});

describe('what to do after an attempt', () => {
  it('stops on success', () => {
    expect(nextAttempt({ attempt: 1, outcome: 'delivered' })).toMatchObject({
      retryAfterMs: null,
      abandoned: false,
    });
  });

  it('stops on a permanent failure without retrying', () => {
    expect(nextAttempt({ attempt: 1, outcome: 'permanent_failure' })).toMatchObject({
      retryAfterMs: null,
      abandoned: true,
    });
  });

  it('schedules a retry', () => {
    const result = nextAttempt({ attempt: 1, outcome: 'retry', random: () => 0 });

    expect(result.retryAfterMs).toBe(BASE_BACKOFF_MS);
    expect(result.abandoned).toBe(false);
  });

  it('gives up at the attempt limit', () => {
    const result = nextAttempt({
      attempt: MAX_DELIVERY_ATTEMPTS,
      outcome: 'retry',
      random: () => 0,
    });

    expect(result.retryAfterMs).toBe(null);
    expect(result.abandoned).toBe(true);
  });

  it('keeps going one short of it', () => {
    expect(
      nextAttempt({ attempt: MAX_DELIVERY_ATTEMPTS - 1, outcome: 'retry', random: () => 0 })
        .abandoned,
    ).toBe(false);
  });

  it('distinguishes abandoned from failed', () => {
    // "We stopped trying" and "it failed" are different things to the person
    // reading the delivery log.
    const abandoned = nextAttempt({ attempt: 99, outcome: 'retry' });
    const permanent = nextAttempt({ attempt: 1, outcome: 'permanent_failure' });

    expect(abandoned.outcome).toBe('retry');
    expect(permanent.outcome).toBe('permanent_failure');
    expect(abandoned.abandoned && permanent.abandoned).toBe(true);
  });

  it('takes a caller-supplied attempt limit', () => {
    expect(nextAttempt({ attempt: 2, outcome: 'retry', maxAttempts: 2 }).abandoned).toBe(true);
  });
});

describe('storing a response', () => {
  it('leaves a short body alone', () => {
    expect(truncateResponse('ok')).toBe('ok');
  });

  it('truncates a long one', () => {
    // An endpoint returning a 2MB HTML error page must not fill the delivery
    // table one failure at a time.
    const truncated = truncateResponse('x'.repeat(10_000));

    expect(truncated.length).toBeLessThan(10_000);
    expect(truncated).toContain('truncated');
  });

  it('keeps the limit in the low kilobytes', () => {
    expect(MAX_STORED_RESPONSE_BYTES).toBe(2_048);
  });
});
