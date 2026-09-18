/**
 * The two rollup passes (INVARIANTS R24, R26; review findings F24, F26).
 *
 * There are two on purpose, and the difference between them is the whole
 * design:
 *
 *   The **incremental** pass runs every 30 seconds over the campaigns in a
 *   Redis dirty set, so the counters move while a send is in progress. It is
 *   allowed to drift.
 *
 *   The **hourly** pass recomputes the same numbers from `email_events` over
 *   a bounded window and overwrites whatever the incremental pass left. It is
 *   a genuine recompute, never a watermark advance (R24/F24) — because a
 *   watermark plus a lost Redis set is a permanent gap, and nobody notices a
 *   gap in a number that only goes up.
 *
 * That asymmetry is what makes the Redis set safe to lose. It is a latency
 * optimisation and nothing else; deleting it costs at most an hour of
 * freshness on a figure nobody bills from.
 *
 * `contact_engagement` is written only by the hourly pass (R26/F26). Updating
 * it per event would put the heaviest write contention on exactly the
 * contacts that are mailed most.
 */

import { engagementScore } from './metrics.js';

/** How far back the hourly pass recomputes. */
export const HOURLY_WINDOW_MS = 26 * 60 * 60_000;

/**
 * Twenty-six hours, not twenty-four.
 *
 * The window has to cover more than the interval between runs, or an event
 * that arrives while the pass is running falls between two windows and is
 * never counted. Two hours of overlap also absorbs a run that was late, a
 * clock skew between the app and the database, and a provider that batches
 * its callbacks — all of which happen, and none of which should silently lose
 * a bounce.
 *
 * Overlap is free because the pass overwrites rather than accumulates.
 */

export interface EventCounts {
  delivered: number;
  bouncedHard: number;
  bouncedSoft: number;
  complained: number;
  unsubscribed: number;
  opensTotal: number;
  opensUnique: number;
  opensUniqueNonbot: number;
  clicksTotal: number;
  clicksUnique: number;
  clicksUniqueNonbot: number;
}

export interface DispatchCounts {
  recipients: number;
  sent: number;
  failed: number;
  suppressed: number;
  deliveryUncertain: number;
}

export interface RollupPort {
  /**
   * Campaign ids the event worker has touched since the last pass.
   *
   * Taken and cleared atomically, so an event arriving mid-pass marks the
   * campaign dirty again rather than being swallowed by the clear.
   */
  takeDirtyCampaigns(limit: number): Promise<string[]>;

  /** Puts ids back when a pass fails, so the next one picks them up. */
  restoreDirtyCampaigns(campaignIds: readonly string[]): Promise<void>;

  /** Aggregates `email_events` for one campaign over a window. */
  countEvents(input: {
    campaignId: string;
    since: Date | null;
  }): Promise<EventCounts>;

  /** The dispatch facts, from `campaign_recipients` — never from events. */
  countDispatch(campaignId: string): Promise<DispatchCounts>;

  /** Upsert. Running twice must leave what running once left. */
  writeCampaignStats(input: {
    campaignId: string;
    counts: EventCounts;
    dispatch: DispatchCounts;
    computedBy: 'incremental' | 'hourly';
  }): Promise<void>;

  /** Per-day rows for the timeline chart. Hourly only. */
  writeDailyStats(input: { campaignId: string; since: Date }): Promise<number>;

  writeProviderStats(input: { since: Date }): Promise<number>;
  writeDeviceStats(input: { campaignId: string; since: Date }): Promise<number>;
  writeLinkStats(input: { campaignId: string; since: Date }): Promise<number>;

  /** R26: the only write path to `contact_engagement`. */
  readContactEngagement(input: {
    workspaceId: string;
    since: Date;
    limit: number;
  }): Promise<
    {
      contactId: string;
      campaignsReceived: number;
      opens: number;
      clicks: number;
      lastOpenedAt: Date | null;
      lastClickedAt: Date | null;
      lastSentAt: Date | null;
    }[]
  >;

  writeContactEngagement(
    rows: readonly {
      contactId: string;
      campaignsReceived: number;
      opens: number;
      clicks: number;
      lastOpenedAt: Date | null;
      lastClickedAt: Date | null;
      lastSentAt: Date | null;
      engagementScore: number;
    }[],
  ): Promise<void>;

  /** Workspaces with any activity in the window. */
  activeWorkspaces(since: Date): Promise<string[]>;
}

export interface IncrementalResult {
  campaigns: number;
  failed: string[];
}

