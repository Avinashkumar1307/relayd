// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { CampaignsPage } from '../src/routes/campaigns/list.js';
import { CampaignDetailPage } from '../src/routes/campaigns/detail.js';
import { CampaignWizardPage } from '../src/routes/campaigns/wizard.js';

/**
 * Section G's pages, against the rules its frames encode.
 *
 * What is worth rendering to check is what cannot be asserted below the
 * component:
 *
 *   The row menu offers only what the state allows (the design's `ACTIONS`
 *   map). Showing Pause on a paused campaign is a button that can only
 *   produce a 409, which a customer reads as the product being broken.
 *
 *   A retried launch sends the *same* Idempotency-Key. Minting it per click
 *   is the natural way to write this and is exactly what F29 says must not
 *   happen — the second request would look like a fresh launch.
 *
 *   `delivery_uncertain` appears as its own number with its own explanation,
 *   never folded into failures (D3).
 *
 *   An Editor is told why they cannot launch, not merely refused (docs/09).
 */

const fetchMock = vi.fn();

const OWNER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'owner' }];
const EDITOR = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'editor' }];

interface Stub {
  method?: string;
  match: (url: string) => boolean;
  respond: (url: string, init?: RequestInit) => { status?: number; body: unknown };
}

const requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];

function mockApi(stubs: Stub[], role = OWNER) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/auth/refresh')) {
      return new Response(JSON.stringify({ data: { accessToken: 't', memberships: role } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    requests.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      // Recorded so a test can assert what was actually sent. Without it a
      // request that reached the server as `{}` looks identical to one
      // carrying a declaration.
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });

    const stub = stubs.find(
      (candidate) => (candidate.method ?? 'GET') === method && candidate.match(url),
    );

    if (stub === undefined) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: url, requestId: 'req_01J9TEST' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }

    const result = stub.respond(url, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function renderAt(ui: ReactNode, path: string, pattern: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path={pattern} element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  requests.length = 0;
  configureApi({ baseUrl: '/api/v1' });
});

afterEach(() => {
  // Vitest does not run RTL's automatic cleanup without `globals`, and a
  // leftover tree makes the next test assert against the previous render.
  cleanup();
  vi.unstubAllGlobals();
});

function campaign(over: Record<string, unknown> = {}) {
  return {
    id: 'cmp_1',
    name: 'Autumn Escapes',
    status: 'sending',
    subjectOverride: 'Autumn escapes',
    templateVersionId: 'tv_1',
    senderAccountId: 'sa_1',
    sendingPoolId: null,
    audience: { listIds: ['l1'] },
    scheduledAt: null,
    timezone: 'Asia/Dubai',
    recipientCount: 1_000,
    launchedAt: '2026-09-19T05:00:00.000Z',
    completedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-19T05:00:00.000Z',
    counts: { delivered: 700, pending: 200, sending: 10, soft: 20, hard: 5, complaint: 2, uncertain: 63 },
    clicks: 70,
    whenLabel: 'Started today, 09:00',
    senderLabel: 'hello@northwind.travel',
    note: null,
    metaLabel: 'cmp_1 · Launched 19 Sep 2026, 09:00 GST by Dana Haddad',
    hold: null,
    ...over,
  };
}

function progress(over: Record<string, unknown> = {}) {
  return {
    total: 1_000,
    pending: 200,
    queued: 0,
    sending: 10,
    sent: 790,
    failed: 5,
    suppressed: 40,
    uncertain: 63,
    outstanding: 210,
    complete: false,
    deliveryUncertain: 63,
    counts: { delivered: 700, pending: 200, sending: 10, soft: 20, hard: 5, complaint: 2, uncertain: 63 },
    clicks: 70,
    openRate: 38.1,
    ...over,
  };
}

const listStubs = (items: unknown[]): Stub[] => [
  { match: (url) => /\/campaigns(\?|$)/u.test(url), respond: () => ({ body: { data: { items, nextCursor: null } } }) },
];

/* ============================================================ G1, the list */

