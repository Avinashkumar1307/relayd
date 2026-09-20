import { HEADLINE_RATE, rate, type Rate, type RateKind } from '@relayd/analytics';
import { FEATURES } from '@relayd/billing';
import type {
  AnalyticsRepository,
  CampaignRepository,
  SendingPoolRepository,
  EnforcementRepository,
  EntitlementsRepository,
  MeteringRepository,
  ProviderConnectionRepository,
  SuppressionRepository,
  WorkspaceRepository,
  WorkspaceScope,
} from '@relayd/db';
import { AppError } from '@relayd/types';
import type { CampaignId, SendingPoolId, WorkspaceId } from '@relayd/types';
import {
  COMPLAINT_THRESHOLD,
  DASHBOARD_CAMPAIGNS,
  bounceSplitOf,
  buildAttention,
  buildCampaigns,
  buildProviders,
  buildUsage,
  deltaPoints,
  resolvePeriod,
  type DashboardSummary,
} from './dashboard.js';

/**
 * Analytics.
 *
 * Every response that carries a rate carries `botFiltered` alongside it, per
 * BUILD-PLAN. That is not decoration: a filtered number without the size of
 * the filter is a number the customer cannot check, and the question this
 * product will be asked most often is "why is my open rate lower than it was
 * on my old tool". The answer is to show them what was removed.
 *
 * Every rate also carries its own confidence and, where it is not reliable,
 * the reason. Those travel in the payload rather than in the UI so that an
 * API consumer building their own dashboard cannot accidentally present an
 * open rate as though it were a click rate.
 */

/**
 * What the dashboard needs, beyond the rollups.
 *
 * C1 is a composition across billing, providers, campaigns and anti-abuse —
 * it is one endpoint rather than five because the page is one screen, and
 * five round trips would each need their own loading, empty and error state.
 * That composition is why this interface has six repositories where every
 * other analytics read needs one.
 */
export interface AnalyticsRepositories {
  analytics: AnalyticsRepository;
  /** The workspace's timezone, which every label on C1 is rendered in. */
  workspaces: WorkspaceRepository;
  /** The provider strip, and half of "needs attention". */
  connections: ProviderConnectionRepository;
  /** The plan's allowance and whether the workspace is past due. */
  entitlements: EntitlementsRepository;
  /** What has been metered into the open period. */
  metering: MeteringRepository;
  /** The anti-abuse stage, for the attention list. */
  enforcement: EnforcementRepository;
  /** How many addresses were kept out of a send. */
  suppressions: SuppressionRepository;
  /** The campaign behind G4a's provider breakdown, for its pool. */
  campaigns: CampaignRepository;
  /** That pool's name and strategy — the line G4a prints above the list. */
  pools: SendingPoolRepository;
}

export type AnalyticsUnitOfWork = <T>(
  fn: (repos: AnalyticsRepositories) => Promise<T>,
) => Promise<T>;

export interface AnalyticsServiceOptions {
  unitOfWork: AnalyticsUnitOfWork;
  /** Injected so tests need not wait for midnight. */
  now?: () => Date;
}

/** The longest range a single request may ask for. */
export const MAX_RANGE_DAYS = 400;

/** The default when no range is given. */
export const DEFAULT_RANGE_DAYS = 30;

export class AnalyticsService {
  constructor(private readonly options: AnalyticsServiceOptions) {}

