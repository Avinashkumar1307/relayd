import { describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_STATES,
  TRANSIENT_STATES,
  TRANSITIONS,
  applyLifecycleAction,
  type CampaignState,
  type LifecyclePort,
} from '../src/engine/lifecycle.js';

/**
 * Pause, resume, cancel, hold (review finding F12; docs/04 state machine).
 *
 * Pause is the operation customers trust least, because the first version of
 * it in every system takes a full queue drain to be felt. What makes it
 * trustworthy is the ordering: the halt flag goes up before the state moves,
 * and the state moves with a guarded UPDATE rather than a read and a write.
 */

function port(overrides: Partial<LifecyclePort> = {}, inFlight = 5) {
  const calls: string[] = [];
  const events: { eventType: string; detail: unknown }[] = [];
  const halts: boolean[] = [];
  const transitions: { from: readonly string[]; to: string }[] = [];

  const base: LifecyclePort = {
    async transition(input) {
      calls.push(`transition:${input.to}`);
      transitions.push({ from: input.from, to: input.to });
      return input.to;
    },
    async setHaltFlag(_id, halted) {
      calls.push(`halt:${halted}`);
      halts.push(halted);
    },
    async cancelOutstandingRecipients() {
      calls.push('cancelRecipients');
      return 4200;
    },
    async inFlightCount() {
      calls.push('inFlight');
      return inFlight;
    },
    async enqueueDispatch() {
      calls.push('dispatch');
    },
    async recordEvent(input) {
      events.push({ eventType: input.eventType, detail: input.detail });
    },
    ...overrides,
  };

  return { port: base, calls, events, halts, transitions };
}

describe('the transition table', () => {
  it('pauses only a campaign that is actually sending', async () => {
    // Pausing a `queueing` campaign has to be allowed too — the dispatcher is
    // mid-enqueue — but a draft or a completed campaign has nothing to pause.
    expect(TRANSITIONS.pause.from).toEqual(['sending', 'queueing']);
    expect(TRANSITIONS.pause.to).toBe('pausing');
  });

  it('resumes into queueing, never straight into sending', async () => {
    // The dispatcher has to restart and re-enqueue, and it is the dispatcher
    // that marks `sending` once a page is really in the queue. Jumping
    // straight to `sending` gives a campaign with nothing in flight, which
    // every reconciler reads as stuck.
    expect(TRANSITIONS.resume).toEqual({ from: ['paused'], to: 'queueing' });
  });

  it('cancels from a draining pause without waiting for it', async () => {
    // A customer who hits cancel while a pause drains should not be told to
    // wait for the pause first.
    expect(TRANSITIONS.cancel.from).toContain('pausing');
    expect(TRANSITIONS.cancel.from).toContain('paused');
  });

  it('never allows a transition out of a terminal state', () => {
    for (const rule of Object.values(TRANSITIONS)) {
      for (const from of rule.from) {
        expect(TERMINAL_STATES, from).not.toContain(from);
      }
    }
  });

  it('keeps held separate from paused', () => {
    // A campaign the customer paused resumes when the customer says so; one
    // held for an exhausted quota resumes by itself. Collapsing them means
    // auto-resuming something a human stopped.
    expect(TRANSITIONS.release.from).toEqual(['held']);
    expect(TRANSITIONS.resume.from).toEqual(['paused']);
    expect(TRANSITIONS.hold.from).not.toContain('paused');
  });

  it('gives every transient state a deadline’s worth of company', () => {
    // TRANSIENT_STATES is what sweeper.ts force-exits. A state that drains
    // but is not listed there is F12 waiting to happen.
    for (const state of ['pausing', 'cancelling', 'queueing', 'validating'] as CampaignState[]) {
      expect(TRANSIENT_STATES).toContain(state);
    }
  });

  it('lists no terminal state as transient', () => {
    for (const state of TRANSIENT_STATES) {
      expect(TERMINAL_STATES, state).not.toContain(state);
    }
  });
});

