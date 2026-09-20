import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { CampaignId, WorkspaceId } from '@relayd/types';
import { campaignDailyStats, campaignStats, deviceStats } from '../schema/analytics.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Analytics reads.
 *
 * Every query here goes to a rollup table, never to `email_events`. That is
 * the entire point of the rollups: the events table is the largest thing in
 * the system and a dashboard that queries it is a dashboard that gets slower
 * every week until somebody notices.
 *
 * The one exception is the raw event feed, which is explicitly a
 * debugging tool, is bounded by time and count, and says so.
 */

export interface CampaignStatsRow {
  campaignId: CampaignId;
  workspaceId: WorkspaceId;
  recipients: number;
  sent: number;
  failed: number;
  suppressed: number;
  deliveryUncertain: number;
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
  computedAt: Date;
  computedBy: 'incremental' | 'hourly';
}

export interface DailyStatsRow {
  day: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opensUniqueNonbot: number;
  clicksUnique: number;
  unsubscribed: number;
}

export interface LinkStatsRow {
  linkId: string;
  url: string;
  position: number;
  clicksTotal: number;
  clicksUnique: number;
  clicksUniqueNonbot: number;
}

export class AnalyticsRepository {
  constructor(private readonly db: Executor) {}

  async campaignStats(scope: WorkspaceScope, id: CampaignId): Promise<CampaignStatsRow | null> {
    const [row] = await this.db
      .select()
      .from(campaignStats)
      .where(
        and(eq(campaignStats.campaignId, id), eq(campaignStats.workspaceId, scope.workspaceId)),
      )
      .limit(1);

    return (row as unknown as CampaignStatsRow | undefined) ?? null;
  }