  /**
   * One campaign's headline numbers.
   *
   * `computedAt` and `computedBy` are returned deliberately: a customer
   * watching a live send is looking at a 30-second figure, and one looking at
   * a finished campaign is looking at an hourly authoritative one. Showing
   * which is honest and costs nothing.
   */
  async campaign(scope: WorkspaceScope, campaignId: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const stats = await repos.analytics.campaignStats(scope, campaignId);
      if (stats === null) throw new AppError('not_found', 'No analytics for this campaign yet', 404);

      const botFiltered = await repos.analytics.botFilteredFor(scope, campaignId);

      return {
        campaignId,
        counts: stats,
        rates: this.ratesFor(stats, botFiltered),
        headline: HEADLINE_RATE,
        computedAt: stats.computedAt,
        computedBy: stats.computedBy,
      };
    });
  }

  async campaignTimeseries(
    scope: WorkspaceScope,
    campaignId: CampaignId,
    range: { from?: string; to?: string },
  ) {
    const { from, to } = this.resolveRange(range);

    return this.options.unitOfWork(async (repos) => ({
      campaignId,
      from,
      to,
      points: await repos.analytics.campaignDaily(scope, { campaignId, from, to }),
    }));
  }

  /**
   * The link heat table.
   *
   * Sorted by unique non-bot clicks, because that is the number that answers
   * "which link worked" — total clicks rewards a link a scanner walked, and
   * unique-including-bots rewards it slightly less.
   */
  async campaignLinks(scope: WorkspaceScope, campaignId: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const links = await repos.analytics.campaignLinks(scope, campaignId);
      const stats = await repos.analytics.campaignStats(scope, campaignId);
      const delivered = stats?.delivered ?? 0;

      return {
        campaignId,
        links: links.map((link) => ({
          ...link,
          clickRate: rate({
            kind: 'click',
            numerator: link.clicksUniqueNonbot,
            denominator: delivered,
            botFiltered: Math.max(0, link.clicksUnique - link.clicksUniqueNonbot),
          }),
        })),
      };
    });
  }

  /**
   * The device and client mix.
   *
   * The "unknown" slice is reported as its own row rather than distributed
   * across the known clients. Apple's Mail Privacy Protection reports a
   * generic client through a proxy, so a large unknown share is expected —
   * and a chart that hides it by apportioning it is a chart that lies in
   * proportion to how much privacy the audience uses.
   */
  async campaignDevices(scope: WorkspaceScope, campaignId: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.analytics.campaignDevices(scope, campaignId);
      const total = rows.reduce((sum, row) => sum + row.opens, 0);

      return {
        campaignId,
        total,
        breakdown: rows.map((row) => ({
          ...row,
          share: total === 0 ? null : row.opens / total,
          isUnknown: isUnknownClient(row.clientFamily),
        })),
        unknownShare:
          total === 0
            ? null
            : rows.filter((row) => isUnknownClient(row.clientFamily)).reduce((sum, row) => sum + row.opens, 0) /
              total,
      };
    });
  }

  async providers(scope: WorkspaceScope, range: { from?: string; to?: string }) {
    const { from, to } = this.resolveRange(range);

    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.analytics.providerBreakdown(scope, { from, to });

      return {
        from,
        to,
        providers: rows.map((row) => ({
          ...row,
          deliveryRate: rate({
            kind: 'delivery',
            numerator: row.delivered,
            denominator: row.sent,
          }),
          bounceRate: rate({ kind: 'bounce', numerator: row.bouncedHard, denominator: row.sent }),
          complaintRate: rate({
            kind: 'complaint',
            numerator: row.complained,
            denominator: row.delivered,
          }),
        })),
      };
    });
  }

  async overview(scope: WorkspaceScope, range: { from?: string; to?: string }) {
    const { from, to } = this.resolveRange(range);

    return this.options.unitOfWork(async (repos) => {
      const points = await repos.analytics.workspaceOverview(scope, { from, to });

      const totals = points.reduce(
        (sum, point) => ({
          sent: sum.sent + point.sent,
          delivered: sum.delivered + point.delivered,
          bounced: sum.bounced + point.bounced,
          complained: sum.complained + point.complained,
          opensUniqueNonbot: sum.opensUniqueNonbot + point.opensUniqueNonbot,
          clicksUnique: sum.clicksUnique + point.clicksUnique,
          unsubscribed: sum.unsubscribed + point.unsubscribed,
        }),
        {
          sent: 0, delivered: 0, bounced: 0, complained: 0,
          opensUniqueNonbot: 0, clicksUnique: 0, unsubscribed: 0,
        },
      );

      return {
        from,
        to,
        points,
        totals,
        rates: {
          click: rate({
            kind: 'click',
            numerator: totals.clicksUnique,
            denominator: totals.delivered,
          }),
          open: rate({
            kind: 'open',
            numerator: totals.opensUniqueNonbot,
            denominator: totals.delivered,
          }),
          bounce: rate({ kind: 'bounce', numerator: totals.bounced, denominator: totals.sent }),
          complaint: rate({
            kind: 'complaint',
            numerator: totals.complained,
            denominator: totals.delivered,
          }),
        },
        headline: HEADLINE_RATE,
      };
    });
  }

  /**
   * One campaign's delivery per connection (G4a's "Provider breakdown").
   *
   * The numbers come from `campaignProviderTotals`, which is the one read in
   * the product that aggregates `campaign_recipients` — there is no
   * campaign × connection rollup, and the repository documents why. Names
   * come from `provider_connections`, so a connection deleted since the
   * campaign ran still shows its id rather than disappearing from a report
   * whose totals would then not add up.
   *
   * `clickRate` is **null on every row**, and that is a real gap rather than
   * an oversight: clicks are recorded per recipient in `email_events`, and
   * the only way to attribute them to a connection today is to walk raw
   * events, which CLAUDE.md section 12 forbids and which would be slow
   * enough to matter. The browser's type already allows null. The fix is a
   * `campaign_provider_stats` rollup, raised in this batch's report.
   */
  async campaignProviders(scope: WorkspaceScope, campaignId: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const campaign = await repos.campaigns.findById(scope, campaignId);
      if (campaign === null) throw new AppError('not_found', 'Campaign not found', 404);

      const [totals, connections] = await Promise.all([
        repos.analytics.campaignProviderTotals(scope, campaignId),
        repos.connections.list(scope),
      ]);

      const byId = new Map(connections.map((connection) => [connection.id, connection]));

      const pool =
        campaign.sendingPoolId === null
          ? null
          : await repos.pools.findById(scope, campaign.sendingPoolId as SendingPoolId);

      // Recipients that never reached a connection — suppressed at send
      // time, cancelled with the campaign — group under a null id. They are
      // not a provider and must not appear as one.
      const routed = totals.filter((row) => row.providerConnectionId !== null);

      const providers = routed.map((row) => {
        const connection = byId.get(row.providerConnectionId as never);
        const known =
          connection === undefined ? undefined : PROVIDER_CODES[connection.providerType];

        return {
          connectionId: row.providerConnectionId as string,
          code: known?.code ?? 'UNK',
          name: connection === undefined ? 'Removed connection' : labelOf(connection.name, known?.name),
          delivered: row.delivered,
          // Over sends, not over delivered: a bounce is a send that did not
          // arrive, so putting it over the arrivals would divide by the
          // wrong thing and flatter a provider that bounced everything.
          bounceRate: row.sent === 0 ? null : row.bouncedHard / row.sent,
          clickRate: null,
          uncertain: row.uncertain,
        };
      });

      return {
        poolLabel: pool?.name ?? null,
        routing: pool === null ? null : pool.strategy.replace(/_/gu, '-'),
        providers,
        note: uncertainNote(providers),
      };
    });
  }

  /**
   * The whole dashboard, in one call (C1).
   *
   * Reads only rollups and single-row tables: `campaign_daily_stats` and
   * `provider_stats` for the rates, `campaign_counters` and `campaign_stats`
   * for the campaign rows, `usage_aggregates` for the plan band. Nothing
   * here touches `email_events`, and nothing counts `campaign_recipients`
   * (CLAUDE.md section 12).
   *
   * The arithmetic and every label live in `dashboard.ts`, which takes rows
   * and returns the payload. This method's whole job is the reads.
   */
  async dashboard(scope: WorkspaceScope): Promise<DashboardSummary> {
    const now = (this.options.now ?? (() => new Date()))();

    return this.options.unitOfWork(async (repos) => {
      const [workspace, billingState] = await Promise.all([
        repos.workspaces.findById(scope, scope.workspaceId as WorkspaceId),
        repos.entitlements.readBillingState(scope),
      ]);

      const timezone = workspace?.timezone ?? 'UTC';

      const { start, end, period } = resolvePeriod({
        now,
        currentPeriodStart: billingState.currentPeriodStart,
        currentPeriodEnd: billingState.currentPeriodEnd,
        timezone,
      });

      // The comparison window is the same length, immediately before.
      const previousStart = new Date(start.getTime() - (end.getTime() - start.getTime()));
      const today = isoDay(now);

      const [
        current,
        previous,
        split,
        connections,
        sentTodayRows,
        campaignRows,
        uncertain,
        usage,
        entitlements,
        enforcement,
        suppressed,
      ] = await Promise.all([
        repos.analytics.workspaceOverview(scope, { from: isoDay(start), to: today }),
        repos.analytics.workspaceOverview(scope, {
          from: isoDay(previousStart),
          to: isoDay(new Date(start.getTime() - 86_400_000)),
        }),
        repos.analytics.bounceSplit(scope, { from: isoDay(start), to: today }),
        repos.connections.list(scope),
        repos.analytics.providerBreakdown(scope, { from: today, to: today }),
        repos.analytics.dashboardCampaigns(scope, { limit: DASHBOARD_CAMPAIGNS }),
        repos.analytics.uncertainSince(scope, start),
        repos.metering.readAggregate(scope, {
          featureKey: FEATURES.emailsSent,
          periodStart: start,
        }),
        repos.entitlements.readAll(scope),
        repos.enforcement.read(scope, now),
        repos.suppressions.countUpTo(scope),
      ]);

      const totals = sumPoints(current);
      const before = sumPoints(previous);

      const allowance =
        usage?.included ??
        entitlements.find((row) => row.featureKey === FEATURES.emailsSent)?.limitValue ??
        null;

      return {
        period,
        usage: buildUsage({
          // The metered figure where there is one — it is what the invoice
          // will be built from — and the rollup's accepted count otherwise,
          // which is what a workspace with no subscription still has.
          sent: usage?.used ?? totals.sent,
          limit: allowance,
          uncertain,
          periodEnd: end,
          now,
          timezone,
        }),
        deltas: {
          click: deltaPoints(
            { numerator: totals.clicksUnique, denominator: totals.delivered },
            { numerator: before.clicksUnique, denominator: before.delivered },
          ),
          open: deltaPoints(
            { numerator: totals.opensUniqueNonbot, denominator: totals.delivered },
            { numerator: before.opensUniqueNonbot, denominator: before.delivered },
          ),
        },
        bounceSplit: bounceSplitOf(split),
        complaintThreshold: COMPLAINT_THRESHOLD,
        providers: buildProviders(
          connections,
          new Map(sentTodayRows.map((row) => [row.providerConnectionId, row.sent])),
        ),
        campaigns: buildCampaigns(campaignRows, now, timezone),
        attention: buildAttention({
          connections,
          campaigns: campaignRows,
          enforcement,
          pastDue: billingState.pastDue,
        }),
        suppressions:
          suppressed.count === 0
            ? null
            : {
                applied: suppressed.count,
                note: suppressed.capped
                  ? 'suppressed addresses, counted to the display cap'
                  : 'suppressed before send, and re-checked at send time',
              },
      };
    });
  }

  /** Every rate for one campaign, each carrying its own botFiltered. */
  private ratesFor(
    stats: {
      sent: number;
      delivered: number;
      bouncedHard: number;
      complained: number;
      unsubscribed: number;
      opensUnique: number;
      opensUniqueNonbot: number;
      clicksUnique: number;
      clicksUniqueNonbot: number;
    },
    botFiltered: number,
  ): Record<RateKind, Rate> {
    const opensFiltered = Math.max(0, stats.opensUnique - stats.opensUniqueNonbot);
    const clicksFiltered = Math.max(0, stats.clicksUnique - stats.clicksUniqueNonbot);

    return {
      click: rate({
        kind: 'click',
        numerator: stats.clicksUniqueNonbot,
        denominator: stats.delivered,
        botFiltered: clicksFiltered,
      }),
      open: rate({
        kind: 'open',
        numerator: stats.opensUniqueNonbot,
        denominator: stats.delivered,
        botFiltered: opensFiltered,
      }),
      bounce: rate({
        kind: 'bounce',
        numerator: stats.bouncedHard,
        denominator: stats.sent,
        botFiltered: 0,
      }),
      complaint: rate({
        kind: 'complaint',
        numerator: stats.complained,
        denominator: stats.delivered,
        botFiltered: 0,
      }),
      unsubscribe: rate({
        kind: 'unsubscribe',
        numerator: stats.unsubscribed,
        denominator: stats.delivered,
        botFiltered: 0,
      }),
      delivery: rate({
        kind: 'delivery',
        numerator: stats.delivered,
        denominator: stats.sent,
        botFiltered,
      }),
    };
  }

  /**
   * Turns an optional range into two dates.
   *
   * Bounded, because an unbounded range over `campaign_daily_stats` is fine
   * today and is a table scan in three years. Four hundred days covers "the
   * last year" plus the slack a customer comparing year-on-year needs.
   */
  private resolveRange(range: { from?: string; to?: string }): { from: string; to: string } {
    const now = (this.options.now ?? (() => new Date()))();
    const to = range.to ?? isoDay(now);
    const from = range.from ?? isoDay(new Date(now.getTime() - DEFAULT_RANGE_DAYS * 86_400_000));

    if (!isIsoDay(from) || !isIsoDay(to)) {
      throw new AppError('validation_failed', 'Dates must be YYYY-MM-DD', 400);
    }

    if (from > to) {
      throw new AppError('validation_failed', 'The start of the range is after its end', 400);
    }

    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (days > MAX_RANGE_DAYS) {
      throw new AppError(
        'validation_failed',
        `A range may cover at most ${MAX_RANGE_DAYS} days`,
        400,
      );
    }

    return { from, to };
  }
}

