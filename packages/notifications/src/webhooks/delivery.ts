import { signWebhook, EVENT_ID_HEADER, SIGNATURE_HEADER } from '@relayd/utils';

/**
 * Outbound webhook delivery (BUILD-PLAN Phase 9, docs/02 platform tables).
 *
 * An integrator subscribes an endpoint to a set of event types and we POST to
 * it. Everything interesting is about failure, because the endpoint belongs
 * to somebody else and will be down at some point.
 *
 * Four rules:
 *
 *   **The event id is stable across retries.** It is in the payload and in a
 *   header, so a consumer deduplicates on it. A retry that changed the id
 *   would make at-least-once delivery useless to them — they would have no
 *   way to tell a retry from a second event.
 *
 *   **Backoff is exponential and jittered.** Unjittered, every delivery
 *   queued during an outage retries at the same instant when it ends, and the
 *   endpoint that just came back goes down again. That is our thundering herd
 *   landing on somebody else's server.
 *
 *   **Sustained failure disables, and says so.** An endpoint returning 500 for
 *   a week is a cost we carry for nothing. `failing` first, so a customer
 *   whose endpoint was down for an hour is not treated like one whose
 *   endpoint has been gone since March.
 *
 *   **A 4xx is not retried, except 408 and 429.** A 400 means the payload is
 *   wrong and it will be wrong next time too; retrying it twelve times is
 *   twelve identical rejections. 408 and 429 are the two that mean "not now"
 *   rather than "not ever".
 */

export type DeliveryOutcome = 'delivered' | 'retry' | 'permanent_failure';

/** Attempts before a delivery is abandoned. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** Consecutive failures before an endpoint is marked `failing`. */
export const FAILING_THRESHOLD = 5;

/** Consecutive failures before an endpoint is disabled outright. */
export const DISABLE_THRESHOLD = 50;

/** The first retry delay, doubled each attempt. */
export const BASE_BACKOFF_MS = 10_000;

/** The ceiling, so the eighth attempt is not next week. */
export const MAX_BACKOFF_MS = 6 * 3_600_000;

/** How long the previous signing secret stays live after a rotation. */
export const SECRET_OVERLAP_MS = 24 * 3_600_000;

/**
 * Whether a response means try again.
 *
 * A network error has no status and is always retryable: it is the case where
 * we do not know whether the request arrived, and the consumer deduplicating
 * on the event id is what makes trying again safe.
 */
export function classifyResponse(input: { status: number | null }): DeliveryOutcome {
  const status = input.status;

  if (status === null) return 'retry';
  if (status >= 200 && status < 300) return 'delivered';

  // The two 4xx codes that mean "not now" rather than "not ever".
  if (status === 408 || status === 429) return 'retry';

  // Everything else in the 4xx range is the consumer telling us the request
  // is wrong. It will be wrong next time.
  if (status >= 400 && status < 500) return 'permanent_failure';

  return 'retry';
}

/**
 * When to try again.
 *
 * Exponential from `BASE_BACKOFF_MS`, capped, with jitter applied to the
 * whole delay rather than added on top — added jitter only ever lengthens,
 * and the point is to *spread* a cohort rather than delay it.
 */
export function backoffMs(
  attempt: number,
  options: { random?: () => number; baseMs?: number; maxMs?: number } = {},
): number {
  const base = options.baseMs ?? BASE_BACKOFF_MS;
  const max = options.maxMs ?? MAX_BACKOFF_MS;
  const random = options.random ?? Math.random;

  const exponent = Math.max(0, Math.trunc(attempt) - 1);
  const uncapped = base * 2 ** Math.min(exponent, 30);
  const capped = Math.min(max, uncapped);

  // Full jitter: anywhere in [base, capped]. A cohort released by an endpoint
  // recovering is spread across the window instead of arriving together.
  const floor = Math.min(base, capped);
  return Math.round(floor + random() * (capped - floor));
}

export interface EndpointHealth {
  status: 'active' | 'paused' | 'failing' | 'disabled';
  consecutiveFailures: number;
}

/**
 * The endpoint's status after one delivery outcome.
 *
 * `paused` is the customer's choice and is never changed here — a paused
 * endpoint that silently reactivated because a stray delivery succeeded would
 * be the product overruling them.
 */