  /**
   * The timeline chart.
   *
   * Bounded by a day range rather than "all of it": a campaign that has been
   * running for two years has 730 rows, and every chart library given 730
   * points draws something nobody can read.
   */
  async campaignDaily(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; from: string; to: string },
  ): Promise<DailyStatsRow[]> {
    const rows = await this.db
      .select()
      .from(campaignDailyStats)
      .where(
        and(
          eq(campaignDailyStats.campaignId, input.campaignId),
          eq(campaignDailyStats.workspaceId, scope.workspaceId),
          gte(campaignDailyStats.day, input.from),
          lte(campaignDailyStats.day, input.to),
        ),
      )
      .orderBy(campaignDailyStats.day);

    return rows as unknown as DailyStatsRow[];
  }

  /**
   * The link heat table.
   *
   * Joined to `tracked_links` for the URL, because `link_stats` stores only
   * the id — the URL lives in one place so a campaign's links cannot be
   * rewritten by editing a stats row.
   */
  async campaignLinks(scope: WorkspaceScope, campaignId: CampaignId): Promise<LinkStatsRow[]> {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT ls.link_id              AS "linkId",
             tl.url                  AS "url",
             tl.position             AS "position",
             ls.clicks_total         AS "clicksTotal",
             ls.clicks_unique        AS "clicksUnique",
             ls.clicks_unique_nonbot AS "clicksUniqueNonbot"
        FROM link_stats ls
        JOIN tracked_links tl
          ON tl.id = ls.link_id AND tl.workspace_id = ls.workspace_id
       WHERE ls.workspace_id = ${scope.workspaceId}
         AND ls.campaign_id = ${campaignId}
       ORDER BY ls.clicks_unique DESC
       LIMIT 200
    `);

    return rows as unknown as LinkStatsRow[];
  }

  async campaignDevices(
    scope: WorkspaceScope,
    campaignId: CampaignId,
  ): Promise<{ deviceType: string; clientFamily: string; opens: number; clicks: number }[]> {
    const rows = await this.db
      .select({
        deviceType: deviceStats.deviceType,
        clientFamily: deviceStats.clientFamily,
        opens: deviceStats.opens,
        clicks: deviceStats.clicks,
      })
      .from(deviceStats)
      .where(
        and(eq(deviceStats.campaignId, campaignId), eq(deviceStats.workspaceId, scope.workspaceId)),
      )
      .orderBy(desc(deviceStats.opens));

    return rows;
  }

  async providerBreakdown(
    scope: WorkspaceScope,
    input: { from: string; to: string },
  ): Promise<
    {
      providerConnectionId: string;
      sent: number;
      delivered: number;
      bouncedHard: number;
      complained: number;
    }[]
  > {
    const { rows } = await this.db.execute<{
      providerConnectionId: string;
      sent: number;
      delivered: number;
      bouncedHard: number;
      complained: number;
    }>(sql`
      SELECT provider_connection_id AS "providerConnectionId",
             sum(sent)::int         AS "sent",
             sum(delivered)::int    AS "delivered",
             sum(bounced_hard)::int AS "bouncedHard",
             sum(complained)::int   AS "complained"
        FROM provider_stats
       WHERE workspace_id = ${scope.workspaceId}
         AND day BETWEEN ${input.from}::date AND ${input.to}::date
       GROUP BY provider_connection_id
       ORDER BY sum(sent) DESC
    `);

    return rows;
  }

  /**
   * The workspace overview.
   *
   * Aggregated from `campaign_daily_stats`, which is at most a few hundred
   * rows for any realistic range — never from `email_events`, and never from
   * `campaign_stats`, which has no time dimension and would give the same
   * answer for every range asked for.
   */
  async workspaceOverview(
    scope: WorkspaceScope,
    input: { from: string; to: string },
  ): Promise<
    {
      day: string;
      sent: number;
      delivered: number;
      bounced: number;
      complained: number;
      opensUniqueNonbot: number;
      clicksUnique: number;
      unsubscribed: number;
    }[]
  > {
    const { rows } = await this.db.execute<{
      day: string;
      sent: number;
      delivered: number;
      bounced: number;
      complained: number;
      opensUniqueNonbot: number;
      clicksUnique: number;
      unsubscribed: number;
    }>(sql`
      SELECT day::text                       AS "day",
             sum(sent)::int                  AS "sent",
             sum(delivered)::int             AS "delivered",
             sum(bounced)::int               AS "bounced",
             sum(complained)::int            AS "complained",
             sum(opens_unique_nonbot)::int   AS "opensUniqueNonbot",
             sum(clicks_unique)::int         AS "clicksUnique",
             sum(unsubscribed)::int          AS "unsubscribed"
        FROM campaign_daily_stats
       WHERE workspace_id = ${scope.workspaceId}
         AND day BETWEEN ${input.from}::date AND ${input.to}::date
       GROUP BY day
       ORDER BY day
    `);

    return rows;
  }

  /**
   * How many events the bot filter removed for one campaign.
   *
   * Read separately rather than stored on `campaign_stats`, because it is
   * the difference between two columns that are already there and storing a
   * third would give it a way to disagree with them.
   */
  async botFilteredFor(scope: WorkspaceScope, campaignId: CampaignId): Promise<number> {
    const stats = await this.campaignStats(scope, campaignId);
    if (stats === null) return 0;

    return Math.max(0, stats.opensUnique - stats.opensUniqueNonbot)
      + Math.max(0, stats.clicksUnique - stats.clicksUniqueNonbot);
  }

  /**
   * One campaign's delivery, split by the connection that carried it (G4a).
   *
   * **This is the one read in the product that aggregates
   * `campaign_recipients`, and it is deliberate.** There is no
   * `campaign_provider_stats` rollup: `provider_stats` is per connection per
   * day with no campaign dimension, and `campaign_stats` is per campaign with
   * no connection dimension, so the intersection the frame draws exists in
   * exactly one place — the recipient rows themselves, where
   * `provider_connection_id` was written at dispatch.
   *
   * It does not break CLAUDE.md section 12, which forbids computing campaign
   * *progress or completion* this way and points at `campaign_counters`.
   * Progress still comes from the counters; this is a finished campaign's
   * report. It is nonetheless O(recipients) and bounded only by
   * `uq_cr_campaign_contact`, so the honest note is in the batch report and
   * the rollup is the fix.
   *
   * `provider_connection_id` is nullable — a recipient suppressed before
   * dispatch never had one — so the null group is returned rather than
   * dropped, and the service labels it.
   */
  async campaignProviderTotals(
    scope: WorkspaceScope,
    campaignId: CampaignId,
  ): Promise<CampaignProviderTotalsRow[]> {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT provider_connection_id                                        AS "providerConnectionId",
             count(*) FILTER (WHERE state = 'sent')::int                   AS "sent",
             count(*) FILTER (WHERE delivery_state = 'delivered')::int     AS "delivered",
             count(*) FILTER (WHERE delivery_state = 'hard_bounced')::int  AS "bouncedHard",
             count(*) FILTER (WHERE delivery_state = 'soft_bounced')::int  AS "bouncedSoft",
             count(*) FILTER (WHERE delivery_state = 'complained')::int    AS "complained",
             count(*) FILTER (WHERE state = 'delivery_uncertain')::int     AS "uncertain",
             count(*) FILTER (WHERE state = 'failed')::int                 AS "failed"
        FROM campaign_recipients
       WHERE workspace_id = ${scope.workspaceId}
         AND campaign_id = ${campaignId}
       GROUP BY provider_connection_id
       ORDER BY count(*) FILTER (WHERE state = 'sent') DESC
    `);

    return rows as unknown as CampaignProviderTotalsRow[];
  }

  /**
   * Bounce and complaint totals for a range, split soft from hard.
   *
   * From `provider_stats` rather than `campaign_daily_stats`, which is the
   * only reason this is a separate method: the daily campaign rollup carries
   * one combined `bounced` column, and the dashboard's bounce meter draws two
   * tones. `provider_stats` keeps them apart, and summing it across
   * connections gives the workspace figure.
   */
  async bounceSplit(
    scope: WorkspaceScope,
    input: { from: string; to: string },
  ): Promise<BounceSplitRow> {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT coalesce(sum(sent), 0)::int         AS "sent",
             coalesce(sum(delivered), 0)::int    AS "delivered",
             coalesce(sum(bounced_soft), 0)::int AS "bouncedSoft",
             coalesce(sum(bounced_hard), 0)::int AS "bouncedHard",
             coalesce(sum(complained), 0)::int   AS "complained"
        FROM provider_stats
       WHERE workspace_id = ${scope.workspaceId}
         AND day BETWEEN ${input.from}::date AND ${input.to}::date
    `);

    return (
      (rows[0] as unknown as BounceSplitRow | undefined) ??
      { sent: 0, delivered: 0, bouncedSoft: 0, bouncedHard: 0, complained: 0 }
    );
  }

  /**
   * The dashboard's campaign rows (C1).
   *
   * Counts come from `campaign_counters` — one row per campaign, the F13
   * table that exists precisely so a dashboard listing eight campaigns is
   * eight single-row reads rather than eight `COUNT(*)`s over millions of
   * recipients (CLAUDE.md section 12). The feedback half comes from
   * `campaign_stats`, which is also one row per campaign.
   *
   * Both joins are LEFT: a draft has neither row, and a campaign launched
   * thirty seconds ago may have the counters and not yet the stats.
   */
  async dashboardCampaigns(
    scope: WorkspaceScope,
    input: { limit: number },
  ): Promise<DashboardCampaignRow[]> {
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit)));

    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT c.id                     AS "campaignId",
             c.name                   AS "name",
             c.status                 AS "status",
             c.recipient_count        AS "recipientCount",
             c.scheduled_at           AS "scheduledAt",
             c.launched_at            AS "launchedAt",
             c.completed_at           AS "completedAt",
             c.paused_at              AS "pausedAt",
             c.updated_at             AS "updatedAt",
             cc.total                 AS "total",
             cc.pending               AS "pending",
             cc.queued                AS "queued",
             cc.sending               AS "sending",
             cc.sent                  AS "sent",
             cc.failed                AS "failed",
             cc.suppressed            AS "suppressed",
             cc.uncertain             AS "uncertain",
             cs.delivered             AS "delivered",
             cs.bounced_soft          AS "bouncedSoft",
             cs.bounced_hard          AS "bouncedHard",
             cs.complained            AS "complained",
             cs.clicks_unique_nonbot  AS "clicksUniqueNonbot"
        FROM campaigns c
        LEFT JOIN campaign_counters cc
          ON cc.campaign_id = c.id AND cc.workspace_id = c.workspace_id
        LEFT JOIN campaign_stats cs
          ON cs.campaign_id = c.id AND cs.workspace_id = c.workspace_id
       WHERE c.workspace_id = ${scope.workspaceId}
         AND c.deleted_at IS NULL
       ORDER BY greatest(
                  coalesce(c.launched_at, c.created_at),
                  coalesce(c.scheduled_at, c.created_at),
                  c.updated_at
                ) DESC
       LIMIT ${limit}
    `);

    return rows.map(toDashboardCampaign);
  }

  /**
   * Sends this period that ended `delivery_uncertain` (D3).
   *
   * Summed from `campaign_counters`, one row per campaign, so this is a scan
   * of the workspace's campaigns and never of its recipients. Unbilled by
   * definition, and named on the dashboard because a customer counting their
   * own sends will otherwise find the number missing.
   */
  async uncertainSince(scope: WorkspaceScope, since: Date): Promise<number> {
    const { rows } = await this.db.execute<{ uncertain: number }>(sql`
      SELECT coalesce(sum(cc.uncertain), 0)::int AS "uncertain"
        FROM campaign_counters cc
        JOIN campaigns c
          ON c.id = cc.campaign_id AND c.workspace_id = cc.workspace_id
       WHERE cc.workspace_id = ${scope.workspaceId}
         AND coalesce(c.launched_at, c.created_at) >= ${since}
    `);

    return rows[0]?.uncertain ?? 0;
  }
}

