import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENFORCEMENT_SWEEP,
  runEnforcementSweep,
  type EnforcementSweepPort,
} from '../src/abuse/sweep.js';
import type { ComplaintMetrics, EnforcementStage } from '../src/abuse/enforcement.js';

/**
 * The enforcement sweep (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
 *
 * The policy is tested in `enforcement.test.ts`. What is tested here is the
 * loop around it, and every case is a way an automatic control fails in a way
 * nobody notices:
 *
 *   A paused workspace never being reassessed, because it sends nothing and
 *   therefore never appears in the traffic query again.
 *
 *   One workspace's bad data stopping every other workspace being assessed
 *   that night.
 *
 *   A metrics bug pausing the entire customer base in one run.
 *
 *   Two runs both telling the same customer they were paused.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-19T12:00:00.000Z');

interface WorldOptions {
  traffic?: string[];
  flagged?: { workspaceId: string; stage: EnforcementStage; enteredAt: Date; heldByOperator: boolean }[];
  metrics?: Record<string, ComplaintMetrics>;
  failFor?: string[];
  applyReturns?: boolean;
}

function world(options: WorldOptions = {}) {
  const applied: { workspaceId: string; stage: string }[] = [];
  const audited: { workspaceId: string; from: string; to: string }[] = [];
  const notified: { workspaceId: string; stage: string }[] = [];
  const metricsRead: string[] = [];

  const port: EnforcementSweepPort = {
    async workspacesWithTraffic() {
      return options.traffic ?? [];
    },
    async workspacesUnderEnforcement() {
      return options.flagged ?? [];
    },
    async metricsFor(workspaceId) {
      metricsRead.push(workspaceId);

      if (options.failFor?.includes(workspaceId) === true) {
        throw new Error(`metrics unavailable for ${workspaceId}`);
      }

      return options.metrics?.[workspaceId] ?? { sent: 10_000, complaints: 0, hardBounces: 0 };
    },
    async applyStage(input) {
      applied.push({ workspaceId: input.workspaceId, stage: input.stage });
      return options.applyReturns ?? true;
    },
    async recordAction(input) {
      audited.push({ workspaceId: input.workspaceId, from: input.from, to: input.to });
    },
    async notify(input) {
      notified.push({ workspaceId: input.workspaceId, stage: input.stage });
    },
    now() {
      return NOW;
    },
  };

  return { port, applied, audited, notified, metricsRead };
}

const spammy: ComplaintMetrics = { sent: 10_000, complaints: 100, hardBounces: 0 };
const clean: ComplaintMetrics = { sent: 10_000, complaints: 0, hardBounces: 0 };

describe('which workspaces get looked at', () => {
  it('assesses everyone who sent in the window', () => {
    // Where a new problem appears. Bounded by real traffic rather than by
    // the size of the workspaces table.
    const { port, metricsRead } = world({ traffic: ['ws-1', 'ws-2'] });

    return runEnforcementSweep(port).then(() => {
      expect(metricsRead.sort()).toEqual(['ws-1', 'ws-2']);
    });
  });

  it('also assesses everyone already under enforcement', async () => {
    // The case that matters and is easy to miss: a paused workspace sends
    // nothing, so it never appears in the traffic query again. Assessing
    // only the traffic set leaves it paused forever, which turns an
    // automatic control into a support queue.
    const { port, metricsRead } = world({
      traffic: [],
      flagged: [
        { workspaceId: 'ws-paused', stage: 'paused', enteredAt: NOW, heldByOperator: false },
      ],
    });

    await runEnforcementSweep(port);

    expect(metricsRead).toEqual(['ws-paused']);
  });

  it('assesses a workspace in both sets once', async () => {
    const { port, metricsRead } = world({
      traffic: ['ws-1'],
      flagged: [{ workspaceId: 'ws-1', stage: 'warned', enteredAt: NOW, heldByOperator: false }],
    });

    await runEnforcementSweep(port);

    expect(metricsRead).toEqual(['ws-1']);
  });

  it('uses the recorded stage, not a fresh one, for a workspace in both', async () => {
    // If the traffic entry overwrote the flagged one, every workspace would
    // be assessed as though it were clean and nothing would ever escalate
    // beyond the first rung or release at all.
    const entered = new Date(NOW.getTime() - 90 * DAY);
    const { port, applied } = world({
      traffic: ['ws-1'],
      flagged: [{ workspaceId: 'ws-1', stage: 'paused', enteredAt: entered, heldByOperator: false }],
      metrics: { 'ws-1': clean },
    });

    await runEnforcementSweep(port);

    expect(applied).toEqual([{ workspaceId: 'ws-1', stage: 'review_required' }]);
  });
});

describe('applying a decision', () => {
  it('pauses, audits and notifies', async () => {
    // docs/06: "Every enforcement action writes to `audit_logs`." And a
    // pause nobody is told about is indistinguishable from an outage — the
    // customer's first move is a ticket about the wrong thing.
    const { port, applied, audited, notified } = world({
      traffic: ['ws-1'],
      metrics: { 'ws-1': spammy },
    });

    const result = await runEnforcementSweep(port);

    expect(applied).toEqual([{ workspaceId: 'ws-1', stage: 'paused' }]);
    expect(audited).toEqual([{ workspaceId: 'ws-1', from: 'none', to: 'paused' }]);
    expect(notified).toEqual([{ workspaceId: 'ws-1', stage: 'paused' }]);
    expect(result.escalated).toBe(1);
  });

  it('records where the workspace came from, not just where it went', async () => {
    // "Paused" on its own does not say whether this was a first offence or a
    // workspace that had already been warned twice.
    const { port, audited } = world({
      traffic: ['ws-1'],
      flagged: [{ workspaceId: 'ws-1', stage: 'warned', enteredAt: NOW, heldByOperator: false }],
      metrics: { 'ws-1': spammy },
    });

    await runEnforcementSweep(port);

    expect(audited[0]).toMatchObject({ from: 'warned', to: 'paused' });
  });

  it('neither audits nor notifies when the stage was already set', async () => {
    // Another run got there first. The customer should not receive two
    // emails telling them they were paused.
    const { port, audited, notified } = world({
      traffic: ['ws-1'],
      metrics: { 'ws-1': spammy },
      applyReturns: false,
    });

    const result = await runEnforcementSweep(port);

    expect(audited).toEqual([]);
    expect(notified).toEqual([]);
    expect(result.escalated).toBe(0);
  });

  it('does nothing at all for a clean workspace', async () => {
    const { port, applied, notified } = world({ traffic: ['ws-1'], metrics: { 'ws-1': clean } });

    await runEnforcementSweep(port);

    expect(applied).toEqual([]);
    expect(notified).toEqual([]);
  });
});

describe('one workspace cannot stop the sweep', () => {
  it('carries on past a workspace whose metrics fail', async () => {
    // The ones that go unassessed would otherwise be disproportionately the
    // ones sending hardest, since a big workspace is the likeliest to have
    // the row that breaks the query.
    const { port, applied } = world({
      traffic: ['ws-bad', 'ws-1'],
      failFor: ['ws-bad'],
      metrics: { 'ws-1': spammy },
    });

    const result = await runEnforcementSweep(port);

    expect(result.failed).toEqual(['ws-bad']);
    expect(applied).toEqual([{ workspaceId: 'ws-1', stage: 'paused' }]);
  });

  it('reports failures rather than swallowing them', async () => {
    // A sweep that silently skipped would look identical to a night when
    // everybody was well behaved.
    const { port } = world({ traffic: ['ws-bad'], failFor: ['ws-bad'] });

    const result = await runEnforcementSweep(port);

    expect(result.failed).toHaveLength(1);
    expect(result.assessed).toBe(0);
  });
});

describe('a metrics bug cannot pause everybody', () => {
  it('stops escalating past the ceiling', async () => {
    // The blast radius. If the rate query broke and made every workspace
    // look like a spammer, an unbounded sweep would pause the entire
    // customer base in one night — a company-ending outage that also
    // destroys the trust needed to run any automatic enforcement afterwards.
    const traffic = Array.from({ length: 20 }, (_, index) => `ws-${index}`);
    const metrics = Object.fromEntries(traffic.map((id) => [id, spammy]));

    const { port, applied } = world({ traffic, metrics });

    const result = await runEnforcementSweep(port, {
      ...DEFAULT_ENFORCEMENT_SWEEP,
      maxEscalationsPerRun: 3,
    });

    expect(result.escalated).toBe(3);
    expect(applied).toHaveLength(3);
  });

  it('still releases workspaces once the ceiling is hit', async () => {
    // A run that stopped entirely would also strand every workspace waiting
    // to come back, which punishes the ones that already cleaned up.
    const entered = new Date(NOW.getTime() - 90 * DAY);

    // The two spammers are listed *before* the recovered workspace, so the
    // ceiling is already reached by the time the release is considered.
    // With them listed after, a ceiling that also blocked releases would
    // still pass this test — the release would happen before any escalation
    // did.
    const { port, applied } = world({
      flagged: [
        { workspaceId: 'ws-spam-1', stage: 'warned', enteredAt: NOW, heldByOperator: false },
        { workspaceId: 'ws-spam-2', stage: 'warned', enteredAt: NOW, heldByOperator: false },
        { workspaceId: 'ws-recovered', stage: 'warned', enteredAt: entered, heldByOperator: false },
      ],
      metrics: { 'ws-spam-1': spammy, 'ws-spam-2': spammy, 'ws-recovered': clean },
    });

    const result = await runEnforcementSweep(port, {
      ...DEFAULT_ENFORCEMENT_SWEEP,
      maxEscalationsPerRun: 1,
    });

    expect(result.released).toBe(1);
    expect(applied).toContainEqual({ workspaceId: 'ws-recovered', stage: 'none' });
  });

  it('has a ceiling by default', async () => {
    // Without a default, a caller that forgot to pass options gets the
    // unbounded behaviour this exists to prevent.
    expect(DEFAULT_ENFORCEMENT_SWEEP.maxEscalationsPerRun).toBeGreaterThan(0);
    expect(DEFAULT_ENFORCEMENT_SWEEP.maxEscalationsPerRun).toBeLessThan(1_000);
  });
});

describe('the window', () => {
  it('passes the configured window to both queries', async () => {
    // A traffic query over 30 days paired with a metrics query over 7 would
    // compute a rate against the wrong denominator — and it would be wrong
    // in the direction that pauses people.
    const windows: number[] = [];

    const { port } = world({ traffic: ['ws-1'] });
    const wrapped: EnforcementSweepPort = {
      ...port,
      async workspacesWithTraffic(days) {
        windows.push(days);
        return ['ws-1'];
      },
      async metricsFor(_id, days) {
        windows.push(days);
        return clean;
      },
    };

    await runEnforcementSweep(wrapped, { ...DEFAULT_ENFORCEMENT_SWEEP, windowDays: 14 });

    expect(windows).toEqual([14, 14]);
  });
});
