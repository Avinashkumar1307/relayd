import { describe, expect, it, vi } from 'vitest';
import {
  HOURLY_WINDOW_MS,
  rollContactEngagement,
  runHourly,
  runIncremental,
  type DispatchCounts,
  type EventCounts,
  type RollupPort,
} from '../src/rollup/rollup.js';

/**
 * The two rollup passes (INVARIANTS R24, R26; findings F24, F26).
 *
 * The property that matters is the one that is easiest to lose: the hourly
 * pass must be a genuine recompute, not a watermark advance. A watermark plus
 * a lost Redis dirty set is a permanent gap — and nobody notices a gap in a
 * number that only ever goes up, which is why this is tested from several
 * directions rather than once.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');

const COUNTS: EventCounts = {
  delivered: 900,
  bouncedHard: 20,
  bouncedSoft: 30,
  complained: 2,
  unsubscribed: 5,
  opensTotal: 1200,
  opensUnique: 600,
  opensUniqueNonbot: 420,
  clicksTotal: 300,
  clicksUnique: 180,
  clicksUniqueNonbot: 175,
};

const DISPATCH: DispatchCounts = {
  recipients: 1000,
  sent: 950,
  failed: 40,
  suppressed: 8,
  deliveryUncertain: 2,
};

function port(over: Partial<RollupPort> = {}) {
  const calls: string[] = [];
  const written: { campaignId: string; computedBy: string }[] = [];
  const windows: (Date | null)[] = [];
  let dirty = ['c1', 'c2'];

  const base: RollupPort = {
    async takeDirtyCampaigns() {
      calls.push('takeDirty');
      const taken = dirty;
      dirty = [];
      return taken;
    },
    async restoreDirtyCampaigns(ids) {
      calls.push('restoreDirty');
      dirty = [...dirty, ...ids];
    },
    async countEvents(input) {
      calls.push('countEvents');
      windows.push(input.since);
      return COUNTS;
    },
    async countDispatch() {
      calls.push('countDispatch');
      return DISPATCH;
    },
    async writeCampaignStats(input) {
      calls.push('writeCampaignStats');
      written.push({ campaignId: input.campaignId, computedBy: input.computedBy });
    },
    async writeDailyStats() {
      calls.push('writeDaily');
      return 3;
    },
    async writeProviderStats() {
      calls.push('writeProvider');
      return 4;
    },
    async writeDeviceStats() {
      calls.push('writeDevice');
      return 5;
    },
    async writeLinkStats() {
      calls.push('writeLink');
      return 6;
    },
    async activeWorkspaces() {
      calls.push('activeWorkspaces');
      return ['ws-1'];
    },
    async readContactEngagement() {
      calls.push('readEngagement');
      return [
        {
          contactId: 'ct1',
          campaignsReceived: 10,
          opens: 8,
          clicks: 4,
          lastOpenedAt: NOW,
          lastClickedAt: NOW,
          lastSentAt: NOW,
        },
      ];
    },
    async writeContactEngagement() {
      calls.push('writeEngagement');
    },
    ...over,
  };

  return { port: base, calls, written, windows, remaining: () => dirty };
}

describe('the incremental pass', () => {
  it('rolls up every campaign in the dirty set', async () => {
    const { port: p, written } = port();

    const result = await runIncremental(p);

    expect(result.campaigns).toBe(2);
    expect(written.map((w) => w.campaignId)).toEqual(['c1', 'c2']);
  });

  it('marks what it wrote as incremental', async () => {
    // So the UI can tell a 30-second figure from an authoritative one, and so
    // an operator can tell which job to blame.
    const { port: p, written } = port();

    await runIncremental(p);

    expect(written.every((w) => w.computedBy === 'incremental')).toBe(true);
  });

  it('does nothing at all when the set is empty', async () => {
    const { port: p, calls } = port({
      async takeDirtyCampaigns() {
        return [];
      },
    });

    expect((await runIncremental(p)).campaigns).toBe(0);
    expect(calls).not.toContain('countEvents');
  });

  it('recomputes the whole campaign rather than a delta', async () => {
    // A delta would need a watermark of its own, which is the thing R24
    // exists to keep out of this pipeline.
    const { port: p, windows } = port();

    await runIncremental(p);

    expect(windows.every((since) => since === null)).toBe(true);
  });

  it('touches only campaign_stats', async () => {
    // Recomputing the daily, device and link tables every 30 seconds would be
    // most of the cost for none of the benefit: nothing in the UI needs them
    // to move during a send.
    const { port: p, calls } = port();

    await runIncremental(p);

    expect(calls).not.toContain('writeDaily');
    expect(calls).not.toContain('writeDevice');
    expect(calls).not.toContain('writeLink');
    expect(calls).not.toContain('writeEngagement');
  });

  it('puts a failed campaign back in the set', async () => {
    // The hourly pass would repair it anyway, so this is about latency — but
    // dropping it means an hour of a visibly stuck counter.
    const { port: p, remaining } = port({
      async writeCampaignStats(input) {
        if (input.campaignId === 'c2') throw new Error('deadlock');
      },
    });

    const result = await runIncremental(p);

    expect(result.failed).toEqual(['c2']);
    expect(remaining()).toEqual(['c2']);
  });

  it('keeps going after one campaign fails', async () => {
    const { port: p } = port({
      async writeCampaignStats(input) {
        if (input.campaignId === 'c1') throw new Error('deadlock');
      },
    });

    expect((await runIncremental(p)).campaigns).toBe(1);
  });

  it('does not restore anything when nothing failed', async () => {
    const { port: p, calls } = port();
    await runIncremental(p);
    expect(calls).not.toContain('restoreDirty');
  });
});

describe('the hourly pass is a recompute (R24, F24)', () => {
  it('reads a bounded window rather than everything', async () => {
    // The bound is what keeps the cost flat as the events table grows: a
    // campaign that finished last year cannot have changed.
    const { port: p, windows } = port();

    await runHourly(p, { campaignIds: ['c1'], now: NOW });

    expect(windows[0]).toEqual(new Date(NOW.getTime() - HOURLY_WINDOW_MS));
  });

  it('overlaps the previous run rather than abutting it', async () => {
    // Twenty-six hours, not twenty-four. An event arriving while the pass
    // runs would otherwise fall between two windows and never be counted.
    expect(HOURLY_WINDOW_MS).toBeGreaterThan(24 * 60 * 60_000);
  });

  it('never consults the dirty set', async () => {
    // The whole of R24. If this pass read the same Redis set the incremental
    // one does, losing that set would mean neither pass ever repaired the gap.
    const { port: p, calls } = port();

    await runHourly(p, { campaignIds: ['c1'], now: NOW });

    expect(calls).not.toContain('takeDirty');
  });

  it('marks what it wrote as authoritative', async () => {
    const { port: p, written } = port();

    await runHourly(p, { campaignIds: ['c1'], now: NOW });

    expect(written[0]?.computedBy).toBe('hourly');
  });

  it('overwrites whatever the incremental pass left', async () => {
    // Both passes write the same row through the same upsert, so the later
    // one wins. That is what makes incremental drift self-healing.
    const { port: p, written } = port();

    await runIncremental(p);
    await runHourly(p, { campaignIds: ['c1'], now: NOW });

    expect(written.filter((w) => w.campaignId === 'c1').map((w) => w.computedBy)).toEqual([
      'incremental',
      'hourly',
    ]);
  });

  it('writes the daily, device and link tables too', async () => {
    const result = await runHourly(port().port, { campaignIds: ['c1'], now: NOW });

    expect(result).toMatchObject({ dailyRows: 3, deviceRows: 5, linkRows: 6 });
  });

  it('writes provider stats once, not once per campaign', async () => {
    // A connection carries many campaigns; per-campaign would write the same
    // rows repeatedly and race with itself.
    const writeProviderStats = vi.fn(async () => 4);
    const { port: p } = port({ writeProviderStats });

    await runHourly(p, { campaignIds: ['c1', 'c2', 'c3'], now: NOW });

    expect(writeProviderStats).toHaveBeenCalledOnce();
  });

  it('takes a caller-supplied window, so a backfill can widen it', async () => {
    const { port: p, windows } = port();

    await runHourly(p, { campaignIds: ['c1'], now: NOW, windowMs: 7 * 24 * 60 * 60_000 });

    expect(windows[0]).toEqual(new Date(NOW.getTime() - 7 * 24 * 60 * 60_000));
  });

  it('does nothing for an empty campaign list', async () => {
    const { port: p, written } = port();

    const result = await runHourly(p, { campaignIds: [], now: NOW });

    expect(written).toEqual([]);
    expect(result.campaigns).toBe(0);
  });
});

describe('dispatch facts come from recipients, not events', () => {
  it('reads both sources for every campaign', async () => {
    // `sent` is something we know directly. Deriving it from feedback would
    // make it depend on the provider telling us, which is exactly the
    // dependency the send path avoids.
    const { port: p, calls } = port();

    await runIncremental(p);

    expect(calls.filter((c) => c === 'countDispatch')).toHaveLength(2);
    expect(calls.filter((c) => c === 'countEvents')).toHaveLength(2);
  });

  it('passes both through to the write', async () => {
    let seen: { counts: EventCounts; dispatch: DispatchCounts } | undefined;
    const { port: p } = port({
      async writeCampaignStats(input) {
        seen = { counts: input.counts, dispatch: input.dispatch };
      },
    });

    await runIncremental(p);

    expect(seen?.dispatch.sent).toBe(950);
    expect(seen?.counts.delivered).toBe(900);
  });
});

describe('contact engagement (R26, F26)', () => {
  it('is written by the hourly pass', async () => {
    const { port: p, calls } = port();

    await runHourly(p, { campaignIds: ['c1'], now: NOW });

    expect(calls).toContain('writeEngagement');
  });

  it('is not written by the incremental pass', async () => {
    // Per-event updates would put the heaviest write contention on exactly
    // the contacts that are mailed most.
    const { port: p, calls } = port();

    await runIncremental(p);

    expect(calls).not.toContain('writeEngagement');
  });

  it('computes a score rather than incrementing one', async () => {
    // Two passes over the same data must agree, which they would not if this
    // added deltas.
    let scored: number | undefined;
    const { port: p } = port({
      async writeContactEngagement(rows) {
        scored = rows[0]?.engagementScore;
      },
    });

    await rollContactEngagement(p, { since: NOW, now: NOW });

    // 4 clicks and 8 opens over 10 campaigns, engaged today.
    expect(scored).toBe(Math.round(0.4 * 70 + 0.8 * 30));
  });

  it('is idempotent across two runs', async () => {
    const scores: number[] = [];
    const { port: p } = port({
      async writeContactEngagement(rows) {
        if (rows[0] !== undefined) scores.push(rows[0].engagementScore);
      },
    });

    await rollContactEngagement(p, { since: NOW, now: NOW });
    await rollContactEngagement(p, { since: NOW, now: NOW });

    expect(scores[0]).toBe(scores[1]);
  });

  it('skips a workspace with nothing to write', async () => {
    const write = vi.fn();
    const { port: p } = port({
      async readContactEngagement() {
        return [];
      },
      writeContactEngagement: write,
    });

    expect(await rollContactEngagement(p, { since: NOW, now: NOW })).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('covers every workspace with activity in the window', async () => {
    const seen: string[] = [];
    const { port: p } = port({
      async activeWorkspaces() {
        return ['ws-1', 'ws-2', 'ws-3'];
      },
      async readContactEngagement(input) {
        seen.push(input.workspaceId);
        return [];
      },
    });

    await rollContactEngagement(p, { since: NOW, now: NOW });

    expect(seen).toEqual(['ws-1', 'ws-2', 'ws-3']);
  });
});
