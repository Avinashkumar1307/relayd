/**
 * The new-workspace ramp (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
 *
 * docs/06, the two rules this file implements:
 *
 *   "Email verification before any send; disposable-domain blocklist; no
 *   sending until a sender identity is verified."
 *
 *   "First 7 days capped at 500 emails/day regardless of plan, lifted
 *   automatically on clean metrics or manually on request."
 *
 * And from the same table, the consequence for routing: a workspace still in
 * its ramp is excluded from shared pool routing.
 *
 * ## Why "regardless of plan" is load-bearing
 *
 * The cap is not an entitlement. Entitlements come from the subscription and
 * a spammer can buy the largest one with a stolen card — which is the
 * cheapest way to bypass any limit derived from what they paid for. The ramp
 * is derived from *time* and *behaviour*, neither of which is purchasable.
 *
 * So this check is deliberately not in `packages/billing`, does not read a
 * plan, and is applied after the entitlement check rather than instead of
 * it. Both have to pass.
 *
 * ## Everything here is pure
 *
 * The decisions are functions of (workspace age, trust row, sent today,
 * clock). The I/O is in the repository and the wiring is in the launch and
 * dispatch paths, so the policy can be tested exhaustively without a
 * database — which matters, because the interesting cases are boundaries and
 * clock arithmetic.
 */

/** docs/06: "First 7 days". */
export const RAMP_DAYS = 7;

/** docs/06: "capped at 500 emails/day regardless of plan". */
export const RAMP_DAILY_CAP = 500;

/**
 * How clean a workspace's first week must be for the automatic lift.
 *
 * Tighter than the 0.3% auto-pause threshold and the 5% bounce threshold,
 * because this is the bar for being *trusted more*, not the bar for being
 * stopped. A workspace sitting just under the pause threshold has not earned
 * an unlimited send rate.
 */
export const AUTO_LIFT_MAX_COMPLAINT_RATE = 0.001;
export const AUTO_LIFT_MAX_BOUNCE_RATE = 0.02;

/** Below this, the rates are noise and the lift waits for more evidence. */
export const AUTO_LIFT_MIN_SENDS = 100;

export interface WorkspaceTrust {
  /** Null while still ramped. */
  rampLiftedAt: Date | null;
  rampLiftedBy: 'automatic' | 'operator' | null;
  /** An operator's deliberate extension. Overrides the age check. */
  rampUntil: Date | null;
}

export interface RampSubject {
  workspaceId: string;
  createdAt: Date;
  /** Null when the workspace has no trust row yet. */
  trust: WorkspaceTrust | null;
}