describe('the campaigns list (G1)', () => {
  it("shows every campaign with its state and the design's own headline copy", async () => {
    mockApi(listStubs([campaign()]));

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    expect(await screen.findByRole('heading', { name: 'Campaigns' })).toBeTruthy();
    expect(
      screen.getByText(/Every send, with its state and what happens next/u),
    ).toBeTruthy();

    const table = await screen.findByRole('table', { name: 'Campaigns' });
    expect(within(table).getAllByText('Autumn Escapes').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Sending').length).toBeGreaterThan(0);
  });

  it('shows the click rate over delivered, not over sent', async () => {
    // 70 clickers of 700 delivered is 10.0%. Dividing by sent would say 8.9%
    // and would move whenever a provider changed how it reports bounces.
    mockApi(listStubs([campaign()]));

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    const table = await screen.findByRole('table', { name: 'Campaigns' });
    expect(within(table).getAllByText('10.0%').length).toBeGreaterThan(0);
  });

  it('keeps delivery uncertain in the legend whether or not one exists', async () => {
    // A legend that appears only when the thing it explains does is a legend
    // nobody has read by the time they need it.
    mockApi(listStubs([campaign({ counts: { delivered: 1_000 }, clicks: 10 })]));

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    expect(await screen.findByText('Delivery uncertain')).toBeTruthy();
  });

  it("filters by the design's tab groupings", async () => {
    // `held` is filed under Scheduled because that is what a held campaign is
    // waiting to be — a product decision, not a property of the state machine.
    mockApi(
      listStubs([
        campaign({ id: 'cmp_a', name: 'Sending one', status: 'sending' }),
        campaign({ id: 'cmp_b', name: 'Held one', status: 'held' }),
      ]),
    );

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    await screen.findByRole('table', { name: 'Campaigns' });
    await userEvent.click(screen.getByRole('tab', { name: /Scheduled/u }));

    const table = screen.getByRole('table', { name: 'Campaigns' });
    expect(within(table).queryByText('Sending one')).toBeNull();
    expect(within(table).getAllByText('Held one').length).toBeGreaterThan(0);
  });

  it('offers only the actions the state allows', async () => {
    mockApi(listStubs([campaign({ status: 'paused' })]));

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    await screen.findByRole('table', { name: 'Campaigns' });
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Autumn Escapes' }));

    // Both halves matter: a Pause item on a paused campaign can only produce
    // a 409, and the customer reads that as the product being broken.
    expect(screen.getByRole('menuitem', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Pause' })).toBeNull();
  });

  it("pauses through the endpoint the design's menu names", async () => {
    mockApi([
      ...listStubs([campaign({ status: 'sending' })]),
      { method: 'POST', match: (url) => url.includes('/pause'), respond: () => ({ body: { data: { state: 'paused' } } }) },
    ]);

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    await screen.findByRole('table', { name: 'Campaigns' });
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Autumn Escapes' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pause' }));

    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url.includes('/campaigns/cmp_1/pause'))).toBe(true);
    });
  });

  it('disables a lifecycle action an Editor cannot take, and says why', async () => {
    // docs/09: a missing permission hides or disables the action and says
    // why. A greyed row with no reason says nothing.
    mockApi(listStubs([campaign({ status: 'sending' })]), EDITOR);

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    await screen.findByRole('table', { name: 'Campaigns' });
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Autumn Escapes' }));

    const pause = screen.getByRole('menuitem', { name: 'Pause' });
    expect(pause.getAttribute('aria-disabled')).toBe('true');
    expect(pause.getAttribute('title')).toMatch(/Owners and Admins/u);
  });

  it("shows the frame's empty state when there is nothing at all", async () => {
    mockApi(listStubs([]));

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    expect(await screen.findByText('No campaigns yet')).toBeTruthy();
    expect(
      screen.getByText(/Create your first campaign: pick an audience, a verified sender/u),
    ).toBeTruthy();
  });

  it("shows the frame's error state, with the request id support needs", async () => {
    mockApi([
      {
        match: (url) => /\/campaigns(\?|$)/u.test(url),
        respond: () => ({
          status: 500,
          body: { error: { code: 'internal_error', message: 'Boom', requestId: 'req_01J9G1FN6W2P' } },
        }),
      },
    ]);

    renderAt(<CampaignsPage />, '/campaigns', '/campaigns');

    expect(await screen.findByText("We couldn't load campaigns")).toBeTruthy();
    expect(screen.getByText(/Sending and scheduled launches are unaffected/u)).toBeTruthy();
    expect(screen.getByText('req_01J9G1FN6W2P')).toBeTruthy();
  });
});

