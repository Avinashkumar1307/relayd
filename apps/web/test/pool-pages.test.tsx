// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { PoolsPage } from '../src/routes/pools/list.js';
import { PoolDrawer } from '../src/routes/pools/pool-drawer.js';
import { combineHeadroom, guardrail, usedByLabel } from '../src/routes/pools/headroom.js';
import type { EligibleSender } from '../src/api/pools.js';

/**
 * Section H — sending pools.
 *
 * The behaviour worth testing here is one rule: a quota belongs to a
 * provider connection, not to a sender, so two senders on one connection are
 * counted once. Every assertion below that looks like arithmetic is really
 * that rule, checked where a customer would notice it being broken — the
 * headroom the drawer reports and the sentence it puts under it.
 */

const fetchMock = vi.fn();

const OWNER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'owner' }];
const VIEWER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'viewer' }];

interface Stub {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { status?: number; body: unknown };
}

function mockApi(stubs: Stub[], role = OWNER) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/auth/refresh')) {
      return new Response(JSON.stringify({ data: { accessToken: 't', memberships: role } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const stub = stubs.find((candidate) => candidate.match(url, init));
    if (stub === undefined) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const result = stub.respond(url, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function renderAt(ui: ReactNode, path = '/pools') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/pools" element={<>{ui}</>} />
            <Route path="/pools/new" element={<>{ui}</>} />
            <Route path="/pools/:id" element={<>{ui}</>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  configureApi({ baseUrl: '/api/v1' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- fixtures -- */

const SES = {
  providerConnectionId: 'prv_ses_eu1',
  connectionLabel: 'Amazon SES · eu-west-1',
  monogram: 'SES',
  perSecond: 14,
  remainingToday: 8_800,
};

const SG = {
  providerConnectionId: 'prv_sg_mkt',
  connectionLabel: 'SendGrid · marketing',
  monogram: 'SG',
  perSecond: 50,
  remainingToday: 87_070,
};

const SENDERS: EligibleSender[] = [
  { id: 'snd_hello', email: 'hello@northwind.travel', blockedReason: null, ...SES },
  { id: 'snd_news', email: 'news@northwind.travel', blockedReason: null, ...SES },
  { id: 'snd_offers', email: 'offers@northwind.travel', blockedReason: null, ...SG },
  {
    id: 'snd_members',
    email: 'members@northwind.travel',
    blockedReason: 'Pending DNS',
    providerConnectionId: 'prv_smtp_1',
    connectionLabel: 'SMTP · mail.northwind.travel',
    monogram: 'SMTP',
    perSecond: 2,
    remainingToday: 3_880,
  },
];

const EU_POOL = {
  id: 'pool_eu_mkt',
  name: 'EU marketing pool',
  strategy: 'round_robin',
  isDefault: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  members: [
    { senderAccountId: 'snd_hello', email: 'hello@northwind.travel', monogram: 'SES' },
    { senderAccountId: 'snd_offers', email: 'offers@northwind.travel', monogram: 'SG' },
  ],
  combinedPerSecond: 64,
  headroom: { remaining: 95_870, total: 150_000, note: '2 connections · counted once each' },
  usedBy: ['Autumn Escapes', 'F1 early access', 'September newsletter'],
};

const NEWS_POOL = {
  ...EU_POOL,
  id: 'pool_news',
  name: 'Newsletter pool',
  strategy: 'failover',
  members: [
    { senderAccountId: 'snd_news', email: 'news@northwind.travel', monogram: 'SES' },
    { senderAccountId: 'snd_hello', email: 'hello@northwind.travel', monogram: 'SES' },
  ],
  combinedPerSecond: 14,
  headroom: { remaining: 8_800, total: 50_000, note: '1 connection · both senders share SES quota' },
  usedBy: ['September newsletter'],
};

const listStub = (body: unknown, status?: number): Stub => ({
  match: (url) => url.endsWith('/pools'),
  respond: () => ({ ...(status === undefined ? {} : { status }), body }),
});

const sendersStub: Stub = {
  match: (url) => url.endsWith('/pools/senders'),
  respond: () => ({ body: { data: SENDERS } }),
};

const detailStub = (memberIds: string[], pool: unknown = EU_POOL): Stub => ({
  // GET only: `PATCH /pools/pool_eu_mkt` ends with the same path.
  match: (url, init) => (init?.method ?? 'GET') === 'GET' && url.endsWith('/pools/pool_eu_mkt'),
  respond: () => ({
    body: {
      data: {
        pool,
        members: memberIds.map((senderAccountId) => ({
          poolId: 'pool_eu_mkt',
          senderAccountId,
          providerConnectionId: '',
          weight: 1,
          priority: 0,
          enabled: true,
          status: 'active',
          healthScore: 98,
          cooldownUntil: null,
        })),
      },
    },
  }),
});

/* ------------------------------------------------------------- H1a list -- */

describe('H1a, the pool list', () => {
  it('draws each pool with its members, strategy and combined headroom', async () => {
    mockApi([listStub({ data: [EU_POOL, NEWS_POOL] })]);
    renderAt(<PoolsPage />);

    const table = await screen.findByRole('table', { name: 'Sending pools' });
    const row = within(table).getByText('EU marketing pool').closest('tr');
    expect(row).not.toBeNull();

    const cells = within(row as HTMLElement);
    expect(cells.getByText('pool_eu_mkt')).toBeTruthy();
    expect(cells.getByText('hello@northwind.travel')).toBeTruthy();
    expect(cells.getByText('offers@northwind.travel')).toBeTruthy();
    expect(cells.getByText('Round-robin')).toBeTruthy();
    expect(cells.getByText('64')).toBeTruthy();
    expect(cells.getByText('95,870 / 150,000')).toBeTruthy();
    expect(cells.getByText('2 connections · counted once each')).toBeTruthy();
  });

  it('names the shared-quota rule under the table, because it is the rule people get wrong', async () => {
    mockApi([listStub({ data: [EU_POOL] })]);
    renderAt(<PoolsPage />);

    expect(
      await screen.findByText(
        'Senders that share a provider connection share one quota. Combined headroom counts each connection once.',
      ),
    ).toBeTruthy();
  });

  it('truncates the campaigns using a pool the way the frame does', () => {
    expect(usedByLabel(['Autumn Escapes', 'F1 early access', 'September newsletter'])).toBe(
      'Autumn Escapes, F1 early access, +1',
    );
    expect(usedByLabel([])).toBe('—');
  });

  it('shows H1e when the workspace has no pools', async () => {
    mockApi([listStub({ data: [] })]);
    renderAt(<PoolsPage />);

    expect(await screen.findByText('No pools yet')).toBeTruthy();
    expect(
      screen.getByText(
        'A pool groups two or more verified senders so a campaign can spread load across connections or fail over. Single-sender campaigns do not need one.',
      ),
    ).toBeTruthy();
  });

  it('shows H1f with the request id, and says campaigns keep sending', async () => {
    mockApi([
      listStub(
        {
          error: { code: 'internal_error', message: 'Upstream failed.', requestId: 'req_01J9H1FV3B7C' },
        },
        500,
      ),
    ]);
    renderAt(<PoolsPage />);

    expect(await screen.findByText("We couldn't load sending pools")).toBeTruthy();
    expect(screen.getByText('req_01J9H1FV3B7C')).toBeTruthy();
    expect(screen.getByText(/Campaigns already using a pool keep sending/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('hides Create pool from a role that cannot change sending infrastructure', async () => {
    mockApi([listStub({ data: [EU_POOL] })], VIEWER);
    renderAt(<PoolsPage />);

    await screen.findByRole('table', { name: 'Sending pools' });
    expect(screen.queryByRole('button', { name: 'Create pool' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create pool' })).toBeNull();

    // Reading a pool's members and its real headroom is `provider:read`, so
    // the way in stays: it is the save inside that is refused.
    expect(screen.getAllByRole('link', { name: 'Edit' }).length).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------- H1b drawer -- */

async function openDrawer(memberIds = ['snd_hello', 'snd_offers'], role = OWNER) {
  mockApi([listStub({ data: [EU_POOL] }), sendersStub, detailStub(memberIds)], role);
  renderAt(
    <>
      <PoolsPage />
      <PoolDrawer mode="edit" />
    </>,
    '/pools/pool_eu_mkt',
  );

  return within(await screen.findByRole('dialog', { name: 'Edit pool' }));
}

describe('H1b, the pool drawer', () => {
  it('opens on the pool, its strategy and its members', async () => {
    const drawer = await openDrawer();

    await waitFor(() => expect(drawer.getByLabelText('Pool name')).toHaveProperty('value', 'EU marketing pool'));
    expect((drawer.getByRole('radio', { name: /Round-robin/u }) as HTMLInputElement).checked).toBe(true);
    expect(drawer.getByText(/2 of 4 verified senders/u)).toBeTruthy();
    expect(drawer.getByText('95,870')).toBeTruthy();
    expect(drawer.getByText('emails left today · 64 /s')).toBeTruthy();
  });

  it('counts a connection once: adding a second SES sender does not raise headroom', async () => {
    const user = userEvent.setup();
    const drawer = await openDrawer();

    await waitFor(() => expect(drawer.getByText('95,870')).toBeTruthy());

    // Drop the SendGrid sender: only the SES connection is left.
    await user.click(drawer.getByRole('checkbox', { name: /offers@northwind.travel/u }));
    await waitFor(() => expect(drawer.getByText('8,800')).toBeTruthy());

    // Add a second sender on that same SES connection. Still 8,800.
    await user.click(drawer.getByRole('checkbox', { name: /news@northwind.travel/u }));
    expect(drawer.getByText('8,800')).toBeTruthy();
    expect(drawer.getByText('emails left today · 14 /s')).toBeTruthy();
    expect(
      drawer.getByText(
        'Two selected senders share one provider connection, so they share its quota. Adding both does not double headroom; the connection is counted once above.',
      ),
    ).toBeTruthy();
  });

  it('changes the speed rule with the strategy', async () => {
    const user = userEvent.setup();
    const drawer = await openDrawer();

    await waitFor(() => expect(drawer.getByText('round-robin · speeds add up across connections')).toBeTruthy());

    await user.click(drawer.getByRole('radio', { name: /Failover/u }));

    expect(drawer.getByText('failover · speed of the active member')).toBeTruthy();
    // Failover runs one connection at a time, so the pool is as fast as its
    // fastest member rather than as fast as both together.
    expect(drawer.getByText('emails left today · 50 /s')).toBeTruthy();
  });

  it('refuses to save a pool with fewer than two members, and says why', async () => {
    const user = userEvent.setup();
    const drawer = await openDrawer();

    await waitFor(() => expect(drawer.getByText('95,870')).toBeTruthy());
    await user.click(drawer.getByRole('checkbox', { name: /offers@northwind.travel/u }));

    const save = drawer.getByRole('button', { name: 'Save pool' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(save.getAttribute('title')).toBe('Pick at least two members');
  });

  it('will not pool a sender whose identity is not verified', async () => {
    const drawer = await openDrawer();

    const blocked = await drawer.findByRole('checkbox', { name: /members@northwind.travel/u });
    expect((blocked as HTMLInputElement).disabled).toBe(true);
    expect(drawer.getByText('Pending DNS')).toBeTruthy();
  });

  it('saves the membership diff and the changed name', async () => {
    const user = userEvent.setup();
    const calls: { method: string; url: string }[] = [];

    mockApi([
      listStub({ data: [EU_POOL] }),
      sendersStub,
      detailStub(['snd_hello', 'snd_offers']),
      {
        match: (url, init) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          if (method === 'GET') return false;
          calls.push({ method, url });
          return true;
        },
        respond: () => ({ body: { data: {} } }),
      },
    ]);

    renderAt(
      <>
        <PoolsPage />
        <PoolDrawer mode="edit" />
      </>,
      '/pools/pool_eu_mkt',
    );

    const drawer = within(await screen.findByRole('dialog', { name: 'Edit pool' }));
    await waitFor(() => expect(drawer.getByText('95,870')).toBeTruthy());

    await user.click(drawer.getByRole('checkbox', { name: /offers@northwind.travel/u }));
    await user.click(drawer.getByRole('checkbox', { name: /news@northwind.travel/u }));
    await user.clear(drawer.getByLabelText('Pool name'));
    await user.type(drawer.getByLabelText('Pool name'), 'EU pool');
    await user.click(drawer.getByRole('button', { name: 'Save pool' }));

    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toMatch(/\/pools\/pool_eu_mkt$/u);
    expect(calls[1]).toEqual({ method: 'DELETE', url: '/api/v1/pools/pool_eu_mkt/members/snd_offers' });
    expect(calls[2]).toEqual({ method: 'POST', url: '/api/v1/pools/pool_eu_mkt/members' });
  });

  it('is read-only for a role that cannot change pools', async () => {
    const drawer = await openDrawer(['snd_hello', 'snd_offers'], VIEWER);

    await waitFor(() => expect(drawer.getByText('95,870')).toBeTruthy());

    const save = drawer.getByRole('button', { name: 'Save pool' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(save.getAttribute('title')).toBe('Only Owners and Admins can change sending pools');
    expect((drawer.getByRole('checkbox', { name: /hello@northwind.travel/u }) as HTMLInputElement).disabled).toBe(true);
    expect(drawer.getByRole('button', { name: 'Delete pool' }).hasAttribute('disabled')).toBe(true);
  });
});

/* ----------------------------------------------------------- the rule -- */

describe('the headroom rule', () => {
  it('counts each connection once and adds speeds only for round-robin', () => {
    const both = SENDERS.filter((sender) => sender.id !== 'snd_members');

    const roundRobin = combineHeadroom(both, 'round_robin');
    expect(roundRobin.connections.length).toBe(2);
    expect(roundRobin.remaining).toBe(95_870);
    expect(roundRobin.perSecond).toBe(64);
    expect(roundRobin.shared).toBe(true);

    const failover = combineHeadroom(both, 'failover');
    expect(failover.perSecond).toBe(50);
  });

  it('says the general thing until a connection is actually shared', () => {
    expect(guardrail(false)).toMatch(/Pools do not raise provider limits/u);
    expect(guardrail(true)).toMatch(/Two selected senders share one provider connection/u);
  });
});
