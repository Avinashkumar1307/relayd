/**
 * Complaint monitoring and the enforcement ladder (docs/06 "Anti-abuse";
 * BUILD-PLAN Phase 11).
 *
 * docs/06, the two rows this file implements:
 *
 *   "Complaint monitoring — Workspace complaint rate above 0.1% triggers
 *   review; above 0.3% auto-pauses sending. Hard bounce rate above 5% forces
 *   list hygiene."
 *
 *   "Response ladder — Warn, then require review before launch, then pause
 *   sending, then suspend, then terminate with data export."
 *
 * ## Why the thresholds are what they are
 *
 * They are not ours. 0.3% is roughly where Gmail and Microsoft start
 * throttling a sender, and a workspace that reaches it is already damaging
 * its own deliverability and, through shared pools, everybody else's. Pausing
 * at that number is not a punishment — it is stopping a sender from
 * continuing to do something that is already failing.
 *
 * ## The two ways this goes wrong, and what stops each
 *
 * **Firing on noise.** 0.3% of 100 sends is 0.3 complaints, so a single
 * complaint on a small campaign would trip an auto-pause. `MIN_SAMPLE` is
 * what stops that, and it is the difference between a control people trust
 * and one they route around.
 *
 * **Never releasing.** A workspace that cleans up has to be able to come
 * back. A ladder that only climbs turns one bad campaign into a permanently
 * dead business, which means an operator starts lifting enforcement by hand
 * and stops trusting the automatic half.
 *
 * Everything here is pure. The I/O is in the repository and the wiring is in
 * the worker; the decisions are functions of (metrics, current stage, clock),
 * so the boundaries can be tested exhaustively.
 */

/** docs/06: "above 0.1% triggers review". */
export const COMPLAINT_REVIEW_RATE = 0.001;

/** docs/06: "above 0.3% auto-pauses sending". */
export const COMPLAINT_PAUSE_RATE = 0.003;

/** docs/06: "Hard bounce rate above 5% forces list hygiene". */
export const BOUNCE_HYGIENE_RATE = 0.05;

/**
 * Sends in the window below which no rate is acted on.
 *
 * 0.3% of 100 is 0.3, so without a floor one complaint from a 100-recipient
 * campaign auto-pauses the workspace. 500 is the point where a single
 * complaint (0.2%) is still under the pause threshold — chosen so that no
 * individual recipient's click can, on its own, stop a workspace sending.
 */
export const MIN_SAMPLE = 500;

/** The window rates are measured over. */
export const WINDOW_DAYS = 30;

/**
 * How long a workspace must stay clean before enforcement steps back down.
 *
 * Long enough that it reflects a changed list rather than a quiet week —
 * a paused workspace sends nothing, so its rate would otherwise "recover"
 * by arithmetic the moment the window rolled past the bad campaign.
 */
export const RECOVERY_DAYS = 14;

/**
 * The ladder, in order. docs/06: "Warn, then require review before launch,
 * then pause sending, then suspend, then terminate with data export."
 */
export const STAGES = [
  'none',
  'warned',
  'review_required',
  'paused',
  'suspended',
  'terminated',
] as const;

export type EnforcementStage = (typeof STAGES)[number];

/**
 * The stages an automatic job may set.
 *
 * Suspension and termination are deliberately absent. They end a paying
 * customer's business with us, they are the two the customer cannot undo by
 * fixing their list, and no metric is a good enough reason to do either
 * without a person looking. docs/06 puts the ops console for reviewing
 * flagged workspaces in the same paragraph, which is what those two stages
 * are for.
 *
 * Pausing *is* automatic, because by the time a human looks the damage is
 * already spreading through a shared pool.
 */
export const AUTOMATIC_STAGES: readonly EnforcementStage[] = [
  'none',
  'warned',
  'review_required',
  'paused',
];

export function stageRank(stage: EnforcementStage): number {
  return STAGES.indexOf(stage);
}

export function isAutomatic(stage: EnforcementStage): boolean {
  return AUTOMATIC_STAGES.includes(stage);
}

export interface ComplaintMetrics {
  /** Sends in the window. The denominator. */
  sent: number;
  complaints: number;
  hardBounces: number;
}

export function complaintRate(metrics: ComplaintMetrics): number {
  return metrics.sent === 0 ? 0 : metrics.complaints / metrics.sent;
}

export function hardBounceRate(metrics: ComplaintMetrics): number {
  return metrics.sent === 0 ? 0 : metrics.hardBounces / metrics.sent;
}

/** Whether there is enough traffic for a rate to mean anything. */
export function hasEnoughSample(metrics: ComplaintMetrics): boolean {
  return metrics.sent >= MIN_SAMPLE;
}

