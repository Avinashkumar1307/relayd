import { describe, expect, it, vi } from 'vitest';
import {
  STALE_QUEUED_MS,
  STALE_SENDING_MS,
  SWEEPABLE_CAMPAIGN_STATES,
  SWEEP_BATCH,
  TRANSIENT_DEADLINE_MS,
  TRANSIENT_EXITS,
  sweepOnce,
  type SweeperPort,
  type TransientState,
} from '../src/engine/sweeper.js';

/**
 * The reconcilers (INVARIANTS R3, R5, R12, R13; review findings F3, F5, F12).
 *
 * These are the jobs nobody notices until the day they are missing, and the
 * only thing that can be asserted about them without a database is what they
 * look for, in what order, and what they do with the answer.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');

function port(overrides: Partial<SweeperPort> = {}) {
  const calls: string[] = [];
  const cutoffs: Record<string, Date> = {};
  const events: { campaignId: string; eventType: string }[] = [];
  const transitions: { campaignId: string; from: string; to: string; reason: string }[] = [];

  const base: SweeperPort = {
    async reclaimStaleQueued(input) {
      calls.push('reclaimQueued');
      cutoffs['queued'] = input.olderThan;
      return 0;
    },
    async markStaleSendingUncertain(input) {
      calls.push('markUncertain');
      cutoffs['sending'] = input.olderThan;
      return 0;
    },
    async findExpiredTransient(input) {
      calls.push(`findExpired:${input.state}`);
      cutoffs[`transient:${input.state}`] = input.olderThan;
      return [];
    },
    async forceTransition(input) {
      calls.push(`force:${input.from}->${input.to}`);
      transitions.push(input);
      return true;
    },
    async findIdleCampaigns() {
      calls.push('findIdle');
      return [];
    },
    async maybeComplete() {
      calls.push('maybeComplete');
      return true;
    },
    async recordEvent(input) {
      events.push({ campaignId: input.campaignId, eventType: input.eventType });
    },
    ...overrides,
  };

  return { port: base, calls, cutoffs, events, transitions };
}

describe('stale queued rows (R3, F3)', () => {
  it('looks five minutes back, which is the documented cutoff', async () => {
    const { port: p, cutoffs } = port();

    await sweepOnce(p, { now: NOW });

    expect(cutoffs['queued']).toEqual(new Date(NOW.getTime() - 5 * 60_000));
    expect(STALE_QUEUED_MS).toBe(5 * 60_000);
  });

  it('reports what it reclaimed', async () => {
    // The trace: the dispatcher committed a 500-row claim and was killed
    // before addBulk returned. Nothing scans for `queued`.
    const { port: p } = port({
      async reclaimStaleQueued() {
        return 200;
      },
    });

    expect((await sweepOnce(p, { now: NOW })).reclaimed).toBe(200);
  });

  it('bounds one pass, so a sweep cannot sit on a long write', async () => {
    let limit = 0;
    const { port: p } = port({
      async reclaimStaleQueued(input) {
        limit = input.limit;
        return 0;
      },
    });

    await sweepOnce(p, { now: NOW });
    expect(limit).toBe(SWEEP_BATCH);
  });

  it('names the campaign states whose queued rows may be reclaimed', async () => {
    // Reclaiming a paused campaign's rows would restart it.
    expect([...SWEEPABLE_CAMPAIGN_STATES]).toEqual(['sending', 'pausing']);
  });
});

describe('stale provider attempts (R5, F5)', () => {
  it('looks ten minutes back, not five', async () => {
    // A row `sending` for six minutes may still be a slow SMTP connection.
    // Returning it to the queue would send the message twice.
    const { port: p, cutoffs } = port();

    await sweepOnce(p, { now: NOW });

    expect(cutoffs['sending']).toEqual(new Date(NOW.getTime() - 10 * 60_000));
    expect(STALE_SENDING_MS).toBe(10 * 60_000);
  });

  it('waits longer for a provider attempt than for an unqueued row', async () => {
    // The asymmetry is the point: one is certainly lost, the other may be in
    // flight at the provider right now.
    expect(STALE_SENDING_MS).toBeGreaterThan(STALE_QUEUED_MS);
  });

  it('reports the uncertain count separately from the reclaimed one', async () => {
    // They mean opposite things to the customer: one is invisible
    // housekeeping, the other is mail that may or may not have been sent.
    const { port: p } = port({
      async reclaimStaleQueued() {
        return 12;
      },
      async markStaleSendingUncertain() {
        return 3;
      },
    });

    expect(await sweepOnce(p, { now: NOW })).toMatchObject({ reclaimed: 12, uncertain: 3 });
  });
});

describe('the order within a pass', () => {
  it('sweeps recipients before forcing campaigns', async () => {
    // A `pausing` campaign stuck on one dead `sending` row exits on its own
    // once that row goes terminal. Forcing first would mask the recipient
    // problem behind a campaign that looks correctly paused.
    const { port: p, calls } = port();

    await sweepOnce(p, { now: NOW });

    expect(calls.indexOf('markUncertain')).toBeLessThan(calls.indexOf('findExpired:pausing'));
  });

  it('reclaims before it marks uncertain', async () => {
    const { port: p, calls } = port();
    await sweepOnce(p, { now: NOW });
    expect(calls.indexOf('reclaimQueued')).toBeLessThan(calls.indexOf('markUncertain'));
  });
});

describe('transient campaign deadlines (R12, F12)', () => {
  it('gives every transient state an exit', async () => {
    // A transient state without a timeout is a bug in every system that has
    // one.
    expect(TRANSIENT_EXITS).toEqual({
      pausing: 'paused',
      cancelling: 'cancelled',
      validating: 'failed',
      queueing: 'failed',
    });
  });

  it('checks all four of them', async () => {
    const { port: p, calls } = port();

    await sweepOnce(p, { now: NOW });

    for (const state of Object.keys(TRANSIENT_EXITS)) {
      expect(calls).toContain(`findExpired:${state}`);
    }
  });

  it('forces a stuck pausing campaign to paused', async () => {
    // The F12 trace exactly: one recipient stuck in `sending`, the campaign
    // waits on an in-flight count that never reaches zero, the UI offers no
    // action because `pausing` is transient, the customer opens a ticket.
    const { port: p, transitions } = port({
      async findExpiredTransient(input) {
        return input.state === 'pausing' ? ['c1'] : [];
      },
    });

    const result = await sweepOnce(p, { now: NOW });

    expect(result.forced).toEqual([{ campaignId: 'c1', from: 'pausing', to: 'paused' }]);
    expect(transitions[0]?.reason).toContain('10 minute deadline');
  });

  it('guards the exit, so a campaign that moved on its own is left alone', async () => {
    const { port: p } = port({
      async findExpiredTransient(input) {
        return input.state === 'cancelling' ? ['c1'] : [];
      },
      async forceTransition() {
        return false;
      },
    });

    const result = await sweepOnce(p, { now: NOW });

    expect(result.forced).toEqual([]);
  });

  it('records nothing for a campaign it did not actually move', async () => {
    // Otherwise the campaign timeline shows a forced transition that never
    // happened, which is worse than no entry.
    const { port: p, events } = port({
      async findExpiredTransient(input) {
        return input.state === 'pausing' ? ['c1'] : [];
      },
      async forceTransition() {
        return false;
      },
    });

    await sweepOnce(p, { now: NOW });

    expect(events).toEqual([]);
  });

  it('records the ones it did move', async () => {
    const { port: p, events } = port({
      async findExpiredTransient(input) {
        return input.state === 'validating' ? ['c1'] : [];
      },
    });

    await sweepOnce(p, { now: NOW });

    expect(events).toEqual([{ campaignId: 'c1', eventType: 'campaign.forced_transition' }]);
  });

  it('uses the same ten-minute deadline for every transient state', async () => {
    const { port: p, cutoffs } = port();

    await sweepOnce(p, { now: NOW });

    const expected = new Date(NOW.getTime() - 10 * 60_000);
    for (const state of Object.keys(TRANSIENT_EXITS)) {
      expect(cutoffs[`transient:${state}`]).toEqual(expected);
    }
    expect(TRANSIENT_DEADLINE_MS).toBe(10 * 60_000);
  });

  it('takes a deadline override, so an incident can widen it without a deploy', async () => {
    const { port: p, cutoffs } = port();

    await sweepOnce(p, { now: NOW, transientDeadlineMs: 60 * 60_000 });

    expect(cutoffs['transient:queueing']).toEqual(new Date(NOW.getTime() - 60 * 60_000));
  });

  it('forces several campaigns in one pass', async () => {
    const { port: p } = port({
      async findExpiredTransient(input) {
        return input.state === 'cancelling' ? ['c1', 'c2', 'c3'] : [];
      },
    });

    expect((await sweepOnce(p, { now: NOW })).forced).toHaveLength(3);
  });
});

describe('campaigns whose dispatcher is gone (R13)', () => {
  it('completes an idle campaign the dispatcher never ran dry on', async () => {
    const { port: p, events } = port({
      async findIdleCampaigns() {
        return ['c1'];
      },
    });

    const result = await sweepOnce(p, { now: NOW });

    expect(result.completed).toEqual(['c1']);
    expect(events).toEqual([{ campaignId: 'c1', eventType: 'campaign.completed' }]);
  });

  it('leaves a campaign that is not actually finished', async () => {
    // Completion is guarded on `pending + queued + sending = 0`; the
    // reconciler asks, it does not decide.
    const { port: p } = port({
      async findIdleCampaigns() {
        return ['c1'];
      },
      async maybeComplete() {
        return false;
      },
    });

    expect((await sweepOnce(p, { now: NOW })).completed).toEqual([]);
  });

  it('looks for idleness before forcing any deadline', async () => {
    // A campaign that is merely finished should complete, not be force-failed
    // out of `queueing`.
    const { port: p, calls } = port();

    await sweepOnce(p, { now: NOW });

    expect(calls.indexOf('findIdle')).toBeLessThan(calls.indexOf('findExpired:queueing'));
  });
});

describe('a pass that is interrupted', () => {
  it('propagates rather than reporting a clean sweep', async () => {
    // Each step is idempotent and bounded, so the next pass picks up what
    // this one dropped — but only if the failure is visible.
    const { port: p } = port({
      async markStaleSendingUncertain() {
        throw new Error('deadlock detected');
      },
    });

    await expect(sweepOnce(p, { now: NOW })).rejects.toThrow('deadlock detected');
  });

  it('has already reclaimed what it reclaimed before failing', async () => {
    const reclaim = vi.fn(async () => 50);
    const { port: p } = port({
      reclaimStaleQueued: reclaim,
      async markStaleSendingUncertain() {
        throw new Error('deadlock detected');
      },
    });

    await sweepOnce(p, { now: NOW }).catch(() => undefined);

    expect(reclaim).toHaveBeenCalledOnce();
  });
});

describe('the transient exit table is exhaustive', () => {
  it('has no exit that lands in another transient state', async () => {
    // `pausing -> cancelling` would be a deadline that buys ten more minutes.
    const transient = new Set(Object.keys(TRANSIENT_EXITS));

    for (const to of Object.values(TRANSIENT_EXITS)) {
      expect(transient.has(to)).toBe(false);
    }
  });

  it('types its keys as the transient states', () => {
    const state: TransientState = 'pausing';
    expect(TRANSIENT_EXITS[state]).toBe('paused');
  });
});
