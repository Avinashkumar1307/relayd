import {
  isDueForRefetch,
  isNewerThanStored,
  refetchBackoffMs,
  type DirtyObject,
} from './ingest.js';
import type { BillingProviderAdapter, ObjectType } from '../port.js';

/**
 * The coalesced re-fetch consumer (INVARIANTS R17, review finding F17).
 *
 * The ingest route stores the event and marks its object dirty. This is the
 * other half: for each dirty object, at most once per 30 seconds, fetch the
 * provider's current state and write it.
 *
 * **The event is a trigger, never data.** Nothing here reads the webhook
 * payload to decide anything. That is what makes out-of-order delivery a
 * non-event: `subscription.updated` (plan A) arriving after
 * `subscription.updated` (plan B) is routine and unordered by design, and a
 * handler that applied payloads would write whichever arrived last. A handler
 * that re-fetches writes what is true.
 *
 * **Five hundred events become ten API calls.** One row per object rather
 * than per event, and the cooldown bounds the rate. At the monthly billing
 * boundary that is the difference between staying inside Stripe's read budget
 * and spending the morning rate-limited.
 *
 * **A write can still lose.** Two consumers, or a consumer racing the nightly
 * reconciler, both fetch and both write. `provider_state_version` decides: a
 * write whose version is not strictly greater than the stored one is
 * discarded, so the older answer cannot overwrite the newer one no matter
 * which finished first.
 */

export type RefetchOutcome =
  | 'applied'
  | 'discarded_stale'
  | 'not_due'
  | 'gone'
  | 'unsupported'
  | 'failed';

export interface RefetchResult {
  providerObjectId: string;
  outcome: RefetchOutcome;
  /** Set when the object should be retried later rather than cleared. */
  retryAfterMs?: number;
  error?: string;
}

export interface RefetchPort {
  /** Dirty objects, oldest first, bounded. */
  claimDirtyObjects(input: { now: Date; limit: number }): Promise<DirtyObject[]>;

  /** The version we currently hold for this object, or 0 if we hold none. */
  storedVersion(input: { objectType: ObjectType; providerObjectId: string }): Promise<number>;

  /**
   * Writes the provider's state, guarded on the version.
   *
   * Returns false when a newer version was already stored, which is a lost
   * race and not an error.
   */
  applySubscription(input: {
    providerObjectId: string;
    subscription: unknown;
    stateVersion: number;
    expectedBelowVersion: number;
  }): Promise<boolean>;

  applyInvoice(input: {
    providerObjectId: string;
    invoice: unknown;
    stateVersion: number;
    expectedBelowVersion: number;
  }): Promise<boolean>;

  applyCustomer(input: { providerObjectId: string; customer: unknown }): Promise<boolean>;

  /** Clears the dirty row after a successful fetch. */
  markFetched(input: {
    objectType: ObjectType;
    providerObjectId: string;
    fetchedAt: Date;
  }): Promise<void>;

  /** Records a failure and the backoff it earned. */
  markFetchFailed(input: {
    objectType: ObjectType;
    providerObjectId: string;
    fetchedAt: Date;
    failures: number;
    error: string;
  }): Promise<void>;
}

/** Object types this consumer knows how to fetch. */
const SUPPORTED: ReadonlySet<ObjectType> = new Set<ObjectType>([
  'subscription',
  'invoice',
  'customer',
]);

/**
 * Re-fetches one dirty object.
 *
 * Every branch either clears the row or schedules a retry. A branch that does
 * neither leaves the object dirty forever, which looks like a stuck queue and
 * is the failure mode most likely to be mistaken for a backlog.
 */