export type EnforcementTrigger =
  | 'complaint_rate_pause'
  | 'complaint_rate_review'
  | 'bounce_rate_hygiene'
  | 'clean';

/**
 * What the current metrics call for, before any ladder logic.
 *
 * Complaints outrank bounces: a complaint is a recipient saying "I did not
 * ask for this", which is the thing that gets a sending domain blocked, where
 * a bounce is a list that needs cleaning. A workspace over both should be
 * paused, not asked to tidy up.
 */
export function triggerFor(metrics: ComplaintMetrics): EnforcementTrigger {
  if (!hasEnoughSample(metrics)) return 'clean';

  if (complaintRate(metrics) > COMPLAINT_PAUSE_RATE) return 'complaint_rate_pause';
  if (complaintRate(metrics) > COMPLAINT_REVIEW_RATE) return 'complaint_rate_review';
  if (hardBounceRate(metrics) > BOUNCE_HYGIENE_RATE) return 'bounce_rate_hygiene';

  return 'clean';
}

/** The stage a trigger calls for on its own. */
export function stageForTrigger(trigger: EnforcementTrigger): EnforcementStage {
  switch (trigger) {
    case 'complaint_rate_pause':
      return 'paused';
    case 'complaint_rate_review':
      return 'review_required';
    case 'bounce_rate_hygiene':
      return 'warned';
    case 'clean':
      return 'none';
  }
}

export interface EnforcementState {
  stage: EnforcementStage;
  /** When the workspace entered this stage. */
  enteredAt: Date;
  /** Set by an operator; blocks automatic de-escalation. */
  heldByOperator: boolean;
}

export type EnforcementDecision =
  | { action: 'none' }
  | { action: 'escalate'; to: EnforcementStage; trigger: EnforcementTrigger; rate: number }
  | { action: 'release'; to: EnforcementStage };

/**
 * What the enforcement job should do to this workspace now.
 *
 * ## Escalation
 *
 * Straight to the stage the metrics call for, not one rung at a time. The
 * ladder in docs/06 describes the *sequence a workspace experiences*, not a
 * rate limit on how fast we may react: a workspace that jumps from clean to
 * 2% complaints has not earned three more days of sending while the ladder
 * catches up. What the ladder gives is that nothing skips *past* pause into
 * suspension automatically.
 *
 * ## Release
 *
 * One rung at a time, and only after `RECOVERY_DAYS` clean. A workspace that
 * went straight to `paused` comes back through `review_required`, so the
 * first thing it does after a pause is a launch somebody looked at.
 */
export function decide(
  state: EnforcementState,
  metrics: ComplaintMetrics,
  now: Date,
): EnforcementDecision {
  const trigger = triggerFor(metrics);
  const wanted = stageForTrigger(trigger);

  // An operator's hold is never touched by the job, in either direction.
  // Somebody looked at this workspace and made a decision; a nightly job
  // quietly undoing it is how an investigation gets lost.
  if (state.heldByOperator) return { action: 'none' };

  // Never automatically move a workspace an operator escalated beyond the
  // automatic range. Suspension is not ours to lift.
  if (!isAutomatic(state.stage)) return { action: 'none' };

  if (stageRank(wanted) > stageRank(state.stage)) {
    return {
      action: 'escalate',
      to: wanted,
      trigger,
      rate: trigger === 'bounce_rate_hygiene' ? hardBounceRate(metrics) : complaintRate(metrics),
    };
  }

  if (trigger !== 'clean' || state.stage === 'none') return { action: 'none' };

  const cleanFor = now.getTime() - state.enteredAt.getTime();
  if (cleanFor < RECOVERY_DAYS * 86_400_000) return { action: 'none' };

  const next = STAGES[stageRank(state.stage) - 1];
  // `stage` is never 'none' here, so there is always a lower rung; the
  // fallback is for the type rather than for a case that can happen.
  return { action: 'release', to: next ?? 'none' };
}

/**
 * Whether a workspace at this stage may launch a campaign.
 *
 * `review_required` can still launch — an operator approves it first, which
 * is what the stage means. `paused` and beyond cannot.
 */
export function mayLaunch(stage: EnforcementStage): boolean {
  return stageRank(stage) < stageRank('paused');
}

/**
 * Whether a workspace at this stage may send at all.
 *
 * Identical to `mayLaunch` today and kept separate on purpose: they answer
 * different questions, and the first time they diverge — a stage that lets
 * an in-flight campaign drain but blocks new ones — one call site would
 * otherwise be silently wrong.
 */
export function maySend(stage: EnforcementStage): boolean {
  return stageRank(stage) < stageRank('paused');
}

/** Whether a launch at this stage needs an operator to approve it first. */
export function needsReview(stage: EnforcementStage): boolean {
  return stage === 'review_required';
}