/* ========================================================== G3, the detail */

const detailStubs = (row: Record<string, unknown>, counters = progress()): Stub[] => [
  { match: (url) => url.includes('/progress'), respond: () => ({ body: { data: counters } }) },
  { match: (url) => url.includes('/recipients'), respond: () => ({ body: { data: { items: [], nextCursor: null } } }) },
  { match: (url) => url.includes('/timeline'), respond: () => ({ body: { data: [] } }) },
  { match: (url) => url.includes('/campaigns/cmp_1'), respond: () => ({ body: { data: { campaign: row, counters: null } } }) },
];

describe('the campaign detail page (G3)', () => {
  it('shows delivery uncertain as its own number, never as a failure', async () => {
    // D3: "we could not send" and "we do not know whether we sent" are
    // different things to tell a customer, and folding them together loses
    // the only one that is not the customer's fault.
    mockApi(detailStubs(campaign()));

    renderAt(<CampaignDetailPage />, '/campaigns/cmp_1', '/campaigns/:id');

    expect(await screen.findByText('Delivery uncertain')).toBeTruthy();
    expect(screen.getAllByText('63').length).toBeGreaterThan(0);
    expect(screen.getByText(/Not billed/u)).toBeTruthy();

    // Bounces is soft + hard only: 20 + 5. The 63 uncertain are not in it.
    expect(screen.getByText('25')).toBeTruthy();
  });

  it('labels open rate approximate every time, not only when it looks wrong', async () => {
    // docs/06: a customer who makes a decision on a number wrong by 30-60%
    // was misled by us.
    mockApi(detailStubs(campaign()));

    renderAt(<CampaignDetailPage />, '/campaigns/cmp_1', '/campaigns/:id');

    expect(await screen.findByText('approx.')).toBeTruthy();
    expect(screen.getByText('privacy proxies inflate this')).toBeTruthy();
    expect(screen.getByText('Headline')).toBeTruthy();
  });

  it('offers pause while sending and resume while paused', async () => {
    mockApi(detailStubs(campaign({ status: 'sending' })));

    renderAt(<CampaignDetailPage />, '/campaigns/cmp_1', '/campaigns/:id');

    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('offers resume, not pause, once it is paused', async () => {
    mockApi(detailStubs(campaign({ status: 'paused' })));

    renderAt(<CampaignDetailPage />, '/campaigns/cmp_1', '/campaigns/:id');

    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('offers a draft a way back into the wizard', async () => {
    mockApi(detailStubs(campaign({ status: 'draft' })));

    renderAt(<CampaignDetailPage />, '/campaigns/cmp_1', '/campaigns/:id');

    expect(await screen.findByRole('button', { name: 'Continue editing' })).toBeTruthy();
  });

  it('offers neither pause nor cancel once it has completed', async () => {
    mockApi(detailStubs(campaign({ status: 'completed' })));

    renderAt(<CampaignDetailPage />, '/campaigns/cmp_1', '/campaigns/:id');

    await screen.findByText('Completed');
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('draws the hold banner with its reason and its way out (G3b)', async () => {
    mockApi(
      detailStubs(
        campaign({
          status: 'held',
          hold: {
            tone: 'warning',
            icon: 'lock',
            title: 'Held by billing.',
            body: 'Invoice INV-2026-0912 (USD 249.00) is 18 days past due, so launches are blocked.',
            actionLabel: 'Update payment method',
            actionHref: '/billing',
          },
        }),
      ),
    );

    renderAt(<CampaignDetailPage />, '/campaigns/cmp_1', '/campaigns/:id');

    expect(await screen.findByText('Held by billing.')).toBeTruthy();
    expect(screen.getByText(/18 days past due/u)).toBeTruthy();
    expect(screen.getAllByText('Update payment method').length).toBeGreaterThan(0);
  });

  it('filters recipients by the chip that was clicked', async () => {
    mockApi(detailStubs(campaign()));

    renderAt(<CampaignDetailPage />, '/campaigns/cmp_1', '/campaigns/:id');

    const delivered = await screen.findByRole('button', { name: /Delivered/u });
    await userEvent.click(delivered);

    // A single-state chip filters server-side, so the request carries it.
    await waitFor(() => {
      expect(requests.some((r) => r.url.includes('/recipients') && r.url.includes('state=delivered'))).toBe(true);
    });
  });
});

/* ========================================================== G2, the wizard */

const wizardStubs = (row: Record<string, unknown>, extra: Stub[] = []): Stub[] => [
  ...extra,
  { match: (url) => url.includes('/audience/lists'), respond: () => ({ body: { data: [] } }) },
  { match: (url) => url.includes('/audience/segments'), respond: () => ({ body: { data: [] } }) },
  { match: (url) => url.includes('/templates'), respond: () => ({ body: { data: [] } }) },
  {
    match: (url) => url.includes('/senders'),
    respond: () => ({
      body: {
        data: [
          {
            id: 'sa_1',
            providerId: 'pr_1',
            identityId: 'id_1',
            fromEmail: 'hello@northwind.travel',
            fromName: 'Northwind',
            replyTo: null,
            status: 'active',
            dailyLimit: 50_000,
            hourlyLimit: null,
            healthScore: 98,
            consecutiveFailures: 0,
            cooldownUntil: null,
            lastSendAt: null,
          },
        ],
      },
    }),
  },
  { match: (url) => url.includes('/providers'), respond: () => ({ body: { data: [] } }) },
  { match: (url) => url.includes('/pools'), respond: () => ({ body: { data: [] } }) },
  {
    method: 'POST',
    match: (url) => url.includes('/audience-preview'),
    respond: () => ({ body: { data: { eligible: 900, suppressed: 100, total: 1_000 } } }),
  },
  { method: 'PATCH', match: (url) => url.includes('/campaigns/cmp_1'), respond: () => ({ body: { data: row } }) },
  { match: (url) => url.includes('/campaigns/cmp_1'), respond: () => ({ body: { data: { campaign: row, counters: null } } }) },
];

function renderWizard(step: string, role = OWNER, row = campaign({ status: 'draft' }), extra: Stub[] = []) {
  mockApi(wizardStubs(row, extra), role);
  return renderAt(<CampaignWizardPage />, `/campaigns/cmp_1/edit/${step}`, '/campaigns/:id/edit/:step');
}

describe('the campaign wizard (G2)', () => {
  it('opens the step named in the URL, so the form is linkable', async () => {
    // docs/09 wants the wizard refresh-safe. A step held in component state
    // loses a half-finished campaign to a stray reload.
    renderWizard('tracking');

    expect(await screen.findByRole('heading', { name: '5 · Tracking & compliance' })).toBeTruthy();
  });

  it('says plainly that open rate is approximate', async () => {
    renderWizard('tracking');

    expect(await screen.findByText('approximate')).toBeTruthy();
    expect(screen.getByText(/Click rate is the headline metric/u)).toBeTruthy();
    expect(screen.getByText(/opens are inflated/u)).toBeTruthy();
  });

  it('says the unsubscribe link is not a setting', async () => {
    renderWizard('tracking');

    const unsubscribe = await screen.findByRole('switch', { name: /Unsubscribe link/u });
    expect(unsubscribe.hasAttribute('disabled')).toBe(true);
    expect(unsubscribe.getAttribute('title')).toMatch(/not a setting/u);
    expect(unsubscribe.getAttribute('aria-checked')).toBe('true');
  });

  it('asks for a declared consent source once the box is ticked', async () => {
    // A tick box on its own records nothing that could be shown to a provider
    // asking why we let this workspace send, which is the only reason the
    // control exists.
    renderWizard('tracking');

    const box = await screen.findByRole('checkbox', {
      name: /I confirm these contacts gave consent/u,
    });
    expect(screen.queryByLabelText(/Where did this audience agree/u)).toBeNull();

    await userEvent.click(box);

    expect(await screen.findByLabelText(/Where did this audience agree/u)).toBeTruthy();
  });

  it('starts with no consent source selected', async () => {
    // A pre-selected first option would be attested by everybody who clicked
    // past this screen without reading it, and an attestation the sender did
    // not mean is worse than none: it looks like evidence.
    renderWizard('tracking');

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /I confirm these contacts gave consent/u }),
    );

    const source = (await screen.findByLabelText(/Where did this audience agree/u)) as HTMLSelectElement;
    expect(source.value).toBe('');
  });

  it('shows how many will actually receive it, and how many will not', async () => {
    renderWizard('audience');

    expect(await screen.findByText('900')).toBeTruthy();
    // The suppressed count is shown, not hidden: it is the difference between
    // the number the author picked and the number who get the mail.
    expect(screen.getByText('−100')).toBeTruthy();
    expect(screen.getByText(/Suppressed · always removed/u)).toBeTruthy();
  });
});

describe('the launch button (F29 and the permission split)', () => {
  it('is disabled until consent is attested, and says so', async () => {
    renderWizard('review');

    const launch = await screen.findByRole('button', { name: 'Launch now' });
    expect(launch.hasAttribute('disabled')).toBe(true);

    // Once the pre-flight has its answers, the one thing still missing is the
    // attestation — and the button names it rather than just refusing.
    await waitFor(() => {
      expect(launch.getAttribute('title')).toBe('Confirm consent in step 5');
    });
  });

  it('tells an Editor they cannot launch, and what happens instead', async () => {
    // campaign:launch is separate from campaign:write (CLAUDE.md §11), and an
    // API key can never launch at all — the route carries refuseApiKey().
    renderWizard('review', EDITOR);

    const request = await screen.findByRole('button', { name: 'Request launch' });
    expect(request.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText(/Editors cannot launch\. Your request goes to Owners and Admins/u),
    ).toBeTruthy();
  });

  it("shows the pre-flight summary badge in the design's wording", async () => {
    renderWizard('review');

    expect(await screen.findByText(/^\d+ fail · \d+ warnings? · \d+ pass$/u)).toBeTruthy();
  });

  it('sends the same Idempotency-Key when clicked twice', async () => {
    // F29 from the browser's side. A key minted inside the click handler
    // would be a new key each time, which is the same as having none: the
    // second request reads as a fresh launch and snapshots again. The
    // attestation is on step 5 and the launch on step 7, so the key has to
    // survive the walk between them.
    renderWizard('tracking', OWNER, campaign({ status: 'draft' }), [
      {
        method: 'POST',
        match: (url) => url.includes('/launch'),
        respond: () => ({ status: 202, body: { data: { ok: true, recipientCount: 900 } } }),
      },
    ]);

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /I confirm these contacts gave consent/u }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText(/Where did this audience agree/u),
      'signup_form',
    );

    await userEvent.click(screen.getByRole('button', { name: /Continue to Schedule/u }));
    await userEvent.click(await screen.findByRole('button', { name: /Continue to Review/u }));

    const launch = await screen.findByRole('button', { name: /Launch now|Schedule campaign/u });
    await userEvent.click(launch);
    await userEvent.click(launch);

    await waitFor(() => {
      expect(requests.some((r) => r.url.includes('/launch'))).toBe(true);
    });

    const keys = requests
      .filter((r) => r.url.includes('/launch'))
      .map((r) => r.headers['Idempotency-Key'] ?? '');

    expect(new Set(keys).size).toBe(1);
    // A UUID, not a counter: a guessable key lets one workspace's retry
    // collide with another's first attempt.
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  it('sends the declared source in the body, not merely a tick', async () => {
    // An attestation that reached the server as `{}` would satisfy a test
    // that only checked the request was made, and would record nothing.
    renderWizard('tracking', OWNER, campaign({ status: 'draft' }), [
      {
        method: 'POST',
        match: (url) => url.includes('/launch'),
        respond: () => ({ status: 202, body: { data: { ok: true } } }),
      },
    ]);

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /I confirm these contacts gave consent/u }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText(/Where did this audience agree/u),
      'signup_form',
    );

    await userEvent.click(screen.getByRole('button', { name: /Continue to Schedule/u }));
    await userEvent.click(await screen.findByRole('button', { name: /Continue to Review/u }));
    await userEvent.click(await screen.findByRole('button', { name: /Launch now|Schedule campaign/u }));

    await waitFor(() => {
      const launch = requests.find((r) => r.url.includes('/launch'));
      expect(launch?.body).toMatchObject({ consent: { source: 'signup_form' } });
    });
  });
});