export interface CampaignProviderTotalsRow {
  /** Null for recipients that never reached dispatch — suppressed, cancelled. */
  providerConnectionId: string | null;
  sent: number;
  delivered: number;
  bouncedHard: number;
  bouncedSoft: number;
  complained: number;
  uncertain: number;
  failed: number;
}

export interface BounceSplitRow {
  sent: number;
  delivered: number;
  bouncedSoft: number;
  bouncedHard: number;
  complained: number;
}

export interface DashboardCampaignRow {
  campaignId: string;
  name: string;
  status: string;
  recipientCount: number;
  scheduledAt: Date | null;
  launchedAt: Date | null;
  completedAt: Date | null;
  pausedAt: Date | null;
  updatedAt: Date;
  /** Null when the campaign has no counters row yet — a draft. */
  counters: {
    total: number;
    pending: number;
    queued: number;
    sending: number;
    sent: number;
    failed: number;
    suppressed: number;
    uncertain: number;
  } | null;
  /** Null when the rollup has not run for this campaign yet. */
  stats: {
    delivered: number;
    bouncedSoft: number;
    bouncedHard: number;
    complained: number;
    clicksUniqueNonbot: number;
  } | null;
}

function toDashboardCampaign(row: Record<string, unknown>): DashboardCampaignRow {
  const num = (key: string): number => Number(row[key] ?? 0);

  return {
    campaignId: String(row['campaignId']),
    name: String(row['name']),
    status: String(row['status']),
    recipientCount: num('recipientCount'),
    scheduledAt: (row['scheduledAt'] as Date | null) ?? null,
    launchedAt: (row['launchedAt'] as Date | null) ?? null,
    completedAt: (row['completedAt'] as Date | null) ?? null,
    pausedAt: (row['pausedAt'] as Date | null) ?? null,
    updatedAt: (row['updatedAt'] as Date | undefined) ?? new Date(0),
    counters:
      row['total'] === null || row['total'] === undefined
        ? null
        : {
            total: num('total'),
            pending: num('pending'),
            queued: num('queued'),
            sending: num('sending'),
            sent: num('sent'),
            failed: num('failed'),
            suppressed: num('suppressed'),
            uncertain: num('uncertain'),
          },
    stats:
      row['delivered'] === null || row['delivered'] === undefined
        ? null
        : {
            delivered: num('delivered'),
            bouncedSoft: num('bouncedSoft'),
            bouncedHard: num('bouncedHard'),
            complained: num('complained'),
            clicksUniqueNonbot: num('clicksUniqueNonbot'),
          },
  };
}
