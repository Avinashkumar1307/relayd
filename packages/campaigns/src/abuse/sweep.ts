import {
  decide,
  type ComplaintMetrics,
  type EnforcementDecision,
  type EnforcementStage,
  type EnforcementState,
} from './enforcement.js';

/**
 * The enforcement sweep (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
 *
 * Runs nightly from `scheduled_jobs`, as the `enforcement-sweep` job type,
 * which is on the cross-tenant allowlist in `packages/queue/global-jobs.ts`.
 *
 * The policy is in `enforcement.ts` and is pure. This is the loop: which
 * workspaces to look at, in what order, and what to do with the answer.
 *
 * ## Which workspaces
 *
 * Two sets, and both are needed:
 *
 *   Everyone who **sent** in the window, because that is where a new problem
 *   appears. Bounded by real traffic rather than by the size of the
 *   workspaces table.
 *
 *   Everyone already **under enforcement**, because a paused workspace sends
 *   nothing and would therefore never appear in the first set again — it
 *   would sit paused forever, which is the failure that turns an automatic
 *   control into a support queue.
 *
 * ## One workspace's failure is not the sweep's failure
 *
 * A workspace whose metrics cannot be read is skipped and counted, not
 * thrown. The alternative is that one malformed row stops every other
 * workspace being assessed that night, and the ones that go unassessed are
 * disproportionately the ones sending hardest.
 */

export interface EnforcementSweepPort {
  /** Workspaces that sent in the window. The source of new problems. */
  workspacesWithTraffic(windowDays: number): Promise<string[]>;

  /** Workspaces already flagged. The source of releases. */
  workspacesUnderEnforcement(): Promise<
    { workspaceId: string; stage: EnforcementStage; enteredAt: Date; heldByOperator: boolean }[]
  >;

  /** Sends, complaints and hard bounces over the window, for one workspace. */
  metricsFor(workspaceId: string, windowDays: number): Promise<ComplaintMetrics>;

  /** Applies a decision. Returns false when the stage was already set. */
  applyStage(input: {
    workspaceId: string;
    stage: EnforcementStage;
    reason: string;
    observedRate: number | null;
    observedSends: number | null;
    at: Date;
  }): Promise<boolean>;

  /**
   * docs/06: "Every enforcement action writes to `audit_logs`."
   *
   * Separate from `applyStage` so the audit row is written by the caller
   * that knows the actor, and so a stage write that changed nothing does not
   * produce an audit row saying it did.
   */
  recordAction(input: {
    workspaceId: string;
    from: EnforcementStage;
    to: EnforcementStage;
    reason: string;
    rate: number | null;
  }): Promise<void>;

  /**
   * Tells the workspace. A pause nobody is told about is indistinguishable
   * from an outage, and the customer's first move is to open a ticket about
   * the wrong thing.
   */
  notify(input: {
    workspaceId: string;
    stage: EnforcementStage;
    reason: string;
    rate: number | null;
  }): Promise<void>;

  now(): Date;
}

export interface EnforcementSweepResult {
  assessed: number;
  escalated: number;
  released: number;
  skipped: number;
  /** Workspace ids whose metrics could not be read. */
  failed: string[];
}

export interface EnforcementSweepOptions {
  windowDays: number;
  /**
   * A ceiling on escalations in one run.
   *
   * If a bug in the metrics query made every workspace look like a spammer,
   * an unbounded sweep would pause the entire customer base in one night.
   * Past this the run stops and reports — a partial sweep is recoverable and
   * gets retried; a total one is a company-ending outage that also destroys
   * the trust needed to run any automatic enforcement afterwards.
   */
  maxEscalationsPerRun: number;
}

export const DEFAULT_ENFORCEMENT_SWEEP: EnforcementSweepOptions = {
  windowDays: 30,
  maxEscalationsPerRun: 50,
};

export async function runEnforcementSweep(
  port: EnforcementSweepPort,
  options: EnforcementSweepOptions = DEFAULT_ENFORCEMENT_SWEEP,
): Promise<EnforcementSweepResult> {
  const now = port.now();
  const result: EnforcementSweepResult = { assessed: 0, escalated: 0, released: 0, skipped: 0, failed: [] };

  const flagged = await port.workspacesUnderEnforcement();
  const withTraffic = await port.workspacesWithTraffic(options.windowDays);

  const states = new Map<string, EnforcementState>();

  for (const row of flagged) {
    states.set(row.workspaceId, {
      stage: row.stage,
      enteredAt: row.enteredAt,
      heldByOperator: row.heldByOperator,
    });
  }

  // A workspace that sent but has never been flagged starts at `none`, with
  // the clock at `now` — it has no recovery period to serve.
  for (const workspaceId of withTraffic) {
    if (!states.has(workspaceId)) {
      states.set(workspaceId, { stage: 'none', enteredAt: now, heldByOperator: false });
    }
  }

  for (const [workspaceId, state] of states) {
    let decision: EnforcementDecision;

    try {
      const metrics = await port.metricsFor(workspaceId, options.windowDays);
      decision = decide(state, metrics, now);
      result.assessed += 1;
    } catch {
      // Counted, not thrown. One malformed row must not stop every other
      // workspace being assessed tonight, and the ones that go unassessed
      // would be disproportionately the ones sending hardest.
      result.failed.push(workspaceId);
      continue;
    }

    if (decision.action === 'none') {
      result.skipped += 1;
      continue;
    }

    if (decision.action === 'escalate' && result.escalated >= options.maxEscalationsPerRun) {
      // Stop escalating, but keep going: releases are still safe to apply,
      // and a run that stopped entirely would also strand every workspace
      // waiting to come back.
      result.skipped += 1;
      continue;
    }

    const to = decision.to;
    const reason = decision.action === 'escalate' ? decision.trigger : 'clean';
    const rate = decision.action === 'escalate' ? decision.rate : null;

    const changed = await port.applyStage({
      workspaceId,
      stage: to,
      reason,
      observedRate: rate,
      observedSends: null,
      at: now,
    });

    // Nothing changed means another run got there first. No audit row and no
    // notification: the customer should not receive two emails telling them
    // they were paused.
    if (!changed) {
      result.skipped += 1;
      continue;
    }

    await port.recordAction({ workspaceId, from: state.stage, to, reason, rate });
    await port.notify({ workspaceId, stage: to, reason, rate });

    if (decision.action === 'escalate') result.escalated += 1;
    else result.released += 1;
  }

  return result;
}