/**
 * The 30-second pass.
 *
 * Only the campaigns in the dirty set, and only `campaign_stats` — the daily,
 * device, link and provider tables are hourly, because nothing in the UI
 * needs them to move during a send and recomputing them every 30 seconds
 * would be most of the cost for none of the benefit.
 *
 * A campaign that fails goes back into the dirty set rather than being
 * dropped. The next pass retries it; the hourly pass would have repaired it
 * anyway, so this is about latency rather than correctness.
 */
export async function runIncremental(
  port: RollupPort,
  options: { limit?: number } = {},
): Promise<IncrementalResult> {
  const campaignIds = await port.takeDirtyCampaigns(options.limit ?? 500);
  if (campaignIds.length === 0) return { campaigns: 0, failed: [] };

  const failed: string[] = [];

  for (const campaignId of campaignIds) {
    try {
      // `since: null` — the whole campaign, not a window. The incremental
      // pass is a recompute too, just of a smaller set of campaigns. Making
      // it a delta would give it a watermark of its own to lose.
      const [counts, dispatch] = await Promise.all([
        port.countEvents({ campaignId, since: null }),
        port.countDispatch(campaignId),
      ]);

      await port.writeCampaignStats({
        campaignId,
        counts,
        dispatch,
        computedBy: 'incremental',
      });
    } catch {
      failed.push(campaignId);
    }
  }

  // Back into the set, so the next pass picks them up rather than waiting an
  // hour for the authoritative one.
  if (failed.length > 0) await port.restoreDirtyCampaigns(failed);

  return { campaigns: campaignIds.length - failed.length, failed };
}

export interface HourlyResult {
  campaigns: number;
  dailyRows: number;
  providerRows: number;
  deviceRows: number;
  linkRows: number;
  contacts: number;
  since: Date;
}

/**
 * The hourly authoritative pass.
 *
 * Recomputes from `email_events` over a bounded window and overwrites. The
 * window bound is what keeps the cost flat as the events table grows: a
 * campaign that finished last year is not recomputed, because nothing about
 * it can have changed.
 *
 * Campaigns come from the *events* in the window rather than from the dirty
 * set. That is the point of R24 — if this pass consulted the same Redis set
 * the incremental one does, a lost set would mean neither pass ever repaired
 * the gap.
 */
export async function runHourly(
  port: RollupPort,
  input: { campaignIds: readonly string[]; now: Date; windowMs?: number },
): Promise<HourlyResult> {
  const since = new Date(input.now.getTime() - (input.windowMs ?? HOURLY_WINDOW_MS));

  let dailyRows = 0;
  let deviceRows = 0;
  let linkRows = 0;

  for (const campaignId of input.campaignIds) {
    const [counts, dispatch] = await Promise.all([
      port.countEvents({ campaignId, since }),
      port.countDispatch(campaignId),
    ]);

    await port.writeCampaignStats({ campaignId, counts, dispatch, computedBy: 'hourly' });

    dailyRows += await port.writeDailyStats({ campaignId, since });
    deviceRows += await port.writeDeviceStats({ campaignId, since });
    linkRows += await port.writeLinkStats({ campaignId, since });
  }

  // Once for all campaigns: provider stats are per connection per day, and a
  // connection carries many campaigns.
  const providerRows = await port.writeProviderStats({ since });

  const contacts = await rollContactEngagement(port, { since, now: input.now });

  return {
    campaigns: input.campaignIds.length,
    dailyRows,
    providerRows,
    deviceRows,
    linkRows,
    contacts,
    since,
  };
}

/**
 * R26: the only place `contact_engagement` is written.
 *
 * A grep test enforces that. The score is recomputed wholesale from the
 * contact's history rather than incremented, so two passes over the same data
 * agree — which they would not if this added deltas.
 */
export async function rollContactEngagement(
  port: RollupPort,
  input: { since: Date; now: Date; batchSize?: number },
): Promise<number> {
  const batchSize = input.batchSize ?? 1_000;
  let written = 0;

  for (const workspaceId of await port.activeWorkspaces(input.since)) {
    const rows = await port.readContactEngagement({
      workspaceId,
      since: input.since,
      limit: batchSize,
    });

    if (rows.length === 0) continue;

    await port.writeContactEngagement(
      rows.map((row) => ({
        ...row,
        engagementScore: engagementScore({
          campaignsReceived: row.campaignsReceived,
          opens: row.opens,
          clicks: row.clicks,
          lastClickedAt: row.lastClickedAt,
          lastOpenedAt: row.lastOpenedAt,
          now: input.now,
        }),
      })),
    );

    written += rows.length;
  }

  return written;
}
