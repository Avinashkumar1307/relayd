// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { analyticsApi, formatRate, rateFootnote, type Rate } from '../src/api/analytics.js';
import { DashboardPage, rangeFor } from '../src/routes/analytics/dashboard.js';
import { CampaignAnalyticsPage } from '../src/routes/analytics/campaign.js';
import { ReportsPage } from '../src/routes/analytics/reports.js';

/**
 * Section C — the dashboard (C1–C4, Cm), the campaign report (G4a, G4b) and
 * the workspace report.
 *
 * docs/06 §13 is a product decision with engineering consequences, and these
 * are the consequences, each tested where a customer would notice it being
 * removed:
 *
 *   the click rate is the headline, and it is the only headline;
 *   the open rate always says "approximate" and always carries a tilde;
 *   the bot exclusions are stated in the interface, not in a tooltip;
 *   delivery uncertain (D3) is its own number and never a bounce;
 *   a rate with no denominator is an em dash, never 0%.
 */

const fetchMock = vi.fn();

const MEMBERSHIPS = [
  { workspaceId: 'ws-1', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind', role: 'owner' },
];

interface Stub {
  path: string;
  body: unknown;
  status?: number;
}

/** Answers the stubs; anything unstubbed gets an empty list, never a 404. */
function mockApi(stubs: Stub[]) {
  // Longest path first, so `/campaigns/c1` cannot swallow
  // `/analytics/campaigns/c1/links` and hand a page the wrong shape.
  const ordered = [...stubs].sort((a, b) => b.path.length - a.path.length);

  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/auth/refresh')) {
      return json({ data: { accessToken: 't', memberships: MEMBERSHIPS } });
    }

    const stub = ordered.find((candidate) => url.includes(candidate.path));
    if (stub === undefined) return json({ data: [] });

    return json(stub.body, stub.status ?? 200);
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAt(ui: ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/dashboard" element={<>{ui}</>} />
            <Route path="/reports" element={<>{ui}</>} />
            <Route path="/campaigns/:id/analytics" element={<>{ui}</>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ------------------------------------------------------------- fixtures -- */

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

const POINT = {
  day: '2026-09-17',
  sent: 500,
  delivered: 480,
  bounced: 10,
  complained: 1,
  opensUniqueNonbot: 200,
  clicksUnique: 90,
  unsubscribed: 2,
};

const OVERVIEW = {
  from: '2026-08-19',
  to: '2026-09-18',
  points: [POINT],
  totals: { ...POINT, day: undefined },
  rates: {
    click: rate({ value: 0.1875 }),
    open: rate({ kind: 'open', value: 0.4167, confidence: 'directional', caveat: 'Privacy features inflate this.', botFiltered: 180 }),
    bounce: rate({ kind: 'bounce', value: 0.02 }),
    complaint: rate({ kind: 'complaint', value: 0.002 }),
  },
  headline: 'click',
};

/** The overview of a workspace that has never sent: rates with no denominator. */
const NOTHING_SENT = {
  ...OVERVIEW,
  points: [],
  rates: {
    click: rate({ value: null, numerator: 0, denominator: 0 }),
    open: rate({ kind: 'open', value: null, numerator: 0, denominator: 0, confidence: 'directional' }),
    bounce: rate({ kind: 'bounce', value: null, numerator: 0, denominator: 0 }),
    complaint: rate({ kind: 'complaint', value: null, numerator: 0, denominator: 0 }),
  },
};

const SUMMARY = {
  period: { label: '1–19 Sep 2026', timezone: 'Asia/Dubai', comparedTo: 'Aug' },
  usage: {
    sent: 184_320,
    limit: 250_000,
    renewsLabel: '74% · renews 1 Oct (12 days)',
    renewsShort: 'Renews 1 Oct',
    uncertain: 412,
  },
  deltas: { click: 0.4, open: -1.1 },
  bounceSplit: { soft: 0.006, hard: 0.003 },
  complaintThreshold: 0.003,
  providers: [
    {
      connectionId: 'prv_ses_eu1',
      code: 'SES',
      name: 'Amazon SES',
      label: 'eu-west-1 · production',
      health: 'healthy',
      sentToday: 41_200,
      dailyLimit: 50_000,
    },
  ],
  campaigns: [
    {
      id: 'cmp_8f3k2a',
      name: 'Autumn Escapes: Dubai → Santorini',
      state: 'sending',
      when: 'Started today, 09:00',
      recipients: 48_213,
      counts: { delivered: 29_876, pending: 16_595, sending: 1_240, uncertain: 180 },
      clickRate: 0.04,
    },
  ],
  attention: [
    {
      id: 'att_webhook',
      tone: 'danger',
      title: 'SendGrid · marketing webhook failing',
      detail: 'No events received since 08:40 GST.',
      action: { label: 'Fix connection', href: '/providers/prv_sg_mkt' },
    },
  ],
  suppressions: { applied: 2_318, note: 'consent attested on all 4 imports' },
};

/** Onboarding is finished, so the dashboard shows no checklist (C1, C4). */
const ONBOARDED: Stub[] = [
  { path: '/providers', body: { data: [{ id: 'prv_ses_eu1', name: 'Amazon SES', status: 'active', createdAt: '2026-03-12T08:20:00.000Z', hasWebhookSecret: true }] } },
  { path: '/senders', body: { data: [{ id: 'snd_hello', email: 'hello@northwind.travel', status: 'active' }] } },
  { path: '/imports', body: { data: [{ id: 'imp_1', status: 'completed' }] } },
  { path: '/campaigns', body: { data: { items: [{ id: 'cmp_8f3k2a', launchedAt: '2026-09-19T05:00:00.000Z' }] } } },
];

const CAMPAIGN = {
  campaignId: 'cmp_7q1m9z',
  counts: {
    recipients: 22_870, sent: 22_870, failed: 0, suppressed: 246, deliveryUncertain: 335,
    delivered: 22_241, bouncedHard: 87, bouncedSoft: 198, complained: 9, unsubscribed: 41,
    opensTotal: 14_602, opensUnique: 11_124, opensUniqueNonbot: 9_920,
    clicksTotal: 1_540, clicksUnique: 1_023, clicksUniqueNonbot: 1_023,
  },
  rates: {
    click: rate({ value: 0.046, numerator: 1_023, denominator: 22_241 }),
    open: rate({ kind: 'open', value: 0.446, confidence: 'directional', caveat: 'Privacy features inflate this.' }),
    bounce: rate({ kind: 'bounce', value: 0.0125 }),
    complaint: rate({ kind: 'complaint', value: 0.0004 }),
    unsubscribe: rate({ kind: 'unsubscribe', value: 0.0018 }),
    delivery: rate({ kind: 'delivery', value: 0.972 }),
  },
  headline: 'click',
  computedAt: '2026-09-20T06:00:00.000Z',
  computedBy: 'hourly',
  comparison: { points: 0.8, label: 'your last 5 newsletters' },
  botExcluded: 1_204,
  proxyShare: 0.61,
  sentLabel: 'Sent 8 Sep 2026, 10:00 GST',
};

const CAMPAIGN_ROW = {
  campaign: {
    id: 'cmp_7q1m9z',
    name: 'September newsletter — EU edition',
    status: 'completed',
    recipientCount: 22_870,
    timezone: 'Asia/Dubai',
    launchedAt: '2026-09-08T06:00:00.000Z',
    audience: {},
    scheduledAt: null,
    completedAt: null,
    createdAt: '2026-09-01T06:00:00.000Z',
    updatedAt: '2026-09-08T06:00:00.000Z',
    subjectOverride: null,
    templateVersionId: null,
    senderAccountId: null,
    sendingPoolId: null,
  },
  counters: null,
};

const CAMPAIGN_STUBS: Stub[] = [
  { path: '/analytics/campaigns/cmp_7q1m9z/timeseries', body: { data: { from: '2026-09-08T06:00:00.000Z', to: '2026-09-10T05:00:00.000Z', bucket: 'hour', points: [{ ...POINT, day: '2026-09-08T06:00:00.000Z', clicksUnique: 292 }] } } },
  {
    path: '/analytics/campaigns/cmp_7q1m9z/links',
    body: {
      data: {
        links: [
          { linkId: 'lnk_santorini', url: 'https://northwind.travel/offers/santorini', position: 0, clicksTotal: 640, clicksUnique: 512, clicksUniqueNonbot: 512, clickRate: rate({ value: 0.023 }) },
          { linkId: 'lnk_unsub', url: 'https://mail.northwind.travel/u/9f2c', label: 'Unsubscribe', position: 1, clicksTotal: 44, clicksUnique: 44, clicksUniqueNonbot: 44, clickRate: rate({ value: 0.002 }) },
        ],
      },
    },
  },
  {
    path: '/analytics/campaigns/cmp_7q1m9z/devices',
    body: {
      data: {
        total: 9_920,
        breakdown: [
          { deviceType: 'mobile', clientFamily: 'Apple Mail', opens: 3_800, clicks: 430, share: 0.28, isUnknown: false },
          { deviceType: 'desktop', clientFamily: 'Gmail', opens: 1_100, clicks: 120, share: 0.08, isUnknown: false },
          { deviceType: 'desktop', clientFamily: 'unknown', opens: 900, clicks: 100, share: 0.06, isUnknown: true },
        ],
        unknownShare: 0.15,
      },
    },
  },
  {
    path: '/analytics/campaigns/cmp_7q1m9z/providers',
    body: {
      data: {
        poolLabel: 'EU marketing pool',
        routing: 'round-robin',
        providers: [
          { connectionId: 'prv_ses_eu1', code: 'SES', name: 'Amazon SES · eu-west-1', delivered: 14_120, bounceRate: 0.008, clickRate: 0.048, uncertain: 0 },
          { connectionId: 'prv_sg_mkt', code: 'SG', name: 'SendGrid · marketing', delivered: 8_121, bounceRate: 0.011, clickRate: 0.042, uncertain: 335 },
        ],
        note: "SendGrid's webhook was down for 22 minutes on 8 Sep; 335 sends could not be confirmed and are counted as delivery uncertain, not delivered.",
      },
    },
  },
  { path: '/campaigns/cmp_7q1m9z', body: { data: CAMPAIGN_ROW } },
  { path: '/analytics/campaigns/cmp_7q1m9z', body: { data: CAMPAIGN } },
];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  configureApi({ baseUrl: '/api/v1' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------ dashboard -- */

describe('the dashboard', () => {
  function dashboardStubs(overview: unknown = OVERVIEW, summary: unknown = SUMMARY): Stub[] {
    return [
      { path: '/analytics/overview', body: { data: overview } },
      { path: '/analytics/dashboard', body: { data: summary } },
      ...ONBOARDED,
    ];
  }

  it('leads with the click rate', async () => {
    mockApi(dashboardStubs());
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findAllByText('Click rate')).toBeTruthy();
    expect(screen.getByText('18.8%')).toBeTruthy();
  });

  it('gives the click rate the headline treatment and nothing else', async () => {
    // docs/06: the click rate is what a campaign should be judged by. A
    // dashboard where the open rate is equally prominent invites the decision
    // that section exists to prevent.
    mockApi(dashboardStubs());
    const { container } = renderAt(<DashboardPage />, '/dashboard');

    await screen.findAllByText('Click rate');

    const headlines = container.querySelectorAll('[data-headline="true"]');
    expect(headlines).toHaveLength(1);
    expect(headlines[0]?.textContent).toContain('Click rate');
  });

  it('labels the open rate approximate, every time', async () => {
    // Not on hover. A customer who makes a decision on a number wrong by
    // 30-60% was misled by us, and a tooltip nobody opens is not a
    // disclosure. The tilde says the same thing in the number itself.
    mockApi(dashboardStubs());
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findByText('approximate')).toBeTruthy();
    expect(screen.getByText('~41.7%')).toBeTruthy();
    expect(screen.getByText(/privacy proxies inflate this/u)).toBeTruthy();
  });

  it('shows the plan usage band with the uncertain sends beside it', async () => {
    // D3: accepted but never confirmed. Unbilled, and never hidden — it is
    // the number that explains a gap between "sent" and "delivered".
    mockApi(dashboardStubs());
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findByText('Emails sent this period')).toBeTruthy();
    expect(screen.getByText(/412 delivery uncertain · not billed/u)).toBeTruthy();
  });

  it('shows an em dash rather than 0% before the first campaign', async () => {
    // C3. A workspace that has sent nothing has no click rate; 0% says it
    // performed badly rather than "not measured yet".
    mockApi(dashboardStubs(NOTHING_SENT));
    renderAt(<DashboardPage />, '/dashboard');

    await screen.findAllByText('Click rate');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('0.0%')).toBeNull();
    expect(screen.getAllByText(/Appears after your first campaign/u).length).toBeGreaterThan(0);
  });

  it('lists what needs attention, each with its way out', async () => {
    mockApi(dashboardStubs());
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('SendGrid · marketing webhook failing')).toBeTruthy();

    const action = screen.getByText(/Fix connection/u).closest('a');
    expect(action?.getAttribute('href')).toBe('/providers/prv_sg_mkt');
  });

  it('collapses the right-hand column when nothing needs attention', async () => {
    // C4. A permanent "all clear" panel trains people to stop reading the
    // place warnings appear.
    mockApi(dashboardStubs(OVERVIEW, { ...SUMMARY, attention: [] }));
    renderAt(<DashboardPage />, '/dashboard');

    await screen.findAllByText('Click rate');
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  it('shows the setup checklist until every step is done', async () => {
    // C3. The checklist is the right-hand column of a workspace that has not
    // finished connecting a provider and verifying a sender.
    mockApi([
      { path: '/analytics/overview', body: { data: NOTHING_SENT } },
      { path: '/analytics/dashboard', body: { data: { ...SUMMARY, attention: [], campaigns: [] } } },
      { path: '/providers', body: { data: [] } },
      { path: '/senders', body: { data: [] } },
      { path: '/imports', body: { data: [] } },
      { path: '/campaigns', body: { data: { items: [] } } },
    ]);
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findByText('Get set up')).toBeTruthy();
    expect(screen.getByText(/This checklist stays here until all four steps are done/u)).toBeTruthy();
  });

  it('names what the recent-campaign bars count, and points at the campaign list', async () => {
    mockApi(dashboardStubs());
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findAllByText('Recent campaigns')).toBeTruthy();
    expect(screen.getAllByText('Autumn Escapes: Dubai → Santorini').length).toBeGreaterThan(0);
    // The chart is about acceptance, never delivery (CLAUDE.md section 12).
    expect(screen.getByText(/emails accepted by provider/u)).toBeTruthy();
  });

  it('offers a way in when there are no campaigns yet', async () => {
    mockApi(dashboardStubs(NOTHING_SENT, { ...SUMMARY, campaigns: [] }));
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findAllByText('No campaigns yet')).toBeTruthy();
  });

  it('renders the whole page when the pending composition is missing', async () => {
    // Only `/analytics/overview` is real today. The rates and the chart come
    // from it, so a 404 on the pending half must cost the page its extras,
    // not its numbers.
    mockApi([
      { path: '/analytics/overview', body: { data: OVERVIEW } },
      { path: '/analytics/dashboard', body: { error: { code: 'not_found', message: 'no', requestId: 'req_1' } }, status: 404 },
      ...ONBOARDED,
    ]);
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findAllByText('Click rate')).toBeTruthy();
    expect(screen.getByText('18.8%')).toBeTruthy();
    expect(screen.queryByText('Emails sent this period')).toBeNull();
  });

  it('shows the request id when the overview itself fails', async () => {
    mockApi([
      { path: '/analytics/overview', body: { error: { code: 'internal', message: 'boom', requestId: 'req_7' } }, status: 500 },
      ...ONBOARDED,
    ]);
    renderAt(<DashboardPage />, '/dashboard');

    expect(await screen.findByText('req_7')).toBeTruthy();
  });
});