/**
 * Client families that mean "we could not tell".
 *
 * Named rather than inferred from an empty string, because a proxy reports a
 * real-looking user agent that identifies the proxy rather than the reader.
 */
const UNKNOWN_CLIENTS: ReadonlySet<string> = new Set(['unknown', '', 'proxy', 'mpp']);

/**
 * The chip and the product name for each provider type.
 *
 * Duplicated from the pool service's monogram table rather than shared,
 * because the two answer different questions — H1b wants three letters in a
 * 16px tile, G4a wants "Amazon SES · eu-west-1" — and a shared table would
 * grow a `variant` parameter the first time one of them changed.
 */
const PROVIDER_CODES: Readonly<Record<string, { name: string; code: string }>> = {
  ses: { name: 'Amazon SES', code: 'SES' },
  sendgrid: { name: 'SendGrid', code: 'SG' },
  mailgun: { name: 'Mailgun', code: 'MG' },
  brevo: { name: 'Brevo', code: 'BR' },
  smtp: { name: 'SMTP', code: 'SMTP' },
  google: { name: 'Google Workspace', code: 'GW' },
};

/** "Amazon SES · marketing", or just the customer's name for an unknown type. */
function labelOf(connectionName: string, productName: string | undefined): string {
  return productName === undefined ? connectionName : `${productName} · ${connectionName}`;
}

