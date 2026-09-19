/**
 * The dispatch loop.
 *
 * One job per campaign, long-running and self-refilling. It does not enqueue
 * two million jobs at once: it enqueues a bounded window and refills as work
 * completes, so Redis holds O(window) and not O(recipients).
 *
 * Running three dispatchers for one campaign gains nothing — the claim query
 * already serialises them with `FOR UPDATE SKIP LOCKED` — and it triples the
 * chance of a throttle miscalculation. The queue catalogue gives
 * `campaign-dispatch` a concurrency of one per campaign for that reason.
 *
 * The one genuinely dangerous moment is between the claim committing and the
 * enqueue returning (F3). Five hundred rows are `queued` in Postgres; if the
 * task is killed before `addBulk` lands, they are in no queue and nothing
 * scans for `queued`. A handled failure releases them here, immediately. An
 * unhandled one — SIGKILL, OOM, a spot reclaim — is what `recipient-sweeper`
 * is for, and F1's guarded claim makes the resulting double-claim harmless.
 */

/** The window of in-flight work, and the page the claim takes. */
export const DISPATCH_WINDOW = 5_000;
export const DISPATCH_PAGE = 500;

/** Campaign states in which the dispatcher should keep claiming. */
const DISPATCHABLE_STATES = new Set(['queueing', 'sending']);

import { allowanceForBatch, type WorkspaceTrust } from '../abuse/ramp.js';

export type DispatchStop =
  | 'completed'
  | 'drained'
  | 'not_dispatchable'
  | 'halted'
  | 'ramp_capped'
  | 'window_stalled';

export interface DispatchableCampaign {
  id: string;
  workspaceId: string;
  state: string;
  /** Null means send as fast as the provider limits allow. */
  throttlePerHour: number | null;
}

export interface ClaimedRecipient {
  id: string;
  workspaceId: string;
}

export interface DispatchPort {
  /** One row. Re-read every page, so a pause takes effect within one page. */
  readCampaignForDispatch(campaignId: string): Promise<DispatchableCampaign | null>;

  /**
   * `queued + sending` from `campaign_counters` (F13).
   *
   * A single-row read rather than a `COUNT(*)` over `campaign_recipients`,
   * which at 500k recipients is a sequential scan competing with this
   * dispatcher's own writes.
   */
  inFlightCount(campaignId: string): Promise<number>;

  /**
   * The new-workspace ramp inputs: when the workspace was created, its trust
   * row, and how many it has already sent today (docs/06 "Anti-abuse").
   *
   * Read every page, not once per dispatch, for the same reason the campaign
   * state is: a cap checked once at the top of a 500k-recipient dispatch is
   * not a cap. Three values in one call because they are compared against
   * each other and must describe the same moment.
   *
   * Returning null means the workspace is not ramped and the cap does not
   * apply — an established workspace pays nothing for this check beyond the
   * read.
   */
  readRampState(workspaceId: string): Promise<{
    createdAt: Date;
    trust: WorkspaceTrust | null;
    sentToday: number;
  } | null>;

  /**
   * The atomic claim, safe with N concurrent dispatchers:
   *
   * `WITH picked AS (SELECT id FROM campaign_recipients WHERE campaign_id=$1
   *  AND state='pending' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
   *  UPDATE ... SET state='queued', queued_at=now() ... RETURNING ...`
   */
  claimNextRecipients(campaignId: string, limit: number): Promise<ClaimedRecipient[]>;

  /** `jobId = send:{recipientId}` — a dedupe optimisation, never the guard. */
  enqueueSends(input: {
    campaignId: string;
    recipients: readonly ClaimedRecipient[];
  }): Promise<void>;

  /**
   * Returns claimed rows to `pending` after a *handled* enqueue failure.
   *
   * The fast path only. A killed process never reaches it, which is why the
   * sweeper exists rather than instead of it.
   */
  releaseClaims(input: { campaignId: string; recipientIds: readonly string[] }): Promise<void>;

  /** Guarded `queueing -> sending`, once the first page is really enqueued. */
  markSending(campaignId: string): Promise<void>;

  /**
   * Guarded completion (F12): `WHERE pending + queued + sending = 0`.
   * Returns false when the race was lost, which is not an error.
   */
  maybeComplete(campaignId: string): Promise<boolean>;

  /**
   * The `campaign:{id}:halt` Redis flag — an optimisation so a pause is felt
   * without waiting for the next campaign read. Postgres is the truth, so an
   * unreachable Redis must answer false, not throw.
   */
  isHalted(campaignId: string): Promise<boolean>;

  sleep(ms: number): Promise<void>;

  /**
   * The clock. Injected rather than called directly so the ramp's day
   * boundary can be tested — the interesting cases are all at UTC midnight,
   * and a test that waits for one is not a test.
   */
  now(): Date;

  recordEvent(input: { campaignId: string; eventType: string; detail: unknown }): Promise<void>;
}

export interface DispatchOptions {
  window?: number;
  page?: number;
  /** How long to wait when the window is full. */
  pollMs?: number;
  /**
   * How many consecutive full-window polls to tolerate before giving up.
   *
   * A campaign whose in-flight count never falls has something wrong with it
   * — stuck `sending` rows the sweeper has not yet reached, usually. Spinning
   * for the job's six-hour timeout holds a worker slot for no reason; exiting
   * lets the reconciler re-dispatch once it has cleaned up.
   */
  maxStallPolls?: number;
}

export interface DispatchResult {
  stopped: DispatchStop;
  enqueued: number;
  pages: number;
  detail?: string;
}

