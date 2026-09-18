/**
 * Pause, resume, cancel and hold — the campaign state machine.
 *
 * Every transition is one guarded UPDATE. Never a read followed by a write:
 * two operators clicking pause and cancel within the same second must produce
 * one winner and one 409, and the only way to get that is to let Postgres
 * decide with `WHERE state = ANY($allowed)`.
 *
 * The three transient states here — `pausing`, `cancelling`, `queueing` — are
 * transient because in-flight work at the provider is allowed to finish. A
 * message already accepted by SES cannot be recalled, so "pause" means "stop
 * starting new ones" and the campaign sits in `pausing` until the in-flight
 * count reaches zero. F12's trace is what happens when that count never does:
 * the campaign sits there forever, the UI offers no action because the state
 * is transient, and the customer opens a ticket. Every one of them therefore
 * has a deadline and a reconciler, which live in sweeper.ts.
 *
 * `held` is deliberately not `paused`. A campaign the customer paused should
 * only resume when the customer says so; a campaign held for an exhausted
 * quota or a billing restriction resumes by itself when the restriction
 * clears. Collapsing them means either auto-resuming something a human
 * stopped, or requiring a human to restart something that stopped itself.
 */

export type CampaignState =
  | 'draft'
  | 'scheduled'
  | 'validating'
  | 'queueing'
  | 'sending'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'completed_with_errors'
  | 'held'
  | 'failed';

export type LifecycleAction = 'pause' | 'resume' | 'cancel' | 'hold' | 'release';

/**
 * The transition table.
 *
 * One place, so the API's guard and the repository's UPDATE cannot disagree
 * about what is legal. `from` is passed straight into `state = ANY($1)`.
 */
export const TRANSITIONS: Readonly<
  Record<LifecycleAction, { from: readonly CampaignState[]; to: CampaignState }>
> = {
  // Only a campaign that is actually sending can be paused. Pausing a
  // `queueing` campaign would leave the dispatcher enqueueing into a paused
  // campaign, and the send worker would defer every one of those jobs.
  pause: { from: ['sending', 'queueing'], to: 'pausing' },

  // Resume goes to `queueing`, not straight to `sending`: the dispatcher has
  // to restart and re-enqueue, and it is the dispatcher that marks `sending`
  // once a page is really in the queue.
  resume: { from: ['paused'], to: 'queueing' },

  // Cancellable from every state where work might still be outstanding,
  // including the two transient ones — a customer who hits cancel while a
  // pause is draining should not be told to wait for the pause first.
  cancel: {
    from: ['scheduled', 'queueing', 'sending', 'pausing', 'paused', 'held'],
    to: 'cancelling',
  },

  // Not customer-initiated. Billing restriction, exhausted quota, no healthy
  // sender.
  hold: { from: ['scheduled', 'queueing', 'sending'], to: 'held' },

  // The restriction cleared. Auto-resumable, which is the whole reason `held`
  // is a separate state from `paused`.
  release: { from: ['held'], to: 'queueing' },
};

/** States from which a campaign will never move again without a human. */
export const TERMINAL_STATES: readonly CampaignState[] = [
  'cancelled',
  'completed',
  'completed_with_errors',
  'failed',
];

/** States that must not persist: each has a deadline in sweeper.ts (R12). */
export const TRANSIENT_STATES: readonly CampaignState[] = [
  'validating',
  'queueing',
  'pausing',
  'cancelling',
];

export interface LifecyclePort {
  /**
   * The guarded transition. Returns the new state, or null when zero rows
   * matched — which means an illegal transition or somebody got there first.
   * Either way the answer is 409, never a retry.
   */
  transition(input: {
    campaignId: string;
    from: readonly CampaignState[];
    to: CampaignState;
    reason?: string;
  }): Promise<CampaignState | null>;

  /**
   * Sets the `campaign:{id}:halt` flag so workers stop within a batch rather
   * than within a page. An optimisation over the Postgres state, so a failure
   * to set it must not fail the pause.
   */
  setHaltFlag(campaignId: string, halted: boolean): Promise<void>;

  /**
   * Bulk `pending`/`queued` → `cancelled`, counters in the same transaction.
   *
   * Only for cancel. Queued jobs still in Redis are deliberately not purged:
   * the worker sees `cancelled` and acks immediately, and purging a queue by
   * filter is expensive and racy where letting jobs no-op is neither.
   */
  cancelOutstandingRecipients(campaignId: string): Promise<number>;