/**
 * The sentence under G4a's provider list, when there is one.
 *
 * Only written when a provider actually has unconfirmed sends. D3 says an
 * uncertain recipient is terminal, unbilled and surfaced in the report —
 * this is where it is surfaced, and a note printed when the number is zero
 * would train people to ignore it.
 */
function uncertainNote(
  providers: readonly { name: string; uncertain: number }[],
): string | null {
  const affected = providers.filter((provider) => provider.uncertain > 0);
  if (affected.length === 0) return null;

  const total = affected.reduce((sum, provider) => sum + provider.uncertain, 0);
  const names = affected.map((provider) => provider.name).join(', ');

  return `${total.toLocaleString('en-US')} send${total === 1 ? '' : 's'} via ${names} could not be confirmed and are counted as delivery uncertain, not delivered. They are not billed.`;
}

/** The period totals the deltas and the usage band are computed from. */
function sumPoints(
  points: readonly {
    sent: number;
    delivered: number;
    opensUniqueNonbot: number;
    clicksUnique: number;
  }[],
): { sent: number; delivered: number; opensUniqueNonbot: number; clicksUnique: number } {
  return points.reduce(
    (sum, point) => ({
      sent: sum.sent + point.sent,
      delivered: sum.delivered + point.delivered,
      opensUniqueNonbot: sum.opensUniqueNonbot + point.opensUniqueNonbot,
      clicksUnique: sum.clicksUnique + point.clicksUnique,
    }),
    { sent: 0, delivered: 0, opensUniqueNonbot: 0, clicksUnique: 0 },
  );
}

