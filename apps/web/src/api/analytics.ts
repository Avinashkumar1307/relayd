import { api } from './client.js';

/** Analytics endpoints. */

export type RateKind = 'click' | 'open' | 'bounce' | 'complaint' | 'unsubscribe' | 'delivery';

export interface Rate {
  kind: RateKind;
  numerator: number;
  denominator: number;
  /** Null when there is nothing to divide by — never zero, which means 0%. */
  value: number | null;
  confidence: 'reliable' | 'directional';
  caveat?: string;
  /** How many events the bot filter removed. Always present. */
  botFiltered: number;
}

export interface DayPoint {
  day: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opensUniqueNonbot: number;
  clicksUnique: number;
  unsubscribed: number;
}

export interface Overview {
  from: string;
  to: string;
  points: DayPoint[];
  totals: Omit<DayPoint, 'day'>;
  rates: { click: Rate; open: Rate; bounce: Rate; complaint: Rate };
  headline: RateKind;
}

export interface CampaignAnalytics {
  campaignId: string;
  counts: {
    recipients: number; sent: number; failed: number; suppressed: number;
    deliveryUncertain: number; delivered: number; bouncedHard: number;
    bouncedSoft: number; complained: number; unsubscribed: number;
    opensTotal: number; opensUnique: number; opensUniqueNonbot: number;
    clicksTotal: number; clicksUnique: number; clicksUniqueNonbot: number;
  };
  rates: Record<RateKind, Rate>;
  headline: RateKind;
  computedAt: string;
  /** Which pass produced these: a live 30-second figure, or the hourly one. */
  computedBy: 'incremental' | 'hourly';

  // ---- BACKEND PENDING: GET /analytics/campaigns/{id} returns none of these
  // G4a draws three sentences the rollup does not answer today. Each is
  // optional rather than faked: without it the line is simply absent, and
  // the page still renders every number it does have.
  /** G4a's green line: "+0.8 pts vs your last 5 newsletters". */
  comparison?: { points: number; label: string } | null;
  /**
   * "Sent 8 Sep 2026, 10:00 GST" — the campaign's own launch instant, in the
   * campaign's own timezone. Rendered by the server because the timestamp
   * that matters is the one the campaign was scheduled against, not the one
   * the reader's browser is in. Falls back to the launch time we hold.
   */
  sentLabel?: string;
  /** The header chip: how many events the bot filter took out of every number. */
  botExcluded?: number;
  /** "61% from Apple Mail proxies" — the share of opens a proxy reported. */
  proxyShare?: number | null;
}

export interface LinkRow {
  linkId: string;
  url: string;
  position: number;
  clicksTotal: number;
  clicksUnique: number;
  clicksUniqueNonbot: number;
  clickRate: Rate;
  /**
   * What to print instead of the URL.
   *
   * G4a's last two rows are "View in browser" and "Unsubscribe" — links the
   * template owns rather than links the customer wrote, and printing the
   * signed unsubscribe URL in a table would be noise at best.
   *
   * BACKEND PENDING: `GET /analytics/campaigns/{id}/links` has no label.
   */
  label?: string;
}

export interface DeviceBreakdown {
  total: number;
  breakdown: {
    deviceType: string;
    clientFamily: string;
    opens: number;
    clicks: number;
    share: number | null;
    isUnknown: boolean;
  }[];
  unknownShare: number | null;
}

/**
 * The dashboard's composition (frames C1–C4).
 *
 * `/analytics/overview` answers every *rate* the dashboard shows, and it is
 * what the four stat cards and the activity chart are drawn from. The rest
 * of the page — the plan-usage band, the provider strip, the recent-campaign
 * rows with their segment counts, the "Needs attention" column and the
 * suppression footnote — is a composition across billing, providers,
 * campaigns and anti-abuse that no endpoint answers today. It is one request
 * here rather than five from the browser because the page is one screen and
 * five round trips would each need their own loading, empty and error state.
 *
 * Served by `GET /analytics/dashboard`, composed server-side from rollups
 * only — `campaign_counters`, `campaign_stats`, `campaign_daily_stats`,
 * `provider_stats`, `usage_aggregates`. Every label it prints
 * (`renewsLabel`, `when`, the attention copy) is the server's, rendered in
 * the workspace's timezone, so the same sentence is not assembled three
 * slightly different ways in three components.
 */