export async function dispatchCampaign(
  campaignId: string,
  port: DispatchPort,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const window = options.window ?? DISPATCH_WINDOW;
  const page = options.page ?? DISPATCH_PAGE;
  const pollMs = options.pollMs ?? 500;
  const maxStallPolls = options.maxStallPolls ?? 240;

  let enqueued = 0;
  let pages = 0;
  let stallPolls = 0;
  let markedSending = false;

  for (;;) {
    // 1. Postgres decides. Re-read every page so a pause, a cancel or a
    //    dunning hold takes effect within one page rather than one drain.
    const campaign = await port.readCampaignForDispatch(campaignId);

    if (campaign === null || !DISPATCHABLE_STATES.has(campaign.state)) {
      return {
        stopped: 'not_dispatchable',
        enqueued,
        pages,
        detail: campaign?.state ?? 'missing',
      };
    }

    // 2. The halt flag is only ever allowed to stop us early, never to keep
    //    us going — which is why it is checked after the state read, and why
    //    an unreachable Redis reads as "not halted" rather than propagating.
    //    Postgres already said `sending`; a cache outage must not pause a
    //    customer's campaign.
    if (await isHaltedOrFalse(port, campaignId)) {
      return { stopped: 'halted', enqueued, pages, detail: 'halt flag set' };
    }

    // 3. The window. Redis holds O(window), not O(recipients).
    const inFlight = await port.inFlightCount(campaignId);

    if (inFlight >= window) {
      stallPolls += 1;

      if (stallPolls > maxStallPolls) {
        await port.recordEvent({
          campaignId,
          eventType: 'dispatch.stalled',
          detail: { inFlight, window, polls: stallPolls },
        });

        return { stopped: 'window_stalled', enqueued, pages, detail: `${inFlight} in flight` };
      }

      await port.sleep(pollMs);
      continue;
    }

    stallPolls = 0;

    // 4. The new-workspace ramp (docs/06: "First 7 days capped at 500
    //    emails/day regardless of plan").
    //
    //    It trims the page rather than refusing it, which is what makes the
    //    cap a rate limit and not a wall: a 5,000-recipient campaign from a
    //    day-one workspace sends 500 today and the rest as the days pass.
    //    That is what a legitimate new customer expects and what a spammer
    //    finds useless.
    //
    //    Checked here rather than at launch for the same reason: refusing
    //    the launch would tell a real customer their campaign is too big,
    //    which is not true and not the message.
    //
    //    Deliberately *after* the entitlement check that happened at launch
    //    and not instead of it. An entitlement is bought, and a stolen card
    //    buys the largest one; the ramp is earned with time and behaviour,
    //    neither of which is purchasable.
    let allowed = Math.min(page, window - inFlight);
    const ramp = await port.readRampState(campaign.workspaceId);

    if (ramp !== null) {
      allowed = allowanceForBatch(
        { workspaceId: campaign.workspaceId, createdAt: ramp.createdAt, trust: ramp.trust },
        ramp.sentToday,
        allowed,
        port.now(),
      );

      if (allowed === 0) {
        // Not an error and not a completion. The campaign stays in
        // `sending`; the next scheduled dispatch picks it up, and the first
        // one after UTC midnight finds a fresh allowance.
        await port.recordEvent({
          campaignId,
          eventType: 'dispatch.ramp_capped',
          detail: { sentToday: ramp.sentToday },
        });

        return {
          stopped: 'ramp_capped',
          enqueued,
          pages,
          detail: `${ramp.sentToday} sent today on a new-workspace cap`,
        };
      }
    }

    // 5. The claim. `FOR UPDATE SKIP LOCKED`, so a second dispatcher takes
    //    the next page rather than blocking on this one.
    const claimed = await port.claimNextRecipients(campaignId, allowed);

    if (claimed.length === 0) {
      // Ran dry. Completion is guarded, so losing the race with the
      // reconciler just returns false.
      const completed = await port.maybeComplete(campaignId);
      return { stopped: completed ? 'completed' : 'drained', enqueued, pages };
    }

    // 6. The F3 window: these rows are `queued` in Postgres and in no queue
    //    until this returns.
    try {
      await port.enqueueSends({ campaignId, recipients: claimed });
    } catch (error) {
      await port.releaseClaims({
        campaignId,
        recipientIds: claimed.map((r) => r.id),
      });

      // Rethrown so the dispatch job retries. The claim is undone, so the
      // retry re-claims the same rows rather than skipping them.
      throw error;
    }

    enqueued += claimed.length;
    pages += 1;

    if (!markedSending && campaign.state === 'queueing') {
      // After the first page is really in the queue. A campaign marked
      // `sending` with nothing in flight reads as stuck to every reconciler
      // that looks at it.
      await port.markSending(campaignId);
      markedSending = true;
    }

    const delay = throttleDelay(campaign.throttlePerHour, claimed.length);
    if (delay > 0) await port.sleep(delay);
  }
}

/**
 * The halt flag, with a Redis outage reading as "not halted".
 *
 * The one direction the flag is allowed to move the decision is towards
 * stopping. Letting its failure stop a campaign would make Redis the system
 * of record for whether a customer's campaign runs, which is the thing the
 * whole queue design exists to avoid.
 */
async function isHaltedOrFalse(port: DispatchPort, campaignId: string): Promise<boolean> {
  try {
    return await port.isHalted(campaignId);
  } catch {
    return false;
  }
}

/**
 * How long to wait after a page, to hold a campaign to its hourly throttle.
 *
 * Paced per page rather than per message: the per-provider rate limiter
 * already smooths within a page, and this only has to keep the hour's total
 * right.
 */
export function throttleDelay(throttlePerHour: number | null, sent: number): number {
  if (throttlePerHour === null || throttlePerHour <= 0 || sent <= 0) return 0;
  return Math.round((sent / throttlePerHour) * 3_600_000);
}