export async function refetchObject(
  object: DirtyObject,
  input: { now: Date; cooldownMs?: number },
  port: RefetchPort,
  provider: BillingProviderAdapter,
): Promise<RefetchResult> {
  const due = isDueForRefetch(object, {
    now: input.now,
    ...(input.cooldownMs === undefined ? {} : { cooldownMs: input.cooldownMs }),
  });

  if (!due) {
    return {
      providerObjectId: object.providerObjectId,
      outcome: 'not_due',
      retryAfterMs: refetchBackoffMs(object.fetchFailures),
    };
  }

  if (!SUPPORTED.has(object.objectType)) {
    // A payment method, a charge. Marked fetched rather than left dirty:
    // nothing will ever fetch it, and an unfetchable row that stays dirty is
    // a queue that never drains.
    await port.markFetched({
      objectType: object.objectType,
      providerObjectId: object.providerObjectId,
      fetchedAt: input.now,
    });

    return { providerObjectId: object.providerObjectId, outcome: 'unsupported' };
  }

  try {
    const applied = await applyOne(object, port, provider);

    await port.markFetched({
      objectType: object.objectType,
      providerObjectId: object.providerObjectId,
      fetchedAt: input.now,
    });

    return { providerObjectId: object.providerObjectId, outcome: applied };
  } catch (error) {
    const failures = object.fetchFailures + 1;
    const message = error instanceof Error ? error.message : 'unknown';

    await port.markFetchFailed({
      objectType: object.objectType,
      providerObjectId: object.providerObjectId,
      fetchedAt: input.now,
      failures,
      error: message,
    });

    return {
      providerObjectId: object.providerObjectId,
      outcome: 'failed',
      retryAfterMs: refetchBackoffMs(failures),
      error: message,
    };
  }
}

async function applyOne(
  object: DirtyObject,
  port: RefetchPort,
  provider: BillingProviderAdapter,
): Promise<'applied' | 'discarded_stale' | 'gone'> {
  if (object.objectType === 'customer') {
    const customer = await provider.fetchCustomer(object.providerObjectId);
    // A deleted customer is not an error and not something to retry. It is a
    // fact, and the local row records it.
    if (customer === null) return 'gone';

    await port.applyCustomer({
      providerObjectId: object.providerObjectId,
      customer,
    });
    return 'applied';
  }

  const stored = await port.storedVersion({
    objectType: object.objectType,
    providerObjectId: object.providerObjectId,
  });

  if (object.objectType === 'subscription') {
    const subscription = await provider.fetchSubscription(object.providerObjectId);
    if (subscription === null) return 'gone';

    if (!isNewerThanStored({ fetchedVersion: subscription.stateVersion, storedVersion: stored })) {
      // Somebody already wrote this or something newer. Re-applying would
      // rewrite `updated_at` on every duplicate delivery, which turns the
      // column from evidence into noise.
      return 'discarded_stale';
    }

    const applied = await port.applySubscription({
      providerObjectId: object.providerObjectId,
      subscription,
      stateVersion: subscription.stateVersion,
      expectedBelowVersion: stored,
    });

    // The guard is in the database too, and it is the one that actually
    // holds: two consumers can both pass the check above and only one write
    // can win.
    return applied ? 'applied' : 'discarded_stale';
  }

  const invoice = await provider.fetchInvoice(object.providerObjectId);
  if (invoice === null) return 'gone';

  if (!isNewerThanStored({ fetchedVersion: invoice.stateVersion, storedVersion: stored })) {
    return 'discarded_stale';
  }

  const applied = await port.applyInvoice({
    providerObjectId: object.providerObjectId,
    invoice,
    stateVersion: invoice.stateVersion,
    expectedBelowVersion: stored,
  });

  return applied ? 'applied' : 'discarded_stale';
}

export interface RefetchBatchResult {
  claimed: number;
  applied: number;
  discarded: number;
  failed: number;
  results: RefetchResult[];
}

/**
 * One pass of the consumer.
 *
 * A failure on one object does not stop the batch. One subscription belonging
 * to a deleted Stripe account must not hold up every other customer's billing
 * state, and that is exactly the row most likely to fail repeatedly.
 */
export async function refetchBatch(
  input: { now: Date; limit?: number; cooldownMs?: number },
  port: RefetchPort,
  provider: BillingProviderAdapter,
): Promise<RefetchBatchResult> {
  const limit = Math.max(1, Math.floor(input.limit ?? 100));
  const objects = await port.claimDirtyObjects({ now: input.now, limit });

  const result: RefetchBatchResult = {
    claimed: objects.length,
    applied: 0,
    discarded: 0,
    failed: 0,
    results: [],
  };

  for (const object of objects) {
    const one = await refetchObject(
      object,
      {
        now: input.now,
        ...(input.cooldownMs === undefined ? {} : { cooldownMs: input.cooldownMs }),
      },
      port,
      provider,
    );

    result.results.push(one);
    if (one.outcome === 'applied') result.applied += 1;
    if (one.outcome === 'discarded_stale') result.discarded += 1;
    if (one.outcome === 'failed') result.failed += 1;
  }

  return result;
}
