// @vitest-environment node
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import {
  RATE_LIMITS,
  ipRateKey,
  rateLimit,
  slidingWindowDecision,
  type RateLimitStore,
} from '../src/middleware/rate-limit.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';

/**
 * Rate limiting (docs/06 section 15).
 *
 * Two decisions are worth holding onto. The window is *sliding*, because a
 * fixed one lets a caller spend the whole budget in the last second of one
 * window and the whole budget in the first second of the next. And it fails
 * *open*, unlike the send-path limiter, because this one protects our own
 * capacity rather than somebody else's sending reputation — a cache outage
 * must not become a product outage.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

function counting(over: Partial<{ current: number; previous: number; elapsed: number }> = {}) {
  const calls: { key: string; windowSeconds: number }[] = [];

  const store: RateLimitStore = {
    async hit(input) {
      calls.push({ key: input.key, windowSeconds: input.windowSeconds });
      return {
        currentCount: over.current ?? calls.length,
        previousCount: over.previous ?? 0,
        elapsedFraction: over.elapsed ?? 0.5,
      };
    },
  };

  return { store, calls };
}

function buildApp(
  store: RateLimitStore,
  options: { limit?: number; multiplier?: number; keyFor?: (req: Request) => string | null } = {},
): Express {
  const app = express();
  app.use(requestId);
  app.use(
    rateLimit({
      store,
      rule: { limit: options.limit ?? 10, windowSeconds: 60 },
      keyFor: options.keyFor ?? (() => 'rl:test'),
      now: () => NOW,
      ...(options.multiplier === undefined ? {} : { multiplier: () => options.multiplier as number }),
    }),
  );
  app.get('/thing', (_req: Request, res: Response) => {
    res.json({ data: { ok: true } });
  });
  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return app;
}

describe('the sliding window', () => {
  it('allows a caller under the limit', () => {
    expect(
      slidingWindowDecision({
        limit: 100,
        currentCount: 10,
        previousCount: 0,
        elapsedFraction: 0.5,
        windowSeconds: 60,
      }),
    ).toMatchObject({ allowed: true, remaining: 90 });
  });

  it('weights the previous window by how much of it is still in view', () => {
    // Half a window elapsed, so half of the previous window's 100 still
    // counts: 50 + 10 = 60 against a limit of 100.
    expect(
      slidingWindowDecision({
        limit: 100,
        currentCount: 10,
        previousCount: 100,
        elapsedFraction: 0.5,
        windowSeconds: 60,
      }),
    ).toMatchObject({ allowed: true, remaining: 40 });
  });

  it('rounds a fractional estimate against the caller', () => {
    // 10 + 100 * 0.495 = 59.5 used. Reporting 41 remaining rather than 40
    // hands back a request that does not exist, and a client pacing itself
    // off the header spends it.
    expect(
      slidingWindowDecision({
        limit: 100,
        currentCount: 10,
        previousCount: 100,
        elapsedFraction: 0.505,
        windowSeconds: 60,
      }).remaining,
    ).toBe(40);
  });

  it('refuses the burst a fixed window would allow', () => {
    // The whole point. A fixed window lets 100 land at 11:59:59 and another
    // 100 at 12:00:01. Here the first hundred still counts.
    expect(
      slidingWindowDecision({
        limit: 100,
        currentCount: 60,
        previousCount: 100,
        elapsedFraction: 0.05,
        windowSeconds: 60,
      }).allowed,
    ).toBe(false);
  });

  it('forgets the previous window once it has fully scrolled out', () => {
    expect(
      slidingWindowDecision({
        limit: 100,
        currentCount: 99,
        previousCount: 1_000,
        elapsedFraction: 1,
        windowSeconds: 60,
      }).allowed,
    ).toBe(true);
  });

  it('refuses at the limit, not one past it', () => {
    expect(
      slidingWindowDecision({
        limit: 10,
        currentCount: 10,
        previousCount: 0,
        elapsedFraction: 0.5,
        windowSeconds: 60,
      }).allowed,
    ).toBe(false);
  });

  it('allows the last request under the limit', () => {
    expect(
      slidingWindowDecision({
        limit: 10,
        currentCount: 9,
        previousCount: 0,
        elapsedFraction: 0.5,
        windowSeconds: 60,
      }).allowed,
    ).toBe(true);
  });

  it('never tells a caller to retry immediately', () => {
    // `Retry-After: 0` invites a retry that will also be refused. At the very
    // end of a window the arithmetic rounds to zero seconds, which is exactly
    // when the floor has to hold.
    const decision = slidingWindowDecision({
      limit: 10,
      currentCount: 10,
      previousCount: 0,
      elapsedFraction: 1,
      windowSeconds: 60,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('reports no remainder when it refuses', () => {
    expect(
      slidingWindowDecision({
        limit: 10,
        currentCount: 400,
        previousCount: 0,
        elapsedFraction: 0.5,
        windowSeconds: 60,
      }).remaining,
    ).toBe(0);
  });

  it('never reports more remaining than the limit', () => {
    // An elapsed fraction past 1 — a clock that moved, or a store that
    // computed it from a stale window — makes the previous window's weight
    // negative, and an unclamped estimate reads as "200 of your 100 requests
    // remain".
    const decision = slidingWindowDecision({
      limit: 100,
      currentCount: 0,
      previousCount: 100,
      elapsedFraction: 2,
      windowSeconds: 60,
    });

    expect(decision.remaining).toBeLessThanOrEqual(100);
  });

  it('clamps an elapsed fraction below zero', () => {
    // Below zero the previous window would count more than once.
    const clamped = slidingWindowDecision({
      limit: 100,
      currentCount: 0,
      previousCount: 100,
      elapsedFraction: -1,
      windowSeconds: 60,
    });

    expect(clamped.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe('the middleware', () => {
  it('allows and reports the remainder', async () => {
    const { store } = counting({ current: 1, previous: 0 });

    const res = await request(buildApp(store)).get('/thing');

    expect(res.status).toBe(200);
    expect(res.get('X-RateLimit-Limit')).toBe('10');
    expect(res.get('X-RateLimit-Remaining')).toBe('9');
  });

  it('sets the headers on an allowed request too', async () => {
    // A client that can see it has nine left can slow down. One that only
    // learns at the point of refusal cannot.
    const { store } = counting({ current: 1 });

    expect((await request(buildApp(store)).get('/thing')).get('X-RateLimit-Remaining')).toBe('9');
  });

  it('refuses with 429 and a Retry-After', async () => {
    const { store } = counting({ current: 10, previous: 0 });

    const res = await request(buildApp(store)).get('/thing');

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(Number(res.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('scales the budget by the plan multiplier', async () => {
    const { store } = counting({ current: 10, previous: 0 });

    const res = await request(buildApp(store, { multiplier: 5 })).get('/thing');

    expect(res.status).toBe(200);
    expect(res.get('X-RateLimit-Limit')).toBe('50');
  });

  it('never shrinks the budget below the base', async () => {
    const { store } = counting({ current: 1 });

    expect(
      (await request(buildApp(store, { multiplier: 0 })).get('/thing')).get('X-RateLimit-Limit'),
    ).toBe('10');
  });

  it('skips entirely when there is nothing to count', async () => {
    const { store, calls } = counting();

    const res = await request(buildApp(store, { keyFor: () => null })).get('/thing');

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('counts in one round trip', async () => {
    // Read-then-write is a race: concurrent requests all see the same count
    // and all decide they are under the limit.
    const hit = vi.fn(async () => ({ currentCount: 1, previousCount: 0, elapsedFraction: 0 }));

    await request(buildApp({ hit })).get('/thing');

    expect(hit).toHaveBeenCalledTimes(1);
  });
});

describe('when the store is unreachable', () => {
  it('allows the request', async () => {
    // Fails open, deliberately, and unlike the send-path limiter. This one
    // protects our capacity; refusing every request because a cache is down
    // turns a degraded dependency into an outage.
    const store: RateLimitStore = {
      async hit() {
        throw new Error('redis unreachable');
      },
    };

    expect((await request(buildApp(store)).get('/thing')).status).toBe(200);
  });

  it('sets no misleading headers', async () => {
    const store: RateLimitStore = {
      async hit() {
        throw new Error('redis unreachable');
      },
    };

    const res = await request(buildApp(store)).get('/thing');

    expect(res.get('X-RateLimit-Remaining')).toBeUndefined();
  });
});

describe('the budgets', () => {
  it('are the ones docs/06 sets', () => {
    // Pinned to literals. Everything else is written in terms of these, so
    // they all move together if one is edited and nothing notices.
    expect(RATE_LIMITS.user).toEqual({ limit: 100, windowSeconds: 60 });
    expect(RATE_LIMITS.apiKey).toEqual({ limit: 1_000, windowSeconds: 60 });
    expect(RATE_LIMITS.auth).toEqual({ limit: 10, windowSeconds: 60 });
    expect(RATE_LIMITS.passwordReset).toEqual({ limit: 5, windowSeconds: 3_600 });
    expect(RATE_LIMITS.tracking).toEqual({ limit: 20, windowSeconds: 1 });
  });

  it('give an API key more than a user', async () => {
    expect(RATE_LIMITS.apiKey.limit).toBeGreaterThan(RATE_LIMITS.user.limit);
  });
});

describe('the IP key', () => {
  it('uses the request address', () => {
    expect(ipRateKey('auth')({ ip: '203.0.113.5' } as Request)).toBe('rl:auth:203.0.113.5');
  });

  it('skips when there is no address', () => {
    expect(ipRateKey('auth')({ ip: undefined } as unknown as Request)).toBe(null);
    expect(ipRateKey('auth')({ ip: '' } as unknown as Request)).toBe(null);
  });
});