describe('the halt flag ordering', () => {
  it('raises the flag before the state moves, when stopping', async () => {
    // The other order leaves a window in which workers believe they may send
    // while Postgres has already said they may not.
    const { port: p, calls } = port();

    await applyLifecycleAction('c1', 'pause', p);

    expect(calls.indexOf('halt:true')).toBeLessThan(calls.indexOf('transition:pausing'));
  });

  it('clears the flag before restarting the dispatcher, when starting', async () => {
    // The reverse: the dispatcher's first loop would read a halt that is no
    // longer true and exit immediately.
    const { port: p, calls } = port();

    await applyLifecycleAction('c1', 'resume', p);

    // Both assertions are needed. `indexOf` returns -1 for a call that never
    // happened, and -1 is less than everything — so the ordering check alone
    // passes just as happily when the flag is never cleared at all.
    expect(calls).toContain('halt:false');
    expect(calls.indexOf('halt:false')).toBeLessThan(calls.indexOf('dispatch'));
  });

  it('puts the flag back when the transition is refused', async () => {
    // Otherwise a rejected pause leaves a halt flag on a campaign that is
    // running perfectly well, and it stalls until the flag's TTL expires.
    const { port: p, halts } = port({
      async transition() {
        return null;
      },
    });

    const result = await applyLifecycleAction('c1', 'pause', p);

    expect(result.ok).toBe(false);
    expect(halts).toEqual([true, false]);
  });

  it('pauses anyway when the flag cannot be set', async () => {
    // Redis is an optimisation here. An unreachable Redis must not stop a
    // customer pausing their campaign.
    const { port: p } = port({
      async setHaltFlag() {
        throw new Error('ECONNREFUSED');
      },
    });

    expect((await applyLifecycleAction('c1', 'pause', p)).ok).toBe(true);
  });

  it('does not touch the flag for a resume it was refused', async () => {
    const { port: p, halts } = port({
      async transition() {
        return null;
      },
    });

    await applyLifecycleAction('c1', 'resume', p);

    expect(halts).toEqual([]);
  });
});

describe('a refused transition', () => {
  it('reports failure rather than throwing', async () => {
    // Zero rows means an illegal transition or somebody got there first.
    // Either way the answer is 409, never a retry.
    const { port: p } = port({
      async transition() {
        return null;
      },
    });

    const result = await applyLifecycleAction('c1', 'cancel', p);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('cannot be cancel');
  });

  it('does not cancel any recipients', async () => {
    const cancel = vi.fn(async () => 0);
    const { port: p } = port({
      async transition() {
        return null;
      },
      cancelOutstandingRecipients: cancel,
    });

    await applyLifecycleAction('c1', 'cancel', p);

    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not restart the dispatcher', async () => {
    const { port: p, calls } = port({
      async transition() {
        return null;
      },
    });

    await applyLifecycleAction('c1', 'resume', p);

    expect(calls).not.toContain('dispatch');
  });

  it('records nothing on the timeline', async () => {
    const { port: p, events } = port({
      async transition() {
        return null;
      },
    });

    await applyLifecycleAction('c1', 'pause', p);

    expect(events).toEqual([]);
  });
});

describe('cancel', () => {
  it('stops every recipient not yet at the provider', async () => {
    const { port: p } = port();

    const result = await applyLifecycleAction('c1', 'cancel', p);

    expect(result.cancelledRecipients).toBe(4200);
  });

  it('cancels recipients only after the campaign transition', async () => {
    // The other order cancels rows belonging to a campaign that then refuses
    // to move, and there is no way back.
    const { port: p, calls } = port();

    await applyLifecycleAction('c1', 'cancel', p);

    expect(calls.indexOf('transition:cancelling')).toBeLessThan(calls.indexOf('cancelRecipients'));
  });

  it('does not cancel recipients on a pause', async () => {
    // Pause keeps the queue. Resume picks up exactly where it stopped,
    // because the `pending` rows are the queue.
    const { port: p, calls } = port();

    await applyLifecycleAction('c1', 'pause', p);

    expect(calls).not.toContain('cancelRecipients');
  });
});

