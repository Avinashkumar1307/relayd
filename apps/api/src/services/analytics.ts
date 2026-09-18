import { HEADLINE_RATE, rate, type Rate, type RateKind } from '@relayd/analytics';
import type { AnalyticsRepository, WorkspaceScope } from '@relayd/db';
import { AppError } from '@relayd/types';
import type { CampaignId } from '@relayd/types';

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

export interface AnalyticsRepositories {
  analytics: AnalyticsRepository;
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
