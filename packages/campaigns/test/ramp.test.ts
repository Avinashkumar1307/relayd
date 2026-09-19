import { describe, expect, it } from 'vitest';
import {
  AUTO_LIFT_MIN_SENDS,
  RAMP_DAILY_CAP,
  RAMP_DAYS,
  ageInDays,
  allowanceForBatch,
  autoLiftVerdict,
  excludedFromPoolRouting,
  isInRamp,
  quotaDay,
  rampCapFor,
  sendGate,
  type RampSubject,
  type WorkspaceTrust,
} from '../src/abuse/ramp.js';

/**
 * The new-workspace ramp (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
 *
 * docs/06 opens the section with why this is not a nicety: "A tool that
 * sends bulk email will be signed up for by spammers within weeks.
 * Undetected, your customers' providers suspend them, your processor sees
 * disputes, and your link domain's reputation collapses."
 *
 * The numbers are pinned as literals here, not read from the constants they
 * are testing. A test written as `expect(cap).toBe(RAMP_DAILY_CAP)` moves
 * with the constant and proves nothing about what docs/06 asked for: the
 * cap could be raised to 500,000 and the suite would stay green.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-19T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function workspace(over: Partial<RampSubject> = {}): RampSubject {
  return {
    workspaceId: 'ws-1',
    createdAt: daysAgo(1),
    trust: null,
    ...over,
  };
}

function trust(over: Partial<WorkspaceTrust> = {}): WorkspaceTrust {
  return { rampLiftedAt: null, rampLiftedBy: null, rampUntil: null, ...over };
}

describe('the policy is the one docs/06 asked for', () => {
  it('caps the first 7 days at 500 a day', () => {
    // Pinned to the document, not to the constants. If somebody raises
    // either number, this fails and they have to argue with docs/06 rather
    // than with a test that already agreed with them.
    expect(RAMP_DAYS).toBe(7);
    expect(RAMP_DAILY_CAP).toBe(500);
  });
});

describe('age', () => {
  it('floors to whole days', () => {
    expect(ageInDays(daysAgo(0), NOW)).toBe(0);
    expect(ageInDays(new Date(NOW.getTime() - DAY - 1), NOW)).toBe(1);
    expect(ageInDays(daysAgo(6.99), NOW)).toBe(6);
  });

  it('treats a future creation date as zero, not negative', () => {
    // Clock skew between the app and the database. A negative age would
    // compare as "older than 7 days" and lift the cap, and skew is exactly
    // the condition under which a check should tighten rather than relax.
    expect(ageInDays(new Date(NOW.getTime() + DAY), NOW)).toBe(0);
    expect(isInRamp(workspace({ createdAt: new Date(NOW.getTime() + DAY) }), NOW)).toBe(true);
  });
});

describe('who is in the ramp', () => {
  it('holds for the first seven days and releases on the eighth', () => {
    // Both sides of the boundary. A test that only checks day 1 passes with
    // a cap that never lifts; one that only checks day 8 passes with a cap
    // that never applies.
    expect(isInRamp(workspace({ createdAt: daysAgo(0) }), NOW)).toBe(true);
    expect(isInRamp(workspace({ createdAt: daysAgo(6) }), NOW)).toBe(true);
    expect(isInRamp(workspace({ createdAt: daysAgo(7) }), NOW)).toBe(false);
    expect(isInRamp(workspace({ createdAt: daysAgo(30) }), NOW)).toBe(false);
  });

  it('treats a workspace with no trust row as ramped', () => {
    // The safe default. A missing row capping a legitimate workspace at 500
    // produces a complaint; the other way round produces a blocklisted IP
    // and no complaint at all until it is too late.
    expect(isInRamp(workspace({ createdAt: daysAgo(1), trust: null }), NOW)).toBe(true);
  });

  it('releases a workspace lifted early', () => {
    expect(
      isInRamp(
        workspace({
          createdAt: daysAgo(3),
          trust: trust({ rampLiftedAt: daysAgo(1), rampLiftedBy: 'operator' }),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('lets an operator extension override an old lift', () => {
    // The sequence somebody actually types during an investigation: the
    // workspace was lifted weeks ago, it now looks wrong, and they extend
    // the ramp. Checking the lift first would silently ignore them.
    expect(
      isInRamp(
        workspace({
          createdAt: daysAgo(40),
          trust: trust({
            rampLiftedAt: daysAgo(30),
            rampLiftedBy: 'automatic',
            rampUntil: new Date(NOW.getTime() + 5 * DAY),
          }),
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it('stops extending once the extension expires', () => {
    expect(
      isInRamp(
        workspace({
          createdAt: daysAgo(40),
          trust: trust({ rampUntil: new Date(NOW.getTime() - 1) }),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('caps only while ramped', () => {
    expect(rampCapFor(workspace({ createdAt: daysAgo(1) }), NOW)).toBe(500);
    expect(rampCapFor(workspace({ createdAt: daysAgo(10) }), NOW)).toBeNull();
  });
});

describe('the cap is not an entitlement', () => {
  it('applies regardless of anything the workspace could buy', () => {
    // docs/06: "capped at 500 emails/day regardless of plan". The function
    // takes no plan, no entitlement and no subscription — which is the
    // point, because a stolen card buys the largest plan available and any
    // limit derived from what somebody paid for is bypassed by paying.
    const gate = sendGate(workspace({ createdAt: daysAgo(1) }), 0, NOW);

    expect(gate).toEqual({ allowed: true, remaining: 500 });
  });
});

describe('the daily gate', () => {
  it('allows up to the cap and refuses at it', () => {
    const ws = workspace({ createdAt: daysAgo(1) });

    expect(sendGate(ws, 499, NOW)).toEqual({ allowed: true, remaining: 1 });
    expect(sendGate(ws, 500, NOW)).toEqual({
      allowed: false,
      reason: 'ramp_cap_reached',
      cap: 500,
      sentToday: 500,
    });
  });

  it('refuses when already over, not just at, the cap', () => {
    // Concurrent dispatchers can overshoot by a page. `>=` rather than `===`
    // is the difference between a cap and a number that is briefly true.
    const gate = sendGate(workspace({ createdAt: daysAgo(1) }), 640, NOW);

    expect(gate.allowed).toBe(false);
  });

  it('reports no cap as null, which is not zero', () => {
    // A caller that read `remaining: null` as "none left" would stop every
    // established workspace; one that read 0 as "no cap" would stop none.
    const gate = sendGate(workspace({ createdAt: daysAgo(30) }), 1_000_000, NOW);

    expect(gate).toEqual({ allowed: true, remaining: null });
  });
});

describe('a batch is trimmed, not refused', () => {
  it('sends what is left of today rather than nothing', () => {
    // The property that makes this a rate limit: a 5,000-recipient campaign
    // from a day-one workspace sends 500 today and the rest as the days
    // pass. Refusing the whole page would stall the campaign entirely.
    expect(allowanceForBatch(workspace({ createdAt: daysAgo(1) }), 300, 500, NOW)).toBe(200);
  });

  it('never trims a batch that is already under the remainder', () => {
    expect(allowanceForBatch(workspace({ createdAt: daysAgo(1) }), 0, 100, NOW)).toBe(100);
  });

  it('returns zero once the day is spent', () => {
    expect(allowanceForBatch(workspace({ createdAt: daysAgo(1) }), 500, 500, NOW)).toBe(0);
  });

  it('passes the whole batch for an established workspace', () => {
    expect(allowanceForBatch(workspace({ createdAt: daysAgo(30) }), 99_999, 500, NOW)).toBe(500);
  });
});

describe('pool routing', () => {
  it('excludes a ramped workspace', () => {
    // A pool spreads a campaign across provider connections, which is how a
    // spammer spreads reputation damage and outruns a per-connection limit.
    expect(excludedFromPoolRouting(workspace({ createdAt: daysAgo(1) }), NOW)).toBe(true);
  });

  it('admits an established one', () => {
    expect(excludedFromPoolRouting(workspace({ createdAt: daysAgo(10) }), NOW)).toBe(false);
  });
});

describe('the automatic lift', () => {
  const clean = { sent: 1_000, complaints: 0, bounces: 5 };

  it('lifts a clean workspace once it is old enough', () => {
    expect(autoLiftVerdict(workspace({ createdAt: daysAgo(8) }), clean, NOW)).toEqual({
      lift: true,
    });
  });

  it('will not lift before the seventh day', () => {
    expect(autoLiftVerdict(workspace({ createdAt: daysAgo(6) }), clean, NOW)).toEqual({
      lift: false,
      reason: 'still_young',
    });
  });

  it('waits for enough evidence', () => {
    // One complaint out of ten sends is 10%, which would refuse a lift on no
    // evidence at all. Below the floor the rates are noise in both
    // directions.
    expect(
      autoLiftVerdict(
        workspace({ createdAt: daysAgo(8) }),
        { sent: AUTO_LIFT_MIN_SENDS - 1, complaints: 0, bounces: 0 },
        NOW,
      ),
    ).toEqual({ lift: false, reason: 'too_few_sends' });
  });

  it('refuses on complaints below the auto-pause threshold', () => {
    // 0.2% — under the 0.3% that auto-pauses, and still not clean enough to
    // earn an unlimited rate. A workspace sitting just under the line that
    // stops it has not demonstrated anything.
    expect(
      autoLiftVerdict(
        workspace({ createdAt: daysAgo(8) }),
        { sent: 1_000, complaints: 2, bounces: 0 },
        NOW,
      ),
    ).toEqual({ lift: false, reason: 'complaints' });
  });

  it('refuses on bounces', () => {
    expect(
      autoLiftVerdict(
        workspace({ createdAt: daysAgo(8) }),
        { sent: 1_000, complaints: 0, bounces: 30 },
        NOW,
      ),
    ).toEqual({ lift: false, reason: 'bounces' });
  });

  it('does not re-lift an already-lifted workspace', () => {
    expect(
      autoLiftVerdict(
        workspace({
          createdAt: daysAgo(8),
          trust: trust({ rampLiftedAt: daysAgo(1), rampLiftedBy: 'operator' }),
        }),
        clean,
        NOW,
      ),
    ).toEqual({ lift: false, reason: 'already_lifted' });
  });

  it('does not override an operator extension with clean metrics', () => {
    // The whole point of the extension is that somebody saw something the
    // metrics do not show.
    expect(
      autoLiftVerdict(
        workspace({
          createdAt: daysAgo(40),
          trust: trust({ rampUntil: new Date(NOW.getTime() + DAY) }),
        }),
        clean,
        NOW,
      ),
    ).toEqual({ lift: false, reason: 'still_young' });
  });
});

describe('the quota day', () => {
  it('is a UTC date', () => {
    expect(quotaDay(new Date('2026-09-19T23:59:59.999Z'))).toBe('2026-09-19');
    expect(quotaDay(new Date('2026-09-20T00:00:00.000Z'))).toBe('2026-09-20');
  });

  it('does not shift with the machine timezone', () => {
    // This test suite runs on a machine in Asia/Kolkata, where
    // `toLocaleDateString` at 23:00 UTC returns the *next* day. A cap keyed
    // on local time would reset at a different instant for every workspace,
    // and "how many have they sent today" would have no single answer at the
    // moment somebody is asking it during an incident.
    const lateUtc = new Date('2026-09-19T23:00:00.000Z');

    expect(quotaDay(lateUtc)).toBe('2026-09-19');
  });
});
