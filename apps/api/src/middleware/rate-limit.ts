import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@relayd/types';
import { tryGetApiKeyPrincipal, tryGetPrincipal, tryGetWorkspaceContext } from '../context.js';

/**
 * Rate limiting (docs/06 section 15).
 *
 * The budgets docs/06 sets: 100 requests per minute per user, 1000 per minute
 * per API key scaled by plan, 10 per minute per IP on auth, 5 per hour on
 * password reset.
 *
 * ## Why it fails open, and what that means
 *
 * If Redis is unreachable this allows the request. That is the opposite of
 * the send-path limiter, which fails closed and refuses to send — and the
 * difference is what the limiter is protecting.
 *
 * The send limiter protects *someone else's* reputation and quota: sending
 * when we cannot count is how a customer's SES account gets suspended, so not
 * sending is the safe answer. This limiter protects our own capacity, and
 * refusing every request in the product because a cache is down turns a
 * degraded dependency into an outage. A brief window of unlimited requests is
 * recoverable; an hour of 429s to every paying customer is not.
 *
 * The counter is therefore an availability control with a security benefit,
 * not a security control. Anything that must hold when Redis is down — the
 * permission matrix, RLS, the entitlement gate — holds in Postgres.
 *
 * ## Why a sliding window rather than a fixed one
 *
 * A fixed window lets a caller spend the whole budget in the last second of
 * one window and the whole budget in the first second of the next: 2000
 * requests in two seconds against a limit of 1000 per minute. The weighted
 * sliding window below costs two counters and removes the doubling.
 */

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the caller may retry. Zero when allowed. */
  retryAfterSeconds: number;
}

/**
 * The weighted sliding window.
 *
 * The estimate is this window's count plus the previous window's count scaled
 * by how much of the previous window is still inside the trailing minute. It
 * is an approximation — it assumes the previous window's requests were spread
 * evenly — and it is the standard one, because the exact version needs every
 * timestamp rather than two integers.
 */
export function slidingWindowDecision(input: {
  limit: number;
  currentCount: number;
  previousCount: number;
  /** How far into the current window we are, 0 to 1. */
  elapsedFraction: number;
  windowSeconds: number;
}): RateLimitDecision {
  const limit = Math.max(0, Math.trunc(input.limit));
  const elapsed = Math.min(1, Math.max(0, input.elapsedFraction));

  const estimate = input.currentCount + input.previousCount * (1 - elapsed);

  // Cannot go negative: `elapsed` is clamped to [0, 1] above and the counts
  // are non-negative, so `estimate` is non-negative, and this is only read on
  // the branch where `estimate < limit`. A `Math.max(0, ...)` here looked
  // prudent and was unreachable.
  const remaining = limit - Math.ceil(estimate);

  if (estimate < limit) {
    return { allowed: true, limit, remaining, retryAfterSeconds: 0 };
  }

  // Until the current window rolls. Rounded up and floored at one, because a
  // `Retry-After: 0` invites an immediate retry that will also be refused.
  const remainingWindow = Math.ceil(input.windowSeconds * (1 - elapsed));

  return {
    allowed: false,
    limit,
    remaining: 0,
    retryAfterSeconds: Math.max(1, remainingWindow),
  };
}

export interface RateLimitStore {
  /**
   * Increments the current window and reports both counters.
   *
   * One round trip. Two — read then write — is a race that lets concurrent
   * requests each see the same count and all decide they are under the limit.
   */
  hit(input: {
    key: string;
    windowSeconds: number;
    now: Date;
  }): Promise<{ currentCount: number; previousCount: number; elapsedFraction: number }>;
}

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
}

/** docs/06's budgets. */
export const RATE_LIMITS = {
  user: { limit: 100, windowSeconds: 60 },
  apiKey: { limit: 1_000, windowSeconds: 60 },
  auth: { limit: 10, windowSeconds: 60 },
  passwordReset: { limit: 5, windowSeconds: 3_600 },
  tracking: { limit: 20, windowSeconds: 1 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitOptions {
  store: RateLimitStore;
  rule: RateLimitRule;
  /**
   * What is being counted. Returning null skips the limiter entirely, which
   * is how an unauthenticated route opts out of a per-user budget.
   */
  keyFor: (req: Request) => string | null;
  now?: () => Date;
  /** Plan multiplier, applied to the API key budget. Defaults to 1. */
  multiplier?: (req: Request) => number;
}

/**
 * One limiter.
 *
 * The headers go on every response, not only on a 429: a client that can see
 * it has eleven requests left can slow down, and one that only learns at the
 * point of refusal cannot.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? (() => new Date());

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = options.keyFor(req);
    if (key === null) {
      next();
      return;
    }

    const multiplier = Math.max(1, options.multiplier?.(req) ?? 1);
    const limit = options.rule.limit * multiplier;

    let counts: Awaited<ReturnType<RateLimitStore['hit']>>;
    try {
      counts = await options.store.hit({
        key,
        windowSeconds: options.rule.windowSeconds,
        now: now(),
      });
    } catch {
      // Fails open. See the note at the top: this protects our capacity, and
      // a cache outage must not become a product outage.
      next();
      return;
    }

    const decision = slidingWindowDecision({
      limit,
      currentCount: counts.currentCount,
      previousCount: counts.previousCount,
      elapsedFraction: counts.elapsedFraction,
      windowSeconds: options.rule.windowSeconds,
    });

    res.set('X-RateLimit-Limit', String(decision.limit));
    res.set('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      res.set('Retry-After', String(decision.retryAfterSeconds));
      next(
        new AppError(
          'rate_limited',
          'Too many requests. Slow down and try again shortly.',
          429,
        ),
      );
      return;
    }

    next();
  };
}

/**
 * The key a request counts against.
 *
 * An API key first, because a key's budget is its own and must not be shared
 * with the person who minted it. Then the user. Then the workspace, for a
 * request that has one and neither of the above — which should not happen and
 * is counted rather than dropped so it shows up.
 */
export function principalRateKey(req: Request): string | null {
  const apiKey = tryGetApiKeyPrincipal();
  if (apiKey !== undefined) return `rl:key:${apiKey.keyId}`;

  const principal = tryGetPrincipal();
  if (principal !== undefined) return `rl:user:${principal.userId}`;

  const workspace = tryGetWorkspaceContext();
  if (workspace !== undefined) return `rl:ws:${workspace.scope.workspaceId}`;

  void req;
  return null;
}

/**
 * The client address, for unauthenticated routes.
 *
 * `req.ip` rather than the raw socket, so a deployment behind a load balancer
 * with `trust proxy` set counts the client and not the balancer — which would
 * otherwise put every customer in one bucket.
 */
export function ipRateKey(prefix: string): (req: Request) => string | null {
  return (req: Request) => {
    const ip = req.ip;
    return ip === undefined || ip.length === 0 ? null : `rl:${prefix}:${ip}`;
  };
}