  /** `pending + queued + sending` from campaign_counters (R13, F13). */
  inFlightCount(campaignId: string): Promise<number>;

  /** Restarts the dispatcher after a resume or a release. */
  enqueueDispatch(campaignId: string): Promise<void>;

  recordEvent(input: { campaignId: string; eventType: string; detail: unknown }): Promise<void>;
}

export interface LifecycleResult {
  ok: boolean;
  state?: CampaignState;
  /** Set when the transition settled immediately rather than draining. */
  settled?: boolean;
  cancelledRecipients?: number;
  reason?: string;
}

/**
 * Applies a lifecycle action.
 *
 * The halt flag is set *before* the transition for a stop and *after* it for
 * a start, so there is never a window in which workers believe they may send
 * while Postgres says they may not. The reverse order would open exactly that
 * window for as long as the UPDATE takes.
 */
export async function applyLifecycleAction(
  campaignId: string,
  action: LifecycleAction,
  port: LifecyclePort,
  options: { reason?: string } = {},
): Promise<LifecycleResult> {
  const rule = TRANSITIONS[action];
  const stopping = action === 'pause' || action === 'cancel' || action === 'hold';

  if (stopping) {
    // Best effort. Redis is an optimisation here and Postgres is the truth,
    // so a flag that cannot be set must not prevent the pause itself.
    await setHaltQuietly(port, campaignId, true);
  }

  const state = await port.transition({
    campaignId,
    from: rule.from,
    to: rule.to,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });

  if (state === null) {
    if (stopping) {
      // Undo the flag: we did not stop anything, and leaving it set would
      // stall a campaign that is running perfectly well.
      await setHaltQuietly(port, campaignId, false);
    }

    return {
      ok: false,
      reason: `This campaign cannot be ${action}d in its current state`,
    };
  }

  let cancelledRecipients: number | undefined;

  if (action === 'cancel') {
    // Everything not yet at the provider stops now. In-flight sends are
    // allowed to finish; they are already someone else's problem.
    cancelledRecipients = await port.cancelOutstandingRecipients(campaignId);
  }

  if (action === 'resume' || action === 'release') {
    await setHaltQuietly(port, campaignId, false);
    // After the flag is cleared, or the dispatcher's first loop reads a halt
    // that is no longer true and exits immediately.
    await port.enqueueDispatch(campaignId);
  }

  // A transient state whose in-flight count is already zero should not wait
  // for a reconciler tick to settle. The common case — pausing a campaign
  // with nothing at the provider — resolves here.
  const settled = await settleIfDrained(campaignId, action, rule.to, port);

  await port.recordEvent({
    campaignId,
    eventType: `campaign.${action}`,
    detail: {
      state: settled ?? state,
      ...(cancelledRecipients === undefined ? {} : { cancelledRecipients }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
  });

  return {
    ok: true,
    state: settled ?? state,
    settled: settled !== null,
    ...(cancelledRecipients === undefined ? {} : { cancelledRecipients }),
  };
}

/** `pausing` → `paused` and `cancelling` → `cancelled`, once nothing is in flight. */
export async function settleIfDrained(
  campaignId: string,
  action: LifecycleAction,
  current: CampaignState,
  port: LifecyclePort,
): Promise<CampaignState | null> {
  const target = SETTLES_TO[current];
  if (target === undefined) return null;

  if ((await port.inFlightCount(campaignId)) > 0) return null;

  // Guarded like every other transition: the reconciler may have settled it
  // between the count and this write, and losing that race is fine.
  return port.transition({
    campaignId,
    from: [current],
    to: target,
    reason: `no work in flight after ${action}`,
  });
}

/** Where each draining state lands once its in-flight count reaches zero. */
const SETTLES_TO: Readonly<Partial<Record<CampaignState, CampaignState>>> = {
  pausing: 'paused',
  cancelling: 'cancelled',
};

async function setHaltQuietly(
  port: LifecyclePort,
  campaignId: string,
  halted: boolean,
): Promise<void> {
  try {
    await port.setHaltFlag(campaignId, halted);
  } catch {
    // Swallowed on purpose. The flag makes a pause felt within a batch
    // instead of within a page; Postgres is what makes it true.
  }
}
