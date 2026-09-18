/**
 * Day bucketing, and what happens to an event that arrives late.
 *
 * Two questions that look trivial and are not.
 *
 * **Which day does an event belong to?** The one its `occurred_at` falls in,
 * in UTC. Not the day it was received, and not the day it was in the
 * workspace's timezone. Storing a local day means every row is wrong the
 * moment a workspace changes timezone, and there is no way to fix it
 * afterwards because the original offset was never stored. Presentation
 * converts; storage does not.
 *
 * **What about an event that arrives after its day has been rolled up?** A
 * provider batching callbacks, a webhook retried after an outage, a bounce
 * that took six hours to come back — all routine. The hourly pass recomputes
 * a window rather than advancing a watermark, so a late event is counted as
 * long as it lands inside that window. Outside it, it is counted in
 * `email_events` and missing from the rollup, which is the one gap this
 * design accepts and the reason the window is generous.
 */

/** The UTC day an event belongs to, as `YYYY-MM-DD`. */
export function dayBucket(occurredAt: Date): string {
  return occurredAt.toISOString().slice(0, 10);
}

/**
 * Whether a late-arriving event will still be picked up.
 *
 * The question an operator asks when a provider apologises for a six-hour
 * callback delay: did we count them, or do we need a backfill?
 */
export function willBeCounted(input: {
  occurredAt: Date;
  now: Date;
  windowMs: number;
}): boolean {
  const since = input.now.getTime() - input.windowMs;
  // Events from the future are counted too. Clock skew between a provider and
  // us is common, and refusing them would silently drop real deliveries.
  return input.occurredAt.getTime() >= since;
}

/**
 * How wide a window a backfill needs to reach a given event.
 *
 * Rounded up to whole hours, because that is the unit the job is configured
 * in and an operator asked for "26.4 hours" will type 26.
 */
export function backfillWindowFor(input: { oldestEvent: Date; now: Date }): number {
  const elapsed = input.now.getTime() - input.oldestEvent.getTime();
  if (elapsed <= 0) return 0;

  return Math.ceil(elapsed / 3_600_000) * 3_600_000;
}

/**
 * The day range a window covers.
 *
 * A window that starts at 23:00 and runs 26 hours touches three days, and a
 * rollup that wrote only the first and last would leave the middle one stale
 * — so the daily pass has to know every day the window overlaps, not just its
 * endpoints.
 */
export function daysInWindow(input: { since: Date; until: Date }): string[] {
  if (input.since.getTime() > input.until.getTime()) return [];

  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(
      input.since.getUTCFullYear(),
      input.since.getUTCMonth(),
      input.since.getUTCDate(),
    ),
  );

  // Bounded: a backfill window of years would otherwise build a list nobody
  // wants in memory, and the caller is better told to narrow it.
  for (let i = 0; i < 400 && cursor.getTime() <= input.until.getTime(); i += 1) {
    days.push(dayBucket(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}