export interface DashboardProvider {
  connectionId: string;
  /** The 3–4 character chip: "SES", "SG", "SMTP". */
  code: string;
  name: string;
  /** "eu-west-1 · production". */
  label: string;
  health: 'healthy' | 'degraded' | 'failed';
  sentToday: number;
  /** Null when the provider does not report a quota (SMTP, usually). */
  dailyLimit: number | null;
}

/** The segment counts behind one row's progress bar. */
export interface DashboardCampaignCounts {
  delivered?: number;
  pending?: number;
  queued?: number;
  sending?: number;
  soft?: number;
  hard?: number;
  complaint?: number;
  failed?: number;
  uncertain?: number;
}

export interface DashboardCampaign {
  id: string;
  name: string;
  /** A `CAMPAIGN_STATES` key. */
  state: string;
  /** "Started today, 09:00", "Paused 16 Sep, 11:12 · Complaint rate 0.34%". */
  when: string;
  recipients: number | null;
  counts: DashboardCampaignCounts;
  /** Null before anything has been delivered — never zero. */
  clickRate: number | null;
}

export interface AttentionItem {
  id: string;
  tone: 'danger' | 'warning' | 'info';
  title: string;
  detail: string;
  action: { label: string; href: string } | null;
}

export interface DashboardSummary {
  period: {
    /** "1–19 Sep 2026". */
    label: string;
    /** The workspace's zone, shown beside the period: "Asia/Dubai". */
    timezone: string;
    /** What the deltas compare against: "Aug". */
    comparedTo: string;
  };
  usage: {
    sent: number;
    limit: number;
    /** "74% · renews 1 Oct (12 days)" — the server owns the arithmetic. */
    renewsLabel: string;
    /** "Renews 1 Oct": the same fact at 390px, where the long one wraps (Cm). */
    renewsShort: string;
    /** D3: accepted but unconfirmed. Never billed, never hidden. */
    uncertain: number;
  };
  /** Movement in percentage points against the previous period. */
  deltas: { click: number | null; open: number | null };
  /** The bounce meter's two tones, as rates. */
  bounceSplit: { soft: number; hard: number } | null;
  /** Where the complaint meter draws its auto-pause mark. 0.003 = 0.3%. */
  complaintThreshold: number;
  providers: DashboardProvider[];
  campaigns: DashboardCampaign[];
  attention: AttentionItem[];
  /** The line under "Needs attention". Null when nothing was suppressed. */
  suppressions: { applied: number; note: string } | null;
}

/**
 * Per-connection delivery for one campaign (G4a, "Provider breakdown").
 *
 * `clickRate` is always null today. Clicks are recorded per recipient and
 * no rollup attributes them to a connection, so the honest answer is "not
 * measured" rather than a zero that reads as "nobody clicked".
 */
export interface CampaignProviderRow {
  connectionId: string;
  code: string;
  name: string;
  delivered: number;
  bounceRate: number | null;
  clickRate: number | null;
  /** D3 again: shown per provider, because that is where the cause is. */
  uncertain: number;
}

export interface CampaignProviderBreakdown {
  /** "EU marketing pool", or null when one sender did the whole campaign. */
  poolLabel: string | null;
  /** "round-robin" — the pool's strategy, printed after its name. */
  routing: string | null;
  providers: CampaignProviderRow[];
  /** The sentence under the list explaining an uncertain count. */
  note: string | null;
}

/**
 * Delivery per connection over a range — the Reports page's lower half.
 *
 * `provider_stats` is per connection and per day, so this is the one place
 * in the product that can answer "is one of my providers dragging the rest
 * down". The connection's *name* is not in it: the page joins `GET
 * /providers` for that rather than have two services own one label.
 */
export interface ProviderStatsRow {
  providerConnectionId: string;
  sent: number;
  delivered: number;
  bouncedHard: number;
  complained: number;
  deliveryRate: Rate;
  bounceRate: Rate;
  complaintRate: Rate;
}

export interface ProviderBreakdown {
  from: string;
  to: string;
  providers: ProviderStatsRow[];
}

