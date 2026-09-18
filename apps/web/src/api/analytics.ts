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
}

export interface LinkRow {
  linkId: string;
  url: string;
  position: number;
  clicksTotal: number;
  clicksUnique: number;
  clicksUniqueNonbot: number;
  clickRate: Rate;
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

export const analyticsApi = {
  overview: (range: { from?: string; to?: string } = {}) =>
    api.get<Overview>('/analytics/overview', range),

  campaign: (id: string) => api.get<CampaignAnalytics>(`/analytics/campaigns/${id}`),

  timeseries: (id: string, range: { from?: string; to?: string } = {}) =>
    api.get<{ from: string; to: string; points: DayPoint[] }>(
      `/analytics/campaigns/${id}/timeseries`,
      range,
    ),

  links: (id: string) => api.get<{ links: LinkRow[] }>(`/analytics/campaigns/${id}/links`),

  devices: (id: string) => api.get<DeviceBreakdown>(`/analytics/campaigns/${id}/devices`),

  providers: (range: { from?: string; to?: string } = {}) =>
    api.get<{ providers: { providerConnectionId: string; deliveryRate: Rate; bounceRate: Rate; complaintRate: Rate }[] }>(
      '/analytics/providers',
      range,
    ),

  /** The export URL, for an anchor rather than a fetch. */
  exportUrl: (id: string, range: { from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (range.from !== undefined) params.set('from', range.from);
    if (range.to !== undefined) params.set('to', range.to);
    const query = params.toString();

    return `/api/v1/analytics/campaigns/${id}/export.csv${query === '' ? '' : `?${query}`}`;
  },
};

export const analyticsKeys = {
  overview: (range: unknown) => ['analytics', 'overview', range] as const,
  campaign: (id: string) => ['analytics', 'campaign', id] as const,
  timeseries: (id: string, range: unknown) => ['analytics', 'timeseries', id, range] as const,
  links: (id: string) => ['analytics', 'links', id] as const,
  devices: (id: string) => ['analytics', 'devices', id] as const,
  providers: (range: unknown) => ['analytics', 'providers', range] as const,
};

/**
 * Formats a rate for display.
 *
 * Null renders as an em dash, not as 0%. A campaign that has delivered
 * nothing has no click rate, and 0% says it performed badly when in fact it
 * has not been measured.
 */
export function formatRate(rate: Rate | undefined): string {
  if (rate?.value == null) return '—';
  return `${(rate.value * 100).toFixed(1)}%`;
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
