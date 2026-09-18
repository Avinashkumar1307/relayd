/**
 * The reconcilers between Postgres intent and Redis reality.
 *
 * Everything in the send path is a state machine in Postgres with a queue
 * alongside it, and every such pair has the same two failure modes: a row
 * whose job was never created, and a row whose job died mid-flight. Neither
 * is detectable from the queue — the job simply is not there — so both are
 * found by looking at rows whose state has lasted longer than it should.
 *
 *   R3/F3 — `queued` for more than five minutes with no job. The dispatcher
 *   committed the claim and was killed before `addBulk` returned. Returning
 *   them to `pending` lets the normal dispatcher re-claim them, and R1's
 *   guarded claim makes a double-claim harmless.
 *
 *   R5/F5 — `sending` with `provider_attempt_started_at` more than ten
 *   minutes old. The provider may have accepted it; nothing else will ever
 *   touch this row. It becomes `delivery_uncertain`: terminal, *unmetered*,
 *   and reported to the customer as its own count (D3). A later provider
 *   event carrying the message id can still reconcile it to `sent`.
 *
 *   R12/F12 — a transient campaign state with no deadline is a bug in every
 *   system that has one. `pausing` waiting on a recipient that will never
 *   move sits there until someone opens a ticket.
 *
 * The order within a tick matters and is the one piece of judgement here:
 * recipients are swept before campaigns. A `pausing` campaign stuck on one
 * `sending` row exits `pausing` on its own once that row becomes terminal, so
 * sweeping first means the campaign deadline fires only for campaigns that
 * are genuinely stuck rather than merely slow.
 */

/** R3: how long a `queued` row may go without a job before it is re-claimed. */
export const STALE_QUEUED_MS = 5 * 60_000;

/** R5: how long a provider attempt may run before the outcome is unknowable. */
export const STALE_SENDING_MS = 10 * 60_000;

/** R12: how long any transient campaign state may last. */
export const TRANSIENT_DEADLINE_MS = 10 * 60_000;

/** A bound on one pass, so a sweep cannot lock the table behind a long write. */
export const SWEEP_BATCH = 1_000;

/**
 * Where each transient campaign state goes when its deadline passes (R12).
 *
 * `pausing` and `cancelling` reach the state the customer asked for.
 * `validating` and `queueing` have no such state — nothing the customer asked
 * for happened — so they fail with a reason and the campaign is relaunchable.
 */
export const TRANSIENT_EXITS = {
  pausing: 'paused',
  cancelling: 'cancelled',
  validating: 'failed',
  queueing: 'failed',
} as const satisfies Readonly<Record<string, string>>;

export type TransientState = keyof typeof TRANSIENT_EXITS;

/** Campaign states whose `queued` rows the sweeper may return to `pending`. */
export const SWEEPABLE_CAMPAIGN_STATES = ['sending', 'pausing'] as const;

export interface SweeperPort {
  /**
   * R3: `queued` rows older than the cutoff, in campaigns still sending, back
   * to `pending` with `queued_at = NULL`. Counters move in the same
   * transaction (R13). Returns how many.
   */
  reclaimStaleQueued(input: { olderThan: Date; limit: number }): Promise<number>;

  /**
   * R5: `sending` rows whose provider attempt started before the cutoff
   * become `delivery_uncertain`.
   *
   * Terminal, `terminal_at` set, `metered` untouched — the trigger would
   * refuse to clear it anyway, and it is false here because the commit never
   * ran. Counters move in the same transaction.
   */
  markStaleSendingUncertain(input: { olderThan: Date; limit: number }): Promise<number>;

  /**
   * R12: campaigns that have been in `state` since before the cutoff.
   *
   * Returned rather than transitioned in bulk so each exit can be guarded and
   * recorded individually — a campaign that moved on its own between the read
   * and the write must not be dragged back.
   */
  findExpiredTransient(input: {
    state: TransientState;
    olderThan: Date;
    limit: number;
  }): Promise<readonly string[]>;

  /** Guarded `state -> to`. False means it moved on its own; not an error. */
  forceTransition(input: {
    campaignId: string;
    from: TransientState;
    to: string;
    reason: string;
  }): Promise<boolean>;

  /**
   * R13: campaigns in `sending` or `pausing` with no counter movement since
   * the cutoff. The dispatcher checks completion when it runs dry; this
   * catches the campaigns whose dispatcher is no longer running.
   */
  findIdleCampaigns(input: { idleSince: Date; limit: number }): Promise<readonly string[]>;

  /** The same guarded completion the dispatcher uses: `pending+queued+sending = 0`. */
  maybeComplete(campaignId: string): Promise<boolean>;

  recordEvent(input: { campaignId: string; eventType: string; detail: unknown }): Promise<void>;
}

export interface SweepOptions {
  now?: Date;
  limit?: number;
  staleQueuedMs?: number;
  staleSendingMs?: number;
  transientDeadlineMs?: number;
}

export interface SweepResult {
  reclaimed: number;
  uncertain: number;
  forced: { campaignId: string; from: TransientState; to: string }[];
  completed: string[];
}

/**
 * One pass of `recipient-sweeper` and `campaign-reconcile`.
 *
 * Run from the scheduler every 60 seconds. Each step is independently
 * idempotent and bounded, so a pass that dies half-way simply leaves work for
 * the next one.
 */
export async function sweepOnce(
  port: SweeperPort,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SWEEP_BATCH;
  const ms = (n: number): Date => new Date(now.getTime() - n);

  // 1. Recipients first. A campaign stuck in `pausing` on one dead `sending`
  //    row exits on its own once that row goes terminal, so this removes most
  //    of the work step 3 would otherwise have to force.
  const reclaimed = await port.reclaimStaleQueued({
    olderThan: ms(options.staleQueuedMs ?? STALE_QUEUED_MS),
    limit,
  });

  const uncertain = await port.markStaleSendingUncertain({
    olderThan: ms(options.staleSendingMs ?? STALE_SENDING_MS),
    limit,
  });

  // 2. Campaigns whose dispatcher is gone. The dispatcher checks completion
  //    when it runs dry; a killed one never runs dry.
  const completed: string[] = [];
  const idle = await port.findIdleCampaigns({
    idleSince: ms(TRANSIENT_DEADLINE_MS),
    limit,
  });

  for (const campaignId of idle) {
    if (await port.maybeComplete(campaignId)) {
      completed.push(campaignId);
      await port.recordEvent({
        campaignId,
        eventType: 'campaign.completed',
        detail: { by: 'reconciler' },
      });
    }
  }

  // 3. Transient states that have outlived their deadline (R12).
  const forced: SweepResult['forced'] = [];
  const deadline = ms(options.transientDeadlineMs ?? TRANSIENT_DEADLINE_MS);

  for (const [from, to] of Object.entries(TRANSIENT_EXITS) as [TransientState, string][]) {
    const expired = await port.findExpiredTransient({ state: from, olderThan: deadline, limit });

    for (const campaignId of expired) {
      const moved = await port.forceTransition({
        campaignId,
        from,
        to,
        reason: `${from} exceeded its ${Math.round((options.transientDeadlineMs ?? TRANSIENT_DEADLINE_MS) / 60_000)} minute deadline`,
      });

      // False means it moved on its own between the read and the write, which
      // is the good outcome and not worth recording.
      if (!moved) continue;

      forced.push({ campaignId, from, to });
      await port.recordEvent({
        campaignId,
        eventType: 'campaign.forced_transition',
        detail: { from, to },
      });
    }
  }

  return { reclaimed, uncertain, forced, completed };
}