/* ---------------------------------------------------- campaign analytics -- */

describe('the campaign report', () => {
  it('states the bot exclusions in the interface', async () => {
    // The number that answers "why is this lower than my old tool". G4a puts
    // it in the header, beside the export, rather than in a footnote nobody
    // scrolls to.
    mockApi(CAMPAIGN_STUBS);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    expect(await screen.findByText(/Excluded: 1,204 bot events/u)).toBeTruthy();
  });

  it('shows delivery uncertain against the provider that caused it', async () => {
    // D3: unbilled, terminal, and never folded into the bounce count.
    mockApi(CAMPAIGN_STUBS);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    expect(await screen.findByText('SendGrid · marketing')).toBeTruthy();
    expect(screen.getByText('335 uncertain')).toBeTruthy();
    expect(screen.getByText('0 uncertain')).toBeTruthy();
    expect(screen.getByText(/counted as delivery uncertain, not delivered/u)).toBeTruthy();
  });

  it('draws the funnel from sent to clicked', async () => {
    mockApi(CAMPAIGN_STUBS);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    expect(await screen.findByText('Funnel')).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getByText('Delivered')).toBeTruthy();
    expect(screen.getByText('Clicked')).toBeTruthy();
    expect(screen.getByText('22,241')).toBeTruthy();
  });

  it('says where the open rate comes from, every time', async () => {
    mockApi(CAMPAIGN_STUBS);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    expect(await screen.findByText('approximate')).toBeTruthy();
    expect(screen.getByText('~44.6%')).toBeTruthy();
    expect(screen.getByText(/61% from Apple Mail proxies/u)).toBeTruthy();
  });

  it('prints the campaign, its state and when it was sent', async () => {
    mockApi(CAMPAIGN_STUBS);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    expect(await screen.findByText('September newsletter — EU edition')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText(/Sent 8 Sep 2026, 10:00 GST · 22,870 recipients · EU marketing pool/u)).toBeTruthy();
  });

  it('names a template link rather than printing its signed URL', async () => {
    mockApi(CAMPAIGN_STUBS);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    expect(await screen.findByText('Unsubscribe')).toBeTruthy();
    expect(screen.queryByText(/mail.northwind.travel\/u\/9f2c/u)).toBeNull();
    expect(screen.getByText('northwind.travel/offers/santorini')).toBeTruthy();
  });

  it('keeps the proxied share of clients as its own row', async () => {
    // Shown rather than apportioned away. A chart that hides it flatters us
    // in proportion to how private the audience is.
    mockApi(CAMPAIGN_STUBS);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    expect(await screen.findByText('Email client')).toBeTruthy();
    expect(screen.getByText('Unknown or proxied')).toBeTruthy();
  });

  it('offers a CSV export as a link, not a fetch', async () => {
    // The browser handles Content-Disposition and the filename; a blob would
    // lose both.
    mockApi(CAMPAIGN_STUBS);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    const link = (await screen.findByText('Export CSV')).closest('a');
    expect(link?.getAttribute('href')).toContain('/export.csv');
    expect(link?.hasAttribute('download')).toBe(true);
  });

  it('shows the request id when the report fails', async () => {
    mockApi([
      { path: '/analytics/campaigns/cmp_7q1m9z', body: { error: { code: 'internal', message: 'boom', requestId: 'req_9' } }, status: 500 },
    ]);
    renderAt(<CampaignAnalyticsPage />, '/campaigns/cmp_7q1m9z/analytics');

    expect(await screen.findByText('req_9')).toBeTruthy();
  });
});