function isUnknownClient(clientFamily: string): boolean {
  return UNKNOWN_CLIENTS.has(clientFamily.trim().toLowerCase());
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * CSV, built here rather than by a library.
 *
 * One rule, and it is the one every hand-rolled CSV gets wrong: a field
 * containing a comma, a quote or a newline must be quoted, and quotes inside
 * it doubled. The second rule is the one nobody expects — a field starting
 * with `=`, `+`, `-` or `@` is a formula to Excel, and a contact who names
 * themselves `=cmd|...` has just been handed script execution on whoever
 * opens the export.
 */
export function toCsv(rows: readonly Readonly<Record<string, unknown>>[]): string {
  if (rows.length === 0) return '';

  const columns = Object.keys(rows[0] ?? {});
  const lines = [columns.map(csvField).join(',')];

  for (const row of rows) {
    lines.push(columns.map((column) => csvField(row[column])).join(','));
  }

  // CRLF, because that is what the RFC says and what Excel expects.
  return `${lines.join('\r\n')}\r\n`;
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = value instanceof Date ? value.toISOString() : String(value);

  // Formula injection. The leading apostrophe is what every spreadsheet reads
  // as "this is text", and it is the only defence that survives a round trip
  // through Excel, Numbers and Sheets.
  const safe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;

  return /["\n\r,]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
