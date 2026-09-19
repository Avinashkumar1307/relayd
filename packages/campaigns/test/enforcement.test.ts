import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_STAGES,
  MIN_SAMPLE,
  RECOVERY_DAYS,
  STAGES,
  complaintRate,
  decide,
  hardBounceRate,
  hasEnoughSample,
  isAutomatic,
  mayLaunch,
  maySend,
  needsReview,
  stageForTrigger,
  stageRank,
  triggerFor,
  type ComplaintMetrics,
  type EnforcementState,
} from '../src/abuse/enforcement.js';

/**
 * Complaint monitoring and the enforcement ladder (docs/06 "Anti-abuse").
 *
 * docs/06: "Workspace complaint rate above 0.1% triggers review; above 0.3%
 * auto-pauses sending. Hard bounce rate above 5% forces list hygiene." And:
 * "Warn, then require review before launch, then pause sending, then suspend,
 * then terminate with data export."
 *
 * The thresholds are pinned as literals rather than read from the constants
 * they test. A test written as `expect(rate).toBe(COMPLAINT_PAUSE_RATE)` moves
 * with the constant: the threshold could be raised to 30% and the suite would
 * stay green while the control did nothing.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-19T12:00:00.000Z');

function metrics(over: Partial<ComplaintMetrics> = {}): ComplaintMetrics {
  return { sent: 10_000, complaints: 0, hardBounces: 0, ...over };
}

function state(over: Partial<EnforcementState> = {}): EnforcementState {
  return { stage: 'none', enteredAt: NOW, heldByOperator: false, ...over };
}

describe('the thresholds are the ones docs/06 named', () => {
  it('reviews above 0.1% and pauses above 0.3%', () => {
    // Pinned to the document. Raising either number should fail here and
    // make somebody argue with docs/06 rather than with a test that already
    // agreed with them.
    expect(triggerFor(metrics({ complaints: 11 }))).toBe('complaint_rate_review');
    expect(triggerFor(metrics({ complaints: 31 }))).toBe('complaint_rate_pause');
  });

  it('is strictly above, not at', () => {
    // docs/06 says "above". Exactly 0.3% is not above 0.3%, and a workspace
    // sitting precisely on a round number is far more likely to be a
    // coincidence of arithmetic than a spammer.
    expect(triggerFor(metrics({ complaints: 30 }))).toBe('complaint_rate_review');
    expect(triggerFor(metrics({ complaints: 10 }))).toBe('clean');
  });

  it('forces list hygiene above 5% hard bounces', () => {
    expect(triggerFor(metrics({ hardBounces: 501 }))).toBe('bounce_rate_hygiene');
    expect(triggerFor(metrics({ hardBounces: 500 }))).toBe('clean');
  });
});

describe('a rate needs enough traffic to mean anything', () => {
  it('ignores everything below the sample floor', () => {
    // 0.3% of 100 sends is 0.3 complaints, so without a floor one complaint
    // from a 100-recipient campaign auto-pauses the workspace. That is how a
    // control becomes something people route around.
    expect(triggerFor({ sent: 100, complaints: 5, hardBounces: 50 })).toBe('clean');
  });

  it('acts at the floor', () => {
    // The allowed side of the boundary. Without it, a floor set absurdly
    // high would pass the test above and silently disable the whole control.
    expect(hasEnoughSample({ sent: MIN_SAMPLE, complaints: 0, hardBounces: 0 })).toBe(true);
    expect(hasEnoughSample({ sent: MIN_SAMPLE - 1, complaints: 0, hardBounces: 0 })).toBe(false);
  });

  it('puts the floor where one complaint cannot pause a workspace', () => {
    // The property the number was chosen for: at the floor, a single
    // complaint is 0.2%, which is under the pause threshold. No individual
    // recipient's click can stop a workspace sending.
    const one = { sent: MIN_SAMPLE, complaints: 1, hardBounces: 0 };

    expect(complaintRate(one)).toBeLessThanOrEqual(0.003);
    expect(triggerFor(one)).not.toBe('complaint_rate_pause');
  });

  it('does not divide by zero', () => {
    expect(complaintRate({ sent: 0, complaints: 0, hardBounces: 0 })).toBe(0);
    expect(hardBounceRate({ sent: 0, complaints: 0, hardBounces: 0 })).toBe(0);
  });
});

describe('complaints outrank bounces', () => {
  it('pauses a workspace that is over both', () => {
    // A complaint is a recipient saying "I did not ask for this", which is
    // what gets a sending domain blocked. A bounce is a list that needs
    // cleaning. A workspace over both should be stopped, not asked to tidy.
    expect(triggerFor(metrics({ complaints: 100, hardBounces: 2000 }))).toBe(
      'complaint_rate_pause',
    );
  });
});

describe('the ladder', () => {
  it('is the sequence docs/06 lists', () => {
    expect(STAGES).toEqual([
      'none',
      'warned',
      'review_required',
      'paused',
      'suspended',
      'terminated',
    ]);
  });

  it('maps each trigger to its stage', () => {
    expect(stageForTrigger('complaint_rate_pause')).toBe('paused');
    expect(stageForTrigger('complaint_rate_review')).toBe('review_required');
    expect(stageForTrigger('bounce_rate_hygiene')).toBe('warned');
    expect(stageForTrigger('clean')).toBe('none');
  });

  it('stops automation short of suspension', () => {
    // Suspension and termination end a paying customer's business with us,
    // and they are the two the customer cannot undo by fixing their list. No
    // metric is a good enough reason to do either without a person looking.
    expect(AUTOMATIC_STAGES).not.toContain('suspended');
    expect(AUTOMATIC_STAGES).not.toContain('terminated');
    expect(isAutomatic('paused')).toBe(true);
    expect(isAutomatic('suspended')).toBe(false);
  });
});

describe('escalation', () => {
  it('pauses a workspace over the complaint threshold', () => {
    const decision = decide(state(), metrics({ complaints: 50 }), NOW);

    expect(decision).toMatchObject({ action: 'escalate', to: 'paused' });
  });

  it('goes straight to the stage the metrics call for', () => {
    // The ladder is the sequence a workspace experiences, not a rate limit
    // on how fast we may react. A workspace that jumps from clean to 2%
    // complaints has not earned three more days of sending while the ladder
    // catches up.
    const decision = decide(state({ stage: 'none' }), metrics({ complaints: 200 }), NOW);

    expect(decision).toMatchObject({ to: 'paused' });
  });

  it('reports the rate that caused it', () => {
    // "Why was I paused" deserves a number, not a policy.
    const decision = decide(state(), metrics({ complaints: 50 }), NOW);

    expect(decision).toMatchObject({ rate: 0.005 });
  });

  it('reports the bounce rate for a bounce trigger', () => {
    // Not the complaint rate. A workspace warned for bounces and told its
    // complaint rate would have no idea what to fix.
    const decision = decide(state(), metrics({ hardBounces: 1000 }), NOW);

    expect(decision).toMatchObject({ trigger: 'bounce_rate_hygiene', rate: 0.1 });
  });

  it('does nothing when the workspace is already at that stage', () => {
    const decision = decide(state({ stage: 'paused' }), metrics({ complaints: 50 }), NOW);

    expect(decision).toEqual({ action: 'none' });
  });

  it('never escalates past the automatic range', () => {
    // 10% complaints is egregious, and it still does not suspend anybody.
    const decision = decide(state({ stage: 'paused' }), metrics({ complaints: 1000 }), NOW);

    expect(decision).toEqual({ action: 'none' });
  });
});

describe('release', () => {
  const clean = metrics();

  it('waits a fortnight, pinned rather than read from the constant', () => {
    // Read from `RECOVERY_DAYS` the tests below move with it: the period
    // could be cut to an hour and they would all still pass while a paused
    // spammer walked back out the next morning.
    expect(RECOVERY_DAYS).toBe(14);
  });

  it('steps down one rung after the recovery period', () => {
    const entered = new Date(NOW.getTime() - (RECOVERY_DAYS + 1) * DAY);

    expect(decide(state({ stage: 'paused', enteredAt: entered }), clean, NOW)).toEqual({
      action: 'release',
      to: 'review_required',
    });
  });

  it('does not release early', () => {
    const entered = new Date(NOW.getTime() - (RECOVERY_DAYS - 1) * DAY);

    expect(decide(state({ stage: 'paused', enteredAt: entered }), clean, NOW)).toEqual({
      action: 'none',
    });
  });

  it('brings a paused workspace back through review, not to clean', () => {
    // The first thing a workspace does after a pause should be a launch
    // somebody looked at. Releasing straight to `none` would let the same
    // list go out again unexamined.
    const entered = new Date(NOW.getTime() - (RECOVERY_DAYS + 1) * DAY);
    const decision = decide(state({ stage: 'paused', enteredAt: entered }), clean, NOW);

    expect(decision).not.toMatchObject({ to: 'none' });
  });

  it('eventually returns to none', () => {
    // Without this the ladder only climbs, which turns one bad campaign into
    // a permanently dead business — and an operator who starts lifting
    // enforcement by hand stops trusting the automatic half.
    const entered = new Date(NOW.getTime() - (RECOVERY_DAYS + 1) * DAY);

    expect(decide(state({ stage: 'warned', enteredAt: entered }), clean, NOW)).toEqual({
      action: 'release',
      to: 'none',
    });
  });

  it('does nothing for a workspace already clean', () => {
    expect(decide(state({ stage: 'none' }), clean, NOW)).toEqual({ action: 'none' });
  });

  it('does not release a workspace still over a threshold', () => {
    const entered = new Date(NOW.getTime() - 90 * DAY);

    expect(
      decide(state({ stage: 'review_required', enteredAt: entered }), metrics({ complaints: 20 }), NOW),
    ).toEqual({ action: 'none' });
  });

  it('does not release on an empty window', () => {
    // A paused workspace sends nothing, so its rate "recovers" by arithmetic
    // the moment the window rolls past the bad campaign. Below the sample
    // floor the trigger is `clean` — which is why the release also requires
    // the recovery clock, and why this case must not release immediately.
    const quiet = { sent: 0, complaints: 0, hardBounces: 0 };

    expect(decide(state({ stage: 'paused', enteredAt: NOW }), quiet, NOW)).toEqual({
      action: 'none',
    });
  });
});

describe("an operator's decision is not undone by a job", () => {
  it('does nothing while held, however bad the metrics', () => {
    const held = state({ stage: 'warned', heldByOperator: true });

    expect(decide(held, metrics({ complaints: 500 }), NOW)).toEqual({ action: 'none' });
  });

  it('does nothing while held, however clean the metrics', () => {
    // Both directions. Somebody looked at this workspace and decided; a
    // nightly job quietly undoing that is how an investigation gets lost.
    const entered = new Date(NOW.getTime() - 90 * DAY);
    const held = state({ stage: 'paused', enteredAt: entered, heldByOperator: true });

    expect(decide(held, metrics(), NOW)).toEqual({ action: 'none' });
  });

  it('will not lift a suspension', () => {
    const entered = new Date(NOW.getTime() - 365 * DAY);

    expect(decide(state({ stage: 'suspended', enteredAt: entered }), metrics(), NOW)).toEqual({
      action: 'none',
    });
  });
});

describe('what each stage permits', () => {
  it('lets a warned workspace carry on', () => {
    // A warning that stopped sending would be a pause with a friendlier
    // name, and the ladder would have three stages instead of five.
    expect(maySend('warned')).toBe(true);
    expect(mayLaunch('warned')).toBe(true);
  });

  it('lets a review-required workspace launch, with review', () => {
    expect(mayLaunch('review_required')).toBe(true);
    expect(needsReview('review_required')).toBe(true);
  });

  it('stops a paused workspace', () => {
    expect(maySend('paused')).toBe(false);
    expect(mayLaunch('paused')).toBe(false);
  });

  it('stops everything above paused', () => {
    for (const stage of ['suspended', 'terminated'] as const) {
      expect(maySend(stage), stage).toBe(false);
      expect(mayLaunch(stage), stage).toBe(false);
    }
  });

  it('asks for review only at that stage', () => {
    expect(needsReview('warned')).toBe(false);
    expect(needsReview('paused')).toBe(false);
  });

  it('orders the stages so rank comparisons mean something', () => {
    expect(stageRank('none')).toBeLessThan(stageRank('warned'));
    expect(stageRank('warned')).toBeLessThan(stageRank('paused'));
    expect(stageRank('paused')).toBeLessThan(stageRank('terminated'));
  });
});
