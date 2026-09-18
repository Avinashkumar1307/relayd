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
}