describe('settling a drained transient state', () => {
  it('goes straight to paused when nothing is in flight', async () => {
    // The common case: pausing a campaign whose provider calls have all
    // returned. Waiting a reconciler tick for that would make pause feel
    // broken.
    const { port: p } = port({}, 0);

    const result = await applyLifecycleAction('c1', 'pause', p);

    expect(result).toMatchObject({ ok: true, state: 'paused', settled: true });
  });

  it('stays in pausing while work is still at the provider', async () => {
    // A message already accepted by SES cannot be recalled.
    const { port: p } = port({}, 3);

    const result = await applyLifecycleAction('c1', 'pause', p);

    expect(result).toMatchObject({ state: 'pausing', settled: false });
  });

  it('settles a cancel the same way', async () => {
    const { port: p } = port({}, 0);
    expect((await applyLifecycleAction('c1', 'cancel', p)).state).toBe('cancelled');
  });

  it('guards the settle, so a reconciler that got there first wins quietly', async () => {
    let first = true;
    const { port: p } = port({
      async transition(input) {
        if (input.to === 'pausing') return 'pausing';
        if (first) {
          first = false;
          return null;
        }
        return input.to;
      },
    }, 0);

    const result = await applyLifecycleAction('c1', 'pause', p);

    expect(result.ok).toBe(true);
    expect(result.state).toBe('pausing');
  });

  it('settles only from the state it just left', async () => {
    // The guard is the `from` list, and widening it is how a settle reaches
    // past the reconciler and drags a campaign back out of `cancelled`.
    const { port: p, transitions } = port({}, 0);

    await applyLifecycleAction('c1', 'pause', p);

    const settle = transitions.find((entry) => entry.to === 'paused');
    expect(settle?.from).toEqual(['pausing']);
  });

  it('settles a cancel only from cancelling', async () => {
    const { port: p, transitions } = port({}, 0);

    await applyLifecycleAction('c1', 'cancel', p);

    expect(transitions.find((entry) => entry.to === 'cancelled')?.from).toEqual(['cancelling']);
  });

  it('does not try to settle a resume', async () => {
    // `queueing` drains by being dispatched, not by counting to zero — and a
    // campaign that resumes with nothing pending is completed by the
    // dispatcher, not paused by this.
    const { port: p, calls } = port({}, 0);

    await applyLifecycleAction('c1', 'resume', p);

    expect(calls).not.toContain('inFlight');
  });

  it('does not try to settle a hold', async () => {
    const { port: p, calls } = port({}, 0);
    await applyLifecycleAction('c1', 'hold', p);
    expect(calls).not.toContain('inFlight');
  });
});

describe('resume and release', () => {
  it('restarts the dispatcher on resume', async () => {
    const { port: p, calls } = port();
    await applyLifecycleAction('c1', 'resume', p);
    expect(calls).toContain('dispatch');
  });

  it('restarts it on release too', async () => {
    // A held campaign whose restriction cleared resumes by itself, and that
    // is the whole reason `held` is not `paused`.
    const { port: p, calls } = port();
    await applyLifecycleAction('c1', 'release', p);
    expect(calls).toContain('dispatch');
  });

  it('does not restart it on a pause', async () => {
    const { port: p, calls } = port();
    await applyLifecycleAction('c1', 'pause', p);
    expect(calls).not.toContain('dispatch');
  });
});

describe('the timeline', () => {
  it('records the action and the state it reached', async () => {
    const { port: p, events } = port({}, 0);

    await applyLifecycleAction('c1', 'pause', p);

    expect(events).toEqual([
      { eventType: 'campaign.pause', detail: { state: 'paused' } },
    ]);
  });

  it('records the reason a hold was applied', async () => {
    // "Held" with no reason is a support ticket.
    const { port: p, events } = port();

    await applyLifecycleAction('c1', 'hold', p, { reason: 'daily quota exhausted' });

    expect(events[0]?.detail).toMatchObject({ reason: 'daily quota exhausted' });
  });

  it('passes the reason down to the transition itself', async () => {
    let seen: string | undefined;
    const { port: p } = port({
      async transition(input) {
        seen ??= input.reason;
        return input.to;
      },
    });

    await applyLifecycleAction('c1', 'hold', p, { reason: 'billing restricted' });

    expect(seen).toBe('billing restricted');
  });

  it('records how many recipients a cancel stopped', async () => {
    const { port: p, events } = port();

    await applyLifecycleAction('c1', 'cancel', p);

    expect(events[0]?.detail).toMatchObject({ cancelledRecipients: 4200 });
  });
});