export const analyticsApi = {
  overview: (range: { from?: string; to?: string } = {}) =>
    api.get<Overview>('/analytics/overview', range),

  campaign: (id: string) => api.get<CampaignAnalytics>(`/analytics/campaigns/${id}`),

  /**
   * The campaign's buckets.
   *
   * `bucket: 'hour'` is what G4a's "Clicks over time · first 48 hours ·
   * hourly" needs; the server buckets by day and ignores it today.
   * BACKEND PENDING: `GET /analytics/campaigns/{id}/timeseries?bucket=hour`.
   */
  timeseries: (id: string, range: { from?: string; to?: string; bucket?: 'day' | 'hour' } = {}) =>
    api.get<{ from: string; to: string; bucket?: 'day' | 'hour'; points: DayPoint[] }>(
      `/analytics/campaigns/${id}/timeseries`,
      range,
    ),

  /** G4a's provider breakdown, including the delivery-uncertain count. */
  campaignProviders: (id: string) =>
    api.get<CampaignProviderBreakdown>(`/analytics/campaigns/${id}/providers`),

  /** C1's whole composition, in one call. */
  dashboard: () => api.get<DashboardSummary>('/analytics/dashboard'),

  links: (id: string) => api.get<{ links: LinkRow[] }>(`/analytics/campaigns/${id}/links`),

  devices: (id: string) => api.get<DeviceBreakdown>(`/analytics/campaigns/${id}/devices`),

  providers: (range: { from?: string; to?: string } = {}) =>
    api.get<ProviderBreakdown>('/analytics/providers', range),

  /** The export URL, for an anchor rather than a fetch. */
  exportUrl: (id: string, range: { from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (range.from !== undefined) params.set('from', range.from);
    if (range.to !== undefined) params.set('to', range.to);
    const query = params.toString();

    return `/api/v1/analytics/campaigns/${id}/export.csv${query === '' ? '' : `?${query}`}`;
  },
};

/**
 * Query keys, prefixed with the workspace so a switch cannot serve one
 * tenant's numbers to another from cache (docs/09).
 */
export const analyticsKeys = {
  scoped: (workspaceId: string | null) => [workspaceId, 'analytics'] as const,
  overview: (workspaceId: string | null, range: unknown) =>
    [workspaceId, 'analytics', 'overview', range] as const,
  dashboard: (workspaceId: string | null) => [workspaceId, 'analytics', 'dashboard'] as const,
  campaign: (workspaceId: string | null, id: string) =>
    [workspaceId, 'analytics', 'campaign', id] as const,
  timeseries: (workspaceId: string | null, id: string, range: unknown) =>
    [workspaceId, 'analytics', 'timeseries', id, range] as const,
  links: (workspaceId: string | null, id: string) => [workspaceId, 'analytics', 'links', id] as const,
  devices: (workspaceId: string | null, id: string) =>
    [workspaceId, 'analytics', 'devices', id] as const,
  campaignProviders: (workspaceId: string | null, id: string) =>
    [workspaceId, 'analytics', 'campaign-providers', id] as const,
  providers: (workspaceId: string | null, range: unknown) =>
    [workspaceId, 'analytics', 'providers', range] as const,
};

/**
 * Formats a rate for display.
 *
 * Null renders as an em dash, not as 0%. A campaign that has delivered
 * nothing has no click rate, and 0% says it performed badly when in fact it
 * has not been measured.
 */
export function formatRate(rate: Rate | undefined, digits = 1): string {
  if (rate?.value == null) return '—';
  return `${(rate.value * 100).toFixed(digits)}%`;
}

/**
 * The same, for a rate that is small on purpose.
 *
 * One decimal turns a 0.08% complaint rate into "0.1%" — a third of the way
 * to the 0.3% auto-pause threshold drawn right beneath it. The dashboard
 * complaint card (C1) prints two decimals for exactly that reason.
 */
export function formatSmallRate(rate: Rate | undefined): string {
  return formatRate(rate, 2);
}

/** A percentage from a plain fraction, for the derived numbers on a card. */
export function formatFraction(value: number | null | undefined, digits = 1): string {
  if (value == null) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** "+0.4 pts vs Aug" / "−1.1 pts vs Aug". A true minus sign, as the frames draw. */
export function formatDelta(points: number | null, comparedTo: string): string | null {
  if (points === null) return null;
  const sign = points < 0 ? '−' : '+';
  return `${sign}${Math.abs(points).toFixed(1)} pts vs ${comparedTo}`;
}

/**
 * What to show beneath a rate.
 *
 * The bot-filtered count is shown whenever it is non-zero, on every rate, not
 * only on the ones a designer thought looked cluttered. It is the number that
 * answers "why is this lower than my old tool".
 */
export function rateFootnote(rate: Rate | undefined): string | null {
  if (rate === undefined) return null;
  if (rate.botFiltered > 0) {
    return `${rate.botFiltered.toLocaleString()} automated events excluded`;
  }
  return rate.caveat ?? null;
}