/* -------------------------------------------------------------- reports -- */

describe('the reports page', () => {
  const REPORT_STUBS: Stub[] = [
    { path: '/analytics/overview', body: { data: OVERVIEW } },
    { path: '/analytics/dashboard', body: { data: SUMMARY } },
    {
      path: '/analytics/providers',
      body: {
        data: {
          from: '2026-08-19',
          to: '2026-09-18',
          providers: [
            {
              providerConnectionId: 'prv_ses_eu1',
              sent: 128_410, delivered: 127_190, bouncedHard: 612, complained: 96,
              deliveryRate: rate({ kind: 'delivery', value: 0.99 }),
              bounceRate: rate({ kind: 'bounce', value: 0.005 }),
              complaintRate: rate({ kind: 'complaint', value: 0.0008 }),
            },
          ],
        },
      },
    },
    { path: '/providers', body: { data: [{ id: 'prv_ses_eu1', name: 'eu-west-1 · production', status: 'active' }] } },
  ];

  it('names each connection rather than showing its id', async () => {
    mockApi(REPORT_STUBS);
    renderAt(<ReportsPage />, '/reports');

    expect(await screen.findByText('Delivery by provider')).toBeTruthy();
    expect(screen.getByText('eu-west-1 · production')).toBeTruthy();
    expect(screen.queryByText('prv_ses_eu1')).toBeNull();
  });

  it('calls an accepted email accepted, not delivered', async () => {
    // A provider's accept is an accept (CLAUDE.md section 12), and the two
    // numbers on the row are deliberately different things.
    mockApi(REPORT_STUBS);
    renderAt(<ReportsPage />, '/reports');

    expect(await screen.findByText('128,410 accepted')).toBeTruthy();
    expect(screen.getByText(/99.0% delivered · 0.5% bounce · 0.08% complaint/u)).toBeTruthy();
    expect(screen.getByText(/Accepted by the provider, not delivered to a mailbox/u)).toBeTruthy();
  });

  it('offers a way in when nothing was sent in the period', async () => {
    mockApi([
      { path: '/analytics/overview', body: { data: NOTHING_SENT } },
      ...REPORT_STUBS.slice(1),
    ]);
    renderAt(<ReportsPage />, '/reports');

    expect(await screen.findByText('Nothing sent in this period')).toBeTruthy();
    expect(screen.getByText('Create campaign').getAttribute('href')).toBe('/campaigns/new');
  });

  it('shows the request id when the overview fails', async () => {
    mockApi([
      { path: '/analytics/overview', body: { error: { code: 'internal', message: 'boom', requestId: 'req_3' } }, status: 500 },
      ...REPORT_STUBS.slice(1),
    ]);
    renderAt(<ReportsPage />, '/reports');

    expect(await screen.findByText('req_3')).toBeTruthy();
  });
});

/* ------------------------------------------------------------ formatting -- */

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
