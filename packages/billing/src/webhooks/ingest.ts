import type { NormalisedBillingEvent, ObjectType } from '../port.js';

/**
 * The billing webhook path (INVARIANTS R17; review findings F17, F18).
 *
 * Four guarantees, each from a different mechanism, and the design is mostly
 * about keeping them separate:
 *
 *   **No duplicate processing** — the unique index on
 *   `(provider, provider_event_id)`. Stripe retries; the second delivery
 *   inserts nothing and does nothing.
 *
 *   **No lost events** — the inbox row commits before the 200 is returned.
 *   A crash after the 200 loses nothing, because the row is already there and
 *   the object is already marked dirty.
 *
 *   **No out-of-order regression** — the handler re-fetches the object and
 *   compares its version to `provider_state_version`. The event is a trigger,
 *   never data. `subscription.updated` (plan A) arriving after
 *   `subscription.updated` (plan B) is routine, and re-fetching makes the
 *   handler convergent: whatever order events arrive in, we write the
 *   provider's current truth.
 *
 *   **No API storm** — R17/F17. The handler never fetches inline. It marks
 *   the object dirty in `billing_refetch_queue`, one row per *object* rather
 *   than per event, and a separate consumer fetches each at most once per 30
 *   seconds. Five hundred events for ten objects become ten API calls rather
 *   than five hundred inside five hundred HTTP handlers.
 *
 * That last one is why this file is split from the one that applies the
 * change. The ingest path does almost nothing on purpose.
 */

/** R17's bound. The consumer refuses to fetch an object it fetched more recently. */
export const REFETCH_COOLDOWN_MS = 30_000;

export interface IngestPort {
  /**
   * Inserts the inbox row, `ON CONFLICT DO NOTHING`.
   *
   * Returns false when the row already existed, which is a duplicate
   * delivery and means everything below has already happened.
   */
  insertInboxEvent(input: {
    providerEventId: string;
    eventType: string;
    workspaceId: string | null;
    payload: unknown;
  }): Promise<boolean>;

  /**
   * Marks an object dirty. One row per object; `dirty_count` increments.
   *
   * `ON CONFLICT ... DO UPDATE SET dirty_count = dirty_count + 1,
   *  last_dirty_at = now()` — which is the whole coalescing mechanism.
   */
  markDirty(input: {
    objectType: ObjectType;
    providerObjectId: string;
    workspaceId: string | null;
  }): Promise<void>;
}

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  marked: boolean;
  reason?: string;
}

/**
 * Handles one verified webhook.
 *
 * Signature verification happens before this, at the adapter boundary, so
 * anything reaching here is authentic. What this does is exactly two writes
 * and nothing else — no Stripe call, no entitlement rebuild, no branching on
 * the event type. The 200 has to be under 200ms and a handler that does real
 * work cannot promise that.
 */
export async function ingestBillingEvent(
  event: NormalisedBillingEvent,
  port: IngestPort,
): Promise<IngestResult> {
  const inserted = await port.insertInboxEvent({
    providerEventId: event.providerEventId,
    eventType: event.type,
    workspaceId: event.workspaceId,
    payload: event.payload,
  });

  if (!inserted) {
    // A retry. The first delivery already marked the object dirty, and
    // marking it again would inflate `dirty_count` without changing what the
    // consumer does.
    return { accepted: true, duplicate: true, marked: false };
  }

  if (event.objectType === null || event.providerObjectId === null) {
    // An event about nothing we mirror — `customer.discount.created`, a
    // `ping`. Stored for the record, and deliberately not an error: refusing
    // it would make Stripe retry something we will never process.
    return {
      accepted: true,
      duplicate: false,
      marked: false,
      reason: 'no object to refetch',
    };
  }

  await port.markDirty({
    objectType: event.objectType,
    providerObjectId: event.providerObjectId,
    workspaceId: event.workspaceId,
  });

  return { accepted: true, duplicate: false, marked: true };
}

export interface DirtyObject {
  objectType: ObjectType;
  providerObjectId: string;
  workspaceId: string | null;
  dirtyCount: number;
  lastDirtyAt: Date;
  lastFetchedAt: Date | null;
  fetchFailures: number;
}

/**
 * Whether an object is due a fetch.
 *
 * Two conditions, and both matter. It must have been dirtied since the last
 * fetch — otherwise a queue that never empties re-fetches everything forever
 * — and the cooldown must have elapsed, which is the rate bound R17 asks for.
 */
export function isDueForRefetch(
  object: DirtyObject,
  input: { now: Date; cooldownMs?: number },
): boolean {
  if (object.lastFetchedAt === null) return true;

  const cooldown = input.cooldownMs ?? REFETCH_COOLDOWN_MS;
  const elapsed = input.now.getTime() - object.lastFetchedAt.getTime();
  if (elapsed < cooldown) return false;

  // Dirtied since we last looked. Without this, an object fetched once and
  // never touched again would be fetched every 30 seconds forever.
  return object.lastDirtyAt.getTime() > object.lastFetchedAt.getTime();
}

/**
 * How long to back off after a failed fetch.
 *
 * Exponential from the cooldown, capped. A Stripe outage would otherwise have
 * every dirty object retrying every 30 seconds, which is the load pattern
 * most likely to keep us rate-limited once it recovers.
 */
export const MAX_REFETCH_BACKOFF_MS = 30 * 60_000;

export function refetchBackoffMs(failures: number): number {
  if (failures <= 0) return REFETCH_COOLDOWN_MS;
  return Math.min(REFETCH_COOLDOWN_MS * 2 ** failures, MAX_REFETCH_BACKOFF_MS);
}

/**
 * Whether a fetched object is newer than what we hold.
 *
 * Strictly greater. An equal version means we have already applied this
 * state, and re-applying it would rewrite `updated_at` on every duplicate
 * delivery — which turns the column from evidence into noise.
 */
export function isNewerThanStored(input: {
  fetchedVersion: number;
  storedVersion: number;
}): boolean {
  return input.fetchedVersion > input.storedVersion;
}