/** Whole days elapsed, floored. */
export function ageInDays(createdAt: Date, now: Date): number {
  const ms = now.getTime() - createdAt.getTime();
  // A workspace whose `created_at` is in the future — clock skew between the
  // app and the database — is zero days old, not negative. A negative age
  // would compare as "older than 7 days" against nothing, and skew is
  // exactly the condition under which a check should tighten rather than
  // relax.
  if (ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}

/**
 * Whether the workspace is still ramped.
 *
 * Order matters and is the whole function:
 *
 *   1. An operator's `rampUntil` in the future wins over everything. It is
 *      how somebody says "this one looks wrong, keep it capped" about a
 *      workspace that is technically old enough.
 *   2. A lift wins over age. A workspace lifted on day 3 is not re-ramped.
 *   3. Otherwise, age.
 *
 * Checking the lift before `rampUntil` would let a workspace lifted last
 * month ignore an extension applied this morning, which is the sequence an
 * operator actually types during an investigation.
 */
export function isInRamp(subject: RampSubject, now: Date): boolean {
  const until = subject.trust?.rampUntil ?? null;
  if (until !== null && until.getTime() > now.getTime()) return true;

  if (subject.trust?.rampLiftedAt != null) return false;

  return ageInDays(subject.createdAt, now) < RAMP_DAYS;
}

/** The cap in effect, or null when there is none. */
export function rampCapFor(subject: RampSubject, now: Date): number | null {
  return isInRamp(subject, now) ? RAMP_DAILY_CAP : null;
}

/**
 * docs/06: a ramped workspace is excluded from shared pool routing.
 *
 * A shared pool spreads a workspace's reputation damage across every other
 * workspace using it. A brand-new account is precisely the one whose
 * reputation is unknown, so it sends on its own connection until it has a
 * record.
 */
export function excludedFromPoolRouting(subject: RampSubject, now: Date): boolean {
  return isInRamp(subject, now);
}

export type SendGate =
  | { allowed: true; remaining: number | null }
  | { allowed: false; reason: 'ramp_cap_reached'; cap: number; sentToday: number };

/**
 * How many more this workspace may send today.
 *
 * `remaining: null` means uncapped. Callers must distinguish that from 0 —
 * treating null as "no remaining" would stop every established workspace,
 * and treating 0 as "no cap" would stop none.
 */
export function sendGate(subject: RampSubject, sentToday: number, now: Date): SendGate {
  const cap = rampCapFor(subject, now);
  if (cap === null) return { allowed: true, remaining: null };

  if (sentToday >= cap) {
    return { allowed: false, reason: 'ramp_cap_reached', cap, sentToday };
  }

  return { allowed: true, remaining: cap - sentToday };
}

/**
 * How many of a batch may go, given the cap.
 *
 * Dispatch asks for a page of recipients and this trims it. Returning a
 * smaller number rather than refusing the whole page is what makes the cap a
 * *rate* limit and not a wall: a campaign of 5,000 to a day-one workspace
 * sends 500 today and the rest as the days pass, which is what a legitimate
 * new customer expects and what a spammer finds useless.
 */
export function allowanceForBatch(
  subject: RampSubject,
  sentToday: number,
  requested: number,
  now: Date,
): number {
  const gate = sendGate(subject, sentToday, now);
  if (!gate.allowed) return 0;
  if (gate.remaining === null) return requested;

  return Math.min(requested, gate.remaining);
}

export interface FirstWeekMetrics {
  sent: number;
  complaints: number;
  bounces: number;
}

export type AutoLiftVerdict =
  | { lift: true }
  | { lift: false; reason: 'still_young' | 'too_few_sends' | 'complaints' | 'bounces' | 'already_lifted' };

/**
 * docs/06: "lifted automatically on clean metrics".
 *
 * Returns a reason rather than a boolean, because "why is this workspace
 * still capped" is a support question that gets asked, and reconstructing it
 * from three thresholds afterwards is how a support agent tells a customer
 * something untrue.
 */
export function autoLiftVerdict(
  subject: RampSubject,
  metrics: FirstWeekMetrics,
  now: Date,
): AutoLiftVerdict {
  if (subject.trust?.rampLiftedAt != null) return { lift: false, reason: 'already_lifted' };

  // An operator's extension is not overridden by clean metrics. The whole
  // point of the extension is that somebody saw something the metrics do not
  // show.
  const until = subject.trust?.rampUntil ?? null;
  if (until !== null && until.getTime() > now.getTime()) return { lift: false, reason: 'still_young' };

  if (ageInDays(subject.createdAt, now) < RAMP_DAYS) return { lift: false, reason: 'still_young' };

  // Below the floor the rates are noise: one complaint out of ten sends is
  // 10%, which would refuse a lift on no evidence at all.
  if (metrics.sent < AUTO_LIFT_MIN_SENDS) return { lift: false, reason: 'too_few_sends' };

  if (metrics.complaints / metrics.sent > AUTO_LIFT_MAX_COMPLAINT_RATE) {
    return { lift: false, reason: 'complaints' };
  }

  if (metrics.bounces / metrics.sent > AUTO_LIFT_MAX_BOUNCE_RATE) {
    return { lift: false, reason: 'bounces' };
  }

  return { lift: true };
}

/** The UTC date key `workspace_send_quota` is written under. */
export function quotaDay(now: Date): string {
  // Deliberately UTC, not the workspace's timezone. A cap that resets at
  // local midnight resets at a different instant for every workspace, which
  // makes "how many have they sent today" a question with no single answer
  // at the moment somebody is asking it during an incident.
  return now.toISOString().slice(0, 10);
}