export function nextEndpointHealth(
  current: EndpointHealth,
  outcome: DeliveryOutcome,
  thresholds: { failing?: number; disable?: number } = {},
): EndpointHealth {
  if (current.status === 'paused' || current.status === 'disabled') return current;

  if (outcome === 'delivered') {
    // One success clears the count. A consumer who fixed their endpoint is
    // not on probation, and leaving the count to decay would disable them for
    // an outage they already resolved.
    return { status: 'active', consecutiveFailures: 0 };
  }

  const failures = current.consecutiveFailures + 1;
  const failing = thresholds.failing ?? FAILING_THRESHOLD;
  const disable = thresholds.disable ?? DISABLE_THRESHOLD;

  if (failures >= disable) return { status: 'disabled', consecutiveFailures: failures };
  if (failures >= failing) return { status: 'failing', consecutiveFailures: failures };

  return { status: current.status === 'failing' ? 'failing' : 'active', consecutiveFailures: failures };
}

/** Whether an endpoint should receive an event at all. */
export function shouldDeliver(input: {
  status: EndpointHealth['status'];
  subscribedEvents: readonly string[];
  eventType: string;
}): boolean {
  if (input.status !== 'active' && input.status !== 'failing') return false;

  // `*` subscribes to everything, including event types added later. Without
  // it every new event type is a support conversation with every integrator.
  return input.subscribedEvents.includes('*') || input.subscribedEvents.includes(input.eventType);
}

/**
 * The secrets a delivery signs with, and a verifier should accept.
 *
 * The current one first. The previous one stays live for the overlap window
 * so an integrator who has not redeployed keeps verifying — a rotation with
 * no overlap breaks every consumer at the instant it lands, which makes
 * rotation something nobody does.
 */
export function activeSecrets(input: {
  secret: string;
  previousSecret: string | null;
  rotatedAt: Date | null;
  now: Date;
  overlapMs?: number;
}): string[] {
  const secrets = [input.secret];
  if (input.previousSecret === null || input.rotatedAt === null) return secrets;

  const overlap = input.overlapMs ?? SECRET_OVERLAP_MS;
  if (input.now.getTime() - input.rotatedAt.getTime() < overlap) {
    secrets.push(input.previousSecret);
  }

  return secrets;
}

export interface DeliveryRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The HTTP request for one delivery.
 *
 * The body is serialised once and signed as serialised. Signing a structure
 * and serialising it again is how a signature stops matching for reasons
 * nobody can reproduce.
 */
export function buildDelivery(input: {
  url: string;
  secret: string;
  eventId: string;
  eventType: string;
  occurredAt: Date;
  data: unknown;
  at: Date;
  attempt: number;
}): DeliveryRequest {
  const body = JSON.stringify({
    id: input.eventId,
    type: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    data: input.data,
  });

  const signed = signWebhook({ body, secret: input.secret, at: input.at });

  return {
    url: input.url,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signed.header,
      // The id in a header as well as the body, so a consumer can deduplicate
      // before parsing — which is what they will want to do under load.
      [EVENT_ID_HEADER]: input.eventId,
      'relayd-event-type': input.eventType,
      'relayd-delivery-attempt': String(Math.max(1, Math.trunc(input.attempt))),
      'user-agent': 'Relayd/1.0',
    },
    body,
  };
}

export interface AttemptResult {
  outcome: DeliveryOutcome;
  /** Null when the delivery is finished, one way or the other. */
  retryAfterMs: number | null;
  attempt: number;
  abandoned: boolean;
}

/**
 * What to record after one attempt.
 *
 * `abandoned` rather than `failed` once the attempts run out: the distinction
 * is what lets the UI say "we stopped trying" instead of "it failed", which
 * are different things to the person reading it.
 */
export function nextAttempt(input: {
  attempt: number;
  outcome: DeliveryOutcome;
  maxAttempts?: number;
  random?: () => number;
}): AttemptResult {
  const attempt = Math.max(1, Math.trunc(input.attempt));
  const maxAttempts = input.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;

  if (input.outcome === 'delivered') {
    return { outcome: 'delivered', retryAfterMs: null, attempt, abandoned: false };
  }

  if (input.outcome === 'permanent_failure') {
    return { outcome: 'permanent_failure', retryAfterMs: null, attempt, abandoned: true };
  }

  if (attempt >= maxAttempts) {
    return { outcome: 'retry', retryAfterMs: null, attempt, abandoned: true };
  }

  return {
    outcome: 'retry',
    retryAfterMs: backoffMs(attempt, input.random === undefined ? {} : { random: input.random }),
    attempt,
    abandoned: false,
  };
}

/**
 * Truncates a response body before it is stored.
 *
 * An endpoint returning a 2MB HTML error page must not be able to fill the
 * delivery table one failure at a time.
 */
export const MAX_STORED_RESPONSE_BYTES = 2_048;

export function truncateResponse(body: string, limit = MAX_STORED_RESPONSE_BYTES): string {
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}… [truncated]`;
}
