// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { configureApi } from '../src/api/client.js';
import { analyticsApi, formatRate, rateFootnote, type Rate } from '../src/api/analytics.js';
import {
  CampaignAnalyticsPage,
  DashboardPage,
  rangeFor,
} from '../src/routes/analytics/analytics.js';

/**
 * The analytics pages.
 *
 * docs/06 §13 is a product decision with engineering consequences, and these
 * are the consequences: the headline is the click rate, the open rate is
 * always labelled approximate, the bot-filtered count is text rather than a
 * tooltip, and the unknown device share is shown rather than apportioned.
 *
 * All four are things a redesign would quietly remove, which is why they are
 * tested rather than left to review.
 */

const responses = new Map<string, unknown>();

function rate(over: Partial<Rate> = {}): Rate {
  return {
    kind: 'click',
    numerator: 175,
    denominator: 900,
    value: 175 / 900,
    confidence: 'reliable',
    botFiltered: 0,
    ...over,
  };
}

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      // Longest first, so `/analytics/campaigns/c1` does not swallow
      // `/analytics/campaigns/c1/links`.
      const match = [...responses.entries()]
        .filter(([pattern]) => {
          const [patternMethod, patternPath] = pattern.split(' ');
          return method === patternMethod && url.includes(String(patternPath));
        })
        .sort((a, b) => b[0].length - a[0].length)[0];

      if (match === undefined) {
        return new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'no stub', requestId: 'r' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ data: match[1] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(children: ReactNode, path = '/campaigns/c1/analytics') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/dashboard" element={children} />
          <Route path="/campaigns/:id/analytics" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const OVERVIEW = {
  from: '2026-08-19',
  to: '2026-09-18',
  points: [
    { day: '2026-09-17', sent: 500, delivered: 480, bounced: 10, complained: 1, opensUniqueNonbot: 200, clicksUnique: 90, unsubscribed: 2 },
  ],
  totals: { sent: 500, delivered: 480, bounced: 10, complained: 1, opensUniqueNonbot: 200, clicksUnique: 90, unsubscribed: 2 },
  rates: {
    click: rate({ value: 0.1875 }),
    open: rate({ kind: 'open', value: 0.4167, confidence: 'directional', caveat: 'Privacy features inflate this.', botFiltered: 180 }),
    bounce: rate({ kind: 'bounce', value: 0.02 }),
    complaint: rate({ kind: 'complaint', value: 0.002 }),
  },
  headline: 'click',
};

const CAMPAIGN = {
  campaignId: 'c1',
  counts: {
    recipients: 1000, sent: 950, failed: 40, suppressed: 8, deliveryUncertain: 12,
    delivered: 900, bouncedHard: 20, bouncedSoft: 30, complained: 2, unsubscribed: 5,
    opensTotal: 1200, opensUnique: 600, opensUniqueNonbot: 420,
    clicksTotal: 300, clicksUnique: 180, clicksUniqueNonbot: 175,
  },
  rates: {
    click: rate({ value: 0.1944 }),
    open: rate({ kind: 'open', value: 0.4667, confidence: 'directional', caveat: 'Privacy features inflate this.', botFiltered: 180 }),
    bounce: rate({ kind: 'bounce', value: 0.021 }),
    complaint: rate({ kind: 'complaint', value: 0.002 }),
    unsubscribe: rate({ kind: 'unsubscribe', value: 0.005 }),
    delivery: rate({ kind: 'delivery', value: 0.947 }),
  },
  headline: 'click',
  computedAt: '2026-09-18T12:00:00.000Z',
  computedBy: 'hourly',
};

describe('the dashboard', () => {
  it('leads with the click rate', async () => {
    responses.set('GET /analytics/overview', OVERVIEW);

    wrap(<DashboardPage />, '/dashboard');

    expect(await screen.findByText('Click rate')).toBeTruthy();
    expect(screen.getByText('18.8%')).toBeTruthy();
  });

  it('gives the click rate the headline treatment and nothing else', async () => {
    // docs/06: click rate is what a campaign should be judged by. A dashboard
    // where the open rate is equally prominent invites the decision that
    // section exists to prevent.
    responses.set('GET /analytics/overview', OVERVIEW);

    const { container } = wrap(<DashboardPage />, '/dashboard');

    await screen.findByText('Click rate');

    const headlines = container.querySelectorAll('[data-headline="true"]');
    expect(headlines).toHaveLength(1);
    expect(headlines[0]?.textContent).toContain('Click rate');
  });

  it('labels the open rate approximate, every time', async () => {
    // Not on hover. A customer who makes a decision on a number wrong by
    // 30-60% was misled by us, and a tooltip nobody opens is not a
    // disclosure.
    responses.set('GET /analytics/overview', OVERVIEW);

    wrap(<DashboardPage />, '/dashboard');

    expect(await screen.findByText('approximate')).toBeTruthy();
  });

  it('shows how many events the bot filter removed', async () => {
    // The number that answers "why is this lower than my old tool".
    responses.set('GET /analytics/overview', OVERVIEW);

    wrap(<DashboardPage />, '/dashboard');

    expect(await screen.findByText(/180 automated events excluded/u)).toBeTruthy();
  });

  it('offers a way in when nothing was sent', async () => {
    responses.set('GET /analytics/overview', { ...OVERVIEW, points: [] });

    wrap(<DashboardPage />, '/dashboard');

    expect(await screen.findByText(/Nothing sent in this period/u)).toBeTruthy();
  });
});

describe('the campaign analytics page', () => {
  function stubAll() {
    responses.set('GET /analytics/campaigns/c1', CAMPAIGN);
    responses.set('GET /analytics/campaigns/c1/timeseries', { from: '2026-08-19', to: '2026-09-18', points: OVERVIEW.points });
    responses.set('GET /analytics/campaigns/c1/links', {
      links: [
        {
          linkId: 'l1', url: 'https://example.com/offer', position: 0,
          clicksTotal: 200, clicksUnique: 120, clicksUniqueNonbot: 110,
          clickRate: rate({ value: 0.122, botFiltered: 10 }),
        },
      ],
    });
    responses.set('GET /analytics/campaigns/c1/devices', {
      total: 500,
      breakdown: [
        { deviceType: 'mobile', clientFamily: 'Apple Mail', opens: 300, clicks: 50, share: 0.6, isUnknown: false },
        { deviceType: 'unknown', clientFamily: 'unknown', opens: 200, clicks: 5, share: 0.4, isUnknown: true },
      ],
      unknownShare: 0.4,
    });
  }

  it('shows delivery uncertain as its own number', async () => {
    stubAll();
    wrap(<CampaignAnalyticsPage />);

    expect(await screen.findByText('Delivery uncertain')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText(/Not charged/u)).toBeTruthy();
  });

  it('says which rollup pass produced the numbers', async () => {
    stubAll();
    wrap(<CampaignAnalyticsPage />);

    expect(await screen.findByText(/Last recomputed/u)).toBeTruthy();
  });

  it('says so differently while a send is live', async () => {
    stubAll();
    responses.set('GET /analytics/campaigns/c1', { ...CAMPAIGN, computedBy: 'incremental' });

    wrap(<CampaignAnalyticsPage />);

    expect(await screen.findByText(/Updating live/u)).toBeTruthy();
  });

  it('shows the automated clicks removed per link', async () => {
    stubAll();
    wrap(<CampaignAnalyticsPage />);

    const links = await screen.findByText('https://example.com/offer');
    expect(links).toBeTruthy();
    expect(screen.getByText(/10 automated/u)).toBeTruthy();
  });

  it('warns when a large share of opens came through a privacy proxy', async () => {
    // Shown rather than apportioned away. A chart that hides it flatters us
    // in proportion to how private the audience is.
    stubAll();
    wrap(<CampaignAnalyticsPage />);

    expect(await screen.findByText(/privacy proxy/u)).toBeTruthy();
    expect(screen.getByText(/is normal and is not an error/u)).toBeTruthy();
  });

  it('does not warn when the unknown share is small', async () => {
    stubAll();
    responses.set('GET /analytics/campaigns/c1/devices', {
      total: 500,
      breakdown: [
        { deviceType: 'mobile', clientFamily: 'Apple Mail', opens: 495, clicks: 50, share: 0.99, isUnknown: false },
        { deviceType: 'unknown', clientFamily: 'unknown', opens: 5, clicks: 0, share: 0.01, isUnknown: true },
      ],
      unknownShare: 0.01,
    });

    wrap(<CampaignAnalyticsPage />);

    await screen.findByText('Devices and clients');
    expect(screen.queryByText(/privacy proxy/u)).toBeNull();
  });

  it('offers a CSV export as a link, not a fetch', async () => {
    // The browser handles Content-Disposition and the filename; a blob would
    // lose both.
    stubAll();
    wrap(<CampaignAnalyticsPage />);

    const link = await screen.findByText('Export CSV');
    expect(link.getAttribute('href')).toContain('/export.csv');
    expect(link.hasAttribute('download')).toBe(true);
  });
});

describe('formatting a rate', () => {
  it('shows a percentage to one decimal', () => {
    expect(formatRate(rate({ value: 0.1944 }))).toBe('19.4%');
  });

  it('shows an em dash rather than 0% when there is no denominator', () => {
    // A campaign that has delivered nothing has no click rate. 0% says it
    // performed badly; the dash says it has not been measured.
    expect(formatRate(rate({ value: null, denominator: 0 }))).toBe('—');
  });

  it('shows an em dash for a missing rate entirely', () => {
    expect(formatRate(undefined)).toBe('—');
  });

  it('shows 0.0% for a genuine zero', () => {
    // Distinct from "not measured": a campaign that delivered 900 and got no
    // clicks really did get no clicks.
    expect(formatRate(rate({ value: 0, numerator: 0, denominator: 900 }))).toBe('0.0%');
  });
});

describe('the footnote under a rate', () => {
  it('prefers the bot-filtered count', () => {
    expect(rateFootnote(rate({ botFiltered: 180, caveat: 'x' }))).toContain('180');
  });

  it('falls back to the caveat', () => {
    expect(rateFootnote(rate({ botFiltered: 0, caveat: 'Privacy features inflate this.' }))).toBe(
      'Privacy features inflate this.',
    );
  });

  it('is absent for a reliable rate with nothing filtered', () => {
    expect(rateFootnote(rate({ botFiltered: 0 }))).toBeNull();
  });
});

describe('the export URL', () => {
  it('carries the range', () => {
    const url = analyticsApi.exportUrl('c1', { from: '2026-01-01', to: '2026-01-31' });

    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-01-31');
  });

  it('omits the query when there is no range', () => {
    expect(analyticsApi.exportUrl('c1')).toBe('/api/v1/analytics/campaigns/c1/export.csv');
  });
});

describe('the range picker', () => {
  it('produces UTC days, matching how the server buckets them', () => {
    // A range computed in local time asks for a day the server does not have
    // and silently drops an edge day from every chart.
    const range = rangeFor(30, new Date('2026-09-18T23:30:00.000Z'));

    expect(range.to).toBe('2026-09-18');
    expect(range.from).toBe('2026-08-19');
  });
});
