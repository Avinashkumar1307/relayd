import { describe, expect, it, vi } from 'vitest';
import {
  DISPATCH_PAGE,
  DISPATCH_WINDOW,
  dispatchCampaign,
  throttleDelay,
  type ClaimedRecipient,
  type DispatchPort,
} from '../src/engine/dispatch.js';

/**
 * The dispatch loop (review findings F3, F12, F13).
 *
 * The loop itself is four lines of logic. What it has to get right is when it
 * stops — a pause that takes a full drain to be felt is a pause the customer
 * does not believe in — and what it does with rows it has already claimed
 * when the enqueue fails underneath it.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

function recipients(n: number, offset = 0): ClaimedRecipient[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${offset + i}`, workspaceId: 'ws-1' }));
}

/** A port backed by a finite pool of pending recipients. */
function port(overrides: Partial<DispatchPort> = {}, pool = 1200) {
  const calls: string[] = [];
  const enqueued: string[] = [];
  const released: string[] = [];
  const events: string[] = [];
  const sleeps: number[] = [];
  let remaining = pool;
  let claimedSoFar = 0;
  let state = 'queueing';

  const base: DispatchPort = {
    async readCampaignForDispatch() {
      calls.push('read');
      return { id: 'c1', workspaceId: 'ws-1', state, throttlePerHour: null };
    },
    async inFlightCount() {
      calls.push('inFlight');
      return 0;
    },
    async claimNextRecipients(_id, limit) {
      calls.push(`claim:${limit}`);
      const take = Math.min(limit, remaining);
      remaining -= take;
      const batch = recipients(take, claimedSoFar);
      claimedSoFar += take;
      return batch;
    },
    async enqueueSends(input) {
      calls.push('enqueue');
      for (const r of input.recipients) enqueued.push(r.id);
    },
    async releaseClaims(input) {
      calls.push('release');
      for (const id of input.recipientIds) released.push(id);
    },
    async markSending() {
      calls.push('markSending');
      state = 'sending';
    },
    async maybeComplete() {
      calls.push('maybeComplete');
      return true;
    },
    async isHalted() {
      return false;
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
    now() {
      return NOW;
    },
    async readRampState() {
      // Not ramped, so the cap does not apply and these tests measure the
      // window and the throttle rather than the ramp. The ramp's own
      // behaviour is in ramp.test.ts and in the cases at the bottom of this
      // file.
      return null;
    },
    async recordEvent(input) {
      events.push(input.eventType);
    },
    ...overrides,
  };

  return {
    port: base,
    calls,
    enqueued,
    released,
    events,
    sleeps,
    setState: (s: string) => {
      state = s;
    },
  };
}

describe('the window', () => {
  it('enqueues a page at a time, not the whole campaign', async () => {
    // The point of the loop: Redis holds O(window), not O(recipients).
    const { port: p, enqueued } = port({}, 1200);

    const result = await dispatchCampaign('c1', p, { page: 500 });

    expect(result.pages).toBe(3);
    expect(enqueued).toHaveLength(1200);
  });

  it('waits rather than claiming when the window is full', async () => {
    let inFlight = DISPATCH_WINDOW;
    const { port: p, calls, sleeps } = port({
      async inFlightCount() {
        const current = inFlight;
        inFlight = 0;
        return current;
      },
    }, 10);

    await dispatchCampaign('c1', p);

    expect(sleeps[0]).toBe(500);
    // It waited before it claimed, not after.
    expect(calls.filter((c) => c.startsWith('claim')).length).toBe(2);
  });

  it('never claims more than the window has room for', async () => {
    // Claiming a full page into a window with 40 slots free overshoots by 460
    // recipients, every page, forever.
    const { port: p, calls } = port({
      async inFlightCount() {
        return DISPATCH_WINDOW - 40;
      },
    }, 10_000);

    await dispatchCampaign('c1', p, { maxStallPolls: 0 });

    expect(calls).toContain('claim:40');
  });

  it('gives up on a window that never drains', async () => {
    // A campaign whose in-flight count never falls has stuck rows. Spinning
    // for the job's six-hour timeout holds a worker slot for nothing.
    const { port: p, events } = port({
      async inFlightCount() {
        return DISPATCH_WINDOW;
      },
    });

    const result = await dispatchCampaign('c1', p, { maxStallPolls: 3 });

    expect(result.stopped).toBe('window_stalled');
    expect(events).toContain('dispatch.stalled');
  });

  it('forgets the stall once a page goes through', async () => {
    // Otherwise a long campaign that pauses at the window a few hundred times
    // over an hour exits as though it were stuck.
    let calls = 0;
    const { port: p } = port({
      async inFlightCount() {
        calls += 1;
        // Full, full, clear, full, full, clear ...
        return calls % 3 === 0 ? 0 : DISPATCH_WINDOW;
      },
    }, 1000);

    const result = await dispatchCampaign('c1', p, { maxStallPolls: 2, page: 500 });

    expect(result.stopped).toBe('completed');
  });
});

describe('stopping', () => {
  it('re-reads the campaign every page, so a pause is felt within one', async () => {
    const { port: p, calls } = port({}, 5000);

    await dispatchCampaign('c1', p, { page: 500 });

    const reads = calls.filter((c) => c === 'read').length;
    const claims = calls.filter((c) => c.startsWith('claim')).length;
    expect(reads).toBe(claims);
  });

  it('stops as soon as the campaign is paused', async () => {
    let page = 0;
    const { port: p, enqueued } = port({
      async readCampaignForDispatch() {
        page += 1;
        return {
          id: 'c1',
          workspaceId: 'ws-1',
          state: page > 2 ? 'paused' : 'sending',
          throttlePerHour: null,
        };
      },
    }, 10_000);

    const result = await dispatchCampaign('c1', p, { page: 500 });

    expect(result.stopped).toBe('not_dispatchable');
    expect(enqueued).toHaveLength(1000);
  });

  it('stops for a cancelled campaign without completing it', async () => {
    const complete = vi.fn(async () => true);
    const { port: p } = port({ maybeComplete: complete });
    p.readCampaignForDispatch = async () => ({
      id: 'c1',
      workspaceId: 'ws-1',
      state: 'cancelling',
      throttlePerHour: null,
    });

    const result = await dispatchCampaign('c1', p);

    expect(result.stopped).toBe('not_dispatchable');
    expect(complete).not.toHaveBeenCalled();
  });

  it('stops on a campaign that has disappeared', async () => {
    const { port: p } = port({
      async readCampaignForDispatch() {
        return null;
      },
    });

    expect((await dispatchCampaign('c1', p)).detail).toBe('missing');
  });

  it('honours the halt flag before doing any work', async () => {
    const claim = vi.fn(async () => []);
    const { port: p } = port({
      async isHalted() {
        return true;
      },
      claimNextRecipients: claim,
    });

    const result = await dispatchCampaign('c1', p);

    expect(result.stopped).toBe('halted');
    expect(claim).not.toHaveBeenCalled();
  });

  it('keeps going when the halt flag cannot be read', async () => {
    // Redis is an optimisation here. An unreachable Redis must not pause a
    // customer's campaign — Postgres is the truth, and it said `sending`.
    const { port: p, enqueued } = port({
      async isHalted() {
        throw new Error('ECONNREFUSED');
      },
    }, 100);

    expect((await dispatchCampaign('c1', p)).stopped).toBe('completed');
    expect(enqueued).toHaveLength(100);
  });
});

describe('running dry', () => {
  it('checks completion once, when the claim comes back empty', async () => {
    // Checking on every job completion is O(n²). The dispatcher is the one
    // place that knows it has run out of work.
    const { port: p, calls } = port({}, 300);

    const result = await dispatchCampaign('c1', p, { page: 500 });

    expect(result.stopped).toBe('completed');
    expect(calls.filter((c) => c === 'maybeComplete')).toHaveLength(1);
  });

  it('treats a lost completion race as ordinary', async () => {
    // The reconciler got there first. A guarded transition returning zero
    // rows is the expected outcome for the loser, not an error.
    const { port: p } = port({
      async maybeComplete() {
        return false;
      },
    }, 10);

    expect((await dispatchCampaign('c1', p)).stopped).toBe('drained');
  });

  it('completes a campaign whose audience was already drained', async () => {
    const { port: p, enqueued } = port({}, 0);

    const result = await dispatchCampaign('c1', p);

    expect(result).toMatchObject({ stopped: 'completed', enqueued: 0, pages: 0 });
    expect(enqueued).toEqual([]);
  });
});

describe('the gap between the claim and the queue (F3)', () => {
  it('returns claimed rows to pending when the enqueue fails', async () => {
    // Otherwise 500 rows sit in `queued` with nothing scanning for them: they
    // are never sent and the campaign never completes.
    const { port: p, released } = port({
      async enqueueSends() {
        throw new Error('redis down');
      },
    }, 500);

    await expect(dispatchCampaign('c1', p)).rejects.toThrow('redis down');
    expect(released).toHaveLength(500);
  });

  it('releases exactly the rows it claimed', async () => {
    const { port: p, released } = port({
      async enqueueSends() {
        throw new Error('redis down');
      },
    }, 7);

    await dispatchCampaign('c1', p).catch(() => undefined);

    expect(released).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
  });

  it('rethrows so the dispatch job retries', async () => {
    // The claim is undone, so the retry re-claims the same rows rather than
    // stepping over them.
    const { port: p } = port({
      async enqueueSends() {
        throw new Error('redis down');
      },
    }, 10);

    await expect(dispatchCampaign('c1', p)).rejects.toThrow();
  });

  it('does not mark the campaign sending on a page that failed to enqueue', async () => {
    // A campaign in `sending` with nothing in flight reads as stuck to every
    // reconciler that looks at it.
    const { port: p, calls } = port({
      async enqueueSends() {
        throw new Error('redis down');
      },
    }, 10);

    await dispatchCampaign('c1', p).catch(() => undefined);

    expect(calls).not.toContain('markSending');
  });
});

describe('queueing becomes sending', () => {
  it('marks sending after the first page is really enqueued', async () => {
    const { port: p, calls } = port({}, 100);

    await dispatchCampaign('c1', p);

    expect(calls.indexOf('enqueue')).toBeLessThan(calls.indexOf('markSending'));
  });

  it('marks it once even if the campaign still reads as queueing', async () => {
    // The guarded UPDATE is idempotent, but the read that follows it is not
    // guaranteed to see it — a read replica, or simply the next page starting
    // before the commit is visible. The dispatcher remembers instead of
    // relying on what it is told.
    const { port: p, calls } = port({
      async readCampaignForDispatch() {
        calls.push('read');
        return { id: 'c1', workspaceId: 'ws-1', state: 'queueing', throttlePerHour: null };
      },
      async markSending() {
        calls.push('markSending');
        // Deliberately does not flip the state the next read returns.
      },
    }, 2000);

    await dispatchCampaign('c1', p, { page: 500 });

    expect(calls.filter((c) => c === 'markSending')).toHaveLength(1);
  });

  it('does not mark a campaign that was already sending', async () => {
    const { port: p, calls, setState } = port({}, 100);
    setState('sending');

    await dispatchCampaign('c1', p);

    expect(calls).not.toContain('markSending');
  });
});

describe('the throttle', () => {
  it('waits nothing when there is no throttle', () => {
    expect(throttleDelay(null, 500)).toBe(0);
  });

  it('paces a page to the hourly rate', () => {
    // 10,000/hour, 500 sent — three minutes.
    expect(throttleDelay(10_000, 500)).toBe(180_000);
  });

  it('paces the last partial page proportionally', () => {
    // Waiting a full page's delay for a 3-recipient page would add minutes to
    // the end of every campaign.
    expect(throttleDelay(10_000, 3)).toBe(1080);
  });

  it('refuses to divide by a nonsense throttle', () => {
    expect(throttleDelay(0, 500)).toBe(0);
    expect(throttleDelay(-1, 500)).toBe(0);
  });

  it('sleeps between pages when throttled', async () => {
    const { port: p, sleeps } = port({
      async readCampaignForDispatch() {
        return { id: 'c1', workspaceId: 'ws-1', state: 'sending', throttlePerHour: 10_000 };
      },
    }, 1000);

    await dispatchCampaign('c1', p, { page: 500 });

    expect(sleeps).toEqual([180_000, 180_000]);
  });
});

describe('the defaults', () => {
  it('are the ones docs/04 specifies', () => {
    expect(DISPATCH_WINDOW).toBe(5_000);
    expect(DISPATCH_PAGE).toBe(500);
  });
});

describe('the new-workspace ramp (docs/06)', () => {
  const DAY = 86_400_000;
  const young = { createdAt: new Date(NOW.getTime() - DAY), trust: null };

  it('trims a page to what is left of the day', async () => {
    // The property that makes the cap a rate limit and not a wall. A
    // 1,000-recipient campaign from a day-one workspace that has already
    // sent 300 enqueues 200 and then stops, rather than refusing everything
    // or sending everything.
    //
    // `sentToday` advances with what is enqueued, as it does in reality. A
    // fake that returned a constant would let the loop trim to the same
    // remainder on every page and drain the whole campaign 200 at a time —
    // which is how a cap that does not actually cap looks from the outside.
    let sentToday = 300;

    const { port: p, enqueued } = port(
      {
        async readRampState() {
          return { ...young, sentToday };
        },
        async enqueueSends(input) {
          sentToday += input.recipients.length;
        },
      },
      1000,
    );

    const result = await dispatchCampaign('c1', p, { page: 500 });

    expect(enqueued).toHaveLength(0);
    expect(sentToday).toBe(500);
    expect(result.enqueued).toBe(200);
    expect(result.stopped).toBe('ramp_capped');
  });

  it('stops without completing the campaign', async () => {
    // `ramp_capped` is not `completed` and not `drained`. If it completed,
    // the remaining 800 recipients would never send; if it were an error,
    // the job would retry in a loop against a cap that will not move until
    // midnight.
    const { port: p, calls } = port(
      {
        async readRampState() {
          return { ...young, sentToday: 500 };
        },
      },
      1000,
    );

    const result = await dispatchCampaign('c1', p, { page: 500 });

    expect(result.stopped).toBe('ramp_capped');
    expect(result.enqueued).toBe(0);
    expect(calls).not.toContain('maybeComplete');
  });

  it('re-reads the ramp every page, not once per dispatch', async () => {
    // A cap checked once at the top of a 500k-recipient dispatch is not a
    // cap. This counts the reads across a multi-page run.
    let reads = 0;

    const { port: p } = port(
      {
        async readRampState() {
          reads += 1;
          return null;
        },
      },
      1000,
    );

    await dispatchCampaign('c1', p, { page: 500 });

    expect(reads).toBeGreaterThan(1);
  });

  it('does not cap an established workspace', async () => {
    const { port: p, enqueued } = port(
      {
        async readRampState() {
          return null;
        },
      },
      1000,
    );

    const result = await dispatchCampaign('c1', p, { page: 500 });

    expect(enqueued).toHaveLength(1000);
    expect(result.stopped).toBe('completed');
  });

  it('records why it stopped', async () => {
    // A campaign that stops mid-send with no event is a support ticket
    // nobody can answer.
    const { port: p, events } = port(
      {
        async readRampState() {
          return { ...young, sentToday: 500 };
        },
      },
      1000,
    );

    await dispatchCampaign('c1', p, { page: 500 });

    expect(events).toContain('dispatch.ramp_capped');
  });

  it('still respects the window when the ramp allows more', async () => {
    // The two limits compose: whichever is smaller wins. A ramp allowance
    // of 500 must not enlarge a page the window had already narrowed to
    // 100. Asserted on the size actually claimed, because the totals across
    // a multi-page run cannot tell the two limits apart.
    const claims: number[] = [];
    let sentToday = 0;

    const { port: p } = port(
      {
        async inFlightCount() {
          return 4_900;
        },
        async readRampState() {
          return { ...young, sentToday };
        },
        async enqueueSends(input) {
          sentToday += input.recipients.length;
        },
      },
      1000,
    );

    const claim = p.claimNextRecipients.bind(p);
    p.claimNextRecipients = async (campaignId, limit) => {
      claims.push(limit);
      return claim(campaignId, limit);
    };

    await dispatchCampaign('c1', p, { page: 500, window: 5_000 });

    expect(claims[0]).toBe(100);
  });
});
