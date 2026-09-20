// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { App } from '../src/App.js';
import { AppShell } from '../src/components/app-shell.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { RouteSkeleton } from '../src/auth/guards.js';
import { ErrorPage } from '../src/routes/system/error-page.js';
import { configureApi, setAccessToken } from '../src/api/client.js';
import { errorMeta, requestIdOf } from '../src/query-client.js';

/**
 * Section K — the system states.
 *
 * These are conditions rather than pages, so what is worth asserting is the
 * contract each one carries: which workspace state raises which banner,
 * that a suspended workspace can still be read but not written, that a role
 * that cannot open a page is told which role can, and that the request ID
 * survives from the error envelope to the screen. None of that is visible
 * in a screenshot comparison.
 */

const SESSION = {
  accessToken: 'tok',
  user: { id: 'u1', name: 'Dana Haddad', email: 'dana@northwind.travel' },
  memberships: [
    { workspaceId: 'ws-nv', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind-voyages', role: 'owner' },
    { workspaceId: 'ws-ah', workspaceName: 'Aurelia Hotels Group', workspaceSlug: 'aurelia', role: 'admin' },
  ],
};

const USAGE = [
  { featureKey: 'emails.sent', used: 184_320, included: 250_000, overage: 0, periodEnd: '2026-10-01T00:00:00.000Z' },
];

const OVERVIEW = {
  subscription: { planName: 'Growth', planCode: 'pro', interval: 'month', status: 'active' },
  state: { workspaceSuspended: false, subscriptionSuspended: false, pastDue: false, hasSubscription: true },
  usage: USAGE,
  paymentMethod: null,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status >= 400 ? data : { data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mocks the four requests the shell makes, with the workspace record given. */
function mockApi(workspace: Record<string, unknown>, session: unknown = SESSION) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/auth/refresh')) return json(session);
    if (url.includes('/workspaces/current/members')) {
      return json([{ userId: 'u1', name: 'Dana Haddad', email: 'dana@northwind.travel', role: 'owner' }]);
    }
    if (url.includes('/workspaces/current')) return json(workspace);
    if (url.includes('/billing/usage')) return json(USAGE);
    if (url.includes('/billing')) return json(OVERVIEW);
    return json({ items: [], overview: null });
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const HEALTHY = { id: 'ws-nv', name: 'Northwind Voyages', slug: 'northwind-voyages', timezone: 'Asia/Dubai', status: 'active' };

function renderShell(workspace: Record<string, unknown>, page: ReactNode = <p>Campaigns page</p>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockApi(workspace);

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/campaigns']}>
        <AuthProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/campaigns" element={page} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  setAccessToken(null);
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */

describe('K1 — the global banners', () => {
  it('raises nothing for a healthy workspace', async () => {
    renderShell(HEALTHY);
    await screen.findByText('Campaigns page');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('K1a: past_due says sending continues, and points the Owner at billing', async () => {
    renderShell({ ...HEALTHY, status: 'past_due' });

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Payment failed on 15 Sep.');
    expect(banner.textContent).toContain('Sending continues while we retry your card for 14 days.');
    expect(within(banner).getByRole('link', { name: 'Update payment method' }).getAttribute('href')).toBe('/billing');
  });

  it('K1b: restricted says what is held and what stays available', async () => {
    renderShell({ ...HEALTHY, status: 'restricted' });

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Payment is 18 days overdue.');
    expect(banner.textContent).toContain('Contacts and reports stay available.');
  });

  it('K1d: the new-account cap is raised by the alert, not by a billing state', async () => {
    renderShell({ ...HEALTHY, alerts: { newAccountCap: { perDay: 500, endsAt: '2026-09-24T00:00:00.000Z' } } });

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('New account sending cap: 500 emails/day.');
    expect(within(banner).getByRole('link', { name: 'How caps work' })).toBeTruthy();
  });

  it('K1e: a complaint pause links to the campaign it paused', async () => {
    renderShell({
      ...HEALTHY,
      alerts: { complaintPause: { campaignId: 'cmp_6r9s2e', campaignName: 'Eid al-Etihad flash sale', rate: 0.0034 } },
    });

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Paused automatically: complaint rate exceeded 0.3%.');
    expect(within(banner).getByRole('link', { name: 'Review campaign' }).getAttribute('href')).toBe(
      '/campaigns/cmp_6r9s2e',
    );
  });

  it('K1f: a failed provider connection offers to fix it', async () => {
    renderShell({
      ...HEALTHY,
      alerts: { providerFailure: { connectionId: 'prv_sg_mkt', label: 'SendGrid · marketing' } },
    });

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Provider connection failed: SendGrid · marketing.');
    expect(within(banner).getByRole('link', { name: 'Fix connection' }).getAttribute('href')).toBe('/providers');
  });

  it('shows one banner at a time, the most severe (the sheet’s rule)', async () => {
    renderShell({
      ...HEALTHY,
      status: 'suspended',
      alerts: {
        newAccountCap: { perDay: 500, endsAt: '2026-09-24T00:00:00.000Z' },
        providerFailure: { connectionId: 'prv_sg_mkt', label: 'SendGrid · marketing' },
      },
    });

    const banners = await screen.findAllByRole('status');
    expect(banners).toHaveLength(1);
    expect(banners[0]?.textContent).toContain('Workspace suspended.');
    expect(document.body.textContent).not.toContain('New account sending cap');
  });
});

describe('K2 — the suspended workspace', () => {
  it('marks the top bar read-only and disables creating, with the reason', async () => {
    renderShell({ ...HEALTHY, status: 'suspended' });

    await screen.findByText('Campaigns page');
    expect(screen.getByText('Read-only')).toBeTruthy();

    const create = screen.getByRole('button', { name: /Create campaign/u });
    expect(create.hasAttribute('disabled')).toBe(true);
    expect(create.getAttribute('title')).toBe('Workspace is read-only');
  });

  it('keeps the data on screen — nothing is hidden, only writing is off', async () => {
    renderShell({ ...HEALTHY, status: 'suspended' });

    await screen.findByText('Campaigns page');
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
  });

  it('leaves a healthy workspace writable', async () => {
    renderShell(HEALTHY);

    await screen.findByText('Campaigns page');
    expect(screen.queryByText('Read-only')).toBeNull();
    expect(screen.getByRole('button', { name: /Create campaign/u }).hasAttribute('disabled')).toBe(false);
  });
});

describe('the sidebar usage block', () => {
  it('reads the emails row from GET /billing/usage and names the renewal', async () => {
    renderShell(HEALTHY);

    await screen.findByText('Campaigns page');
    await waitFor(() => {
      expect(screen.getByText('184,320 / 250,000')).toBeTruthy();
    });
    expect(screen.getByText(/Renews 1 Oct/u)).toBeTruthy();
  });
});

describe('K4a/K4b/K4c — the skeletons', () => {
  it('uses the dashboard composition for the dashboard', () => {
    render(<RouteSkeleton pathname="/dashboard" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading dashboard');
  });

  it('uses the table composition for a list page', () => {
    render(<RouteSkeleton pathname="/audience/contacts" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading table');
  });

  it('uses the detail composition for a record', () => {
    render(<RouteSkeleton pathname="/campaigns/cmp_8f3k2a" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading');
  });

  it('treats /campaigns/new as a form, not a record', () => {
    render(<RouteSkeleton pathname="/campaigns/new" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading table');
  });
});

describe('K4d — the generic error', () => {
  it('shows the request ID from the error envelope, in mono, with the status', () => {
    render(<ErrorPage title="Reports" error={{ status: 502, requestId: 'req_01J9K4ERR7Q2M8' }} />);

    expect(screen.getByText('Something went wrong on our side')).toBeTruthy();
    expect(screen.getByText('req_01J9K4ERR7Q2M8')).toBeTruthy();
    expect(screen.getByText(/HTTP 502/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy request ID' })).toBeTruthy();
  });

  it('draws no chip when the failure never reached the server', () => {
    render(<ErrorPage title="Reports" error={new Error('network down')} />);
    expect(screen.queryByRole('button', { name: 'Copy request ID' })).toBeNull();
  });

  it('retries through the caller, not by reloading', async () => {
    const onRetry = vi.fn();
    render(<ErrorPage title="Reports" error={{ status: 500, requestId: 'req_1' }} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('reads the id off an ApiError and nothing off a plain object', () => {
    expect(requestIdOf({ requestId: 'req_2' })).toBe('req_2');
    expect(requestIdOf({ requestId: '' })).toBeUndefined();
    expect(requestIdOf(null)).toBeUndefined();
    expect(errorMeta({ status: 502 }, new Date('2026-09-20T05:58:12Z'))).toContain('HTTP 502');
  });

  it('catches a page that throws and keeps the shell around it', async () => {
    function Explodes(): never {
      throw new Error('boom');
    }

    // React logs a caught render error; the boundary is the thing under test.
    const noop = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderShell(HEALTHY, <Explodes />);

    await waitFor(() => {
      expect(screen.getByText('Something went wrong on our side')).toBeTruthy();
    });
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
    noop.mockRestore();
  });
});

describe('the mobile top bar and its navigation drawer', () => {
  it('names the page, and carries the workspace monogram beside the bell', async () => {
    renderShell(HEALTHY);
    await screen.findByText('Campaigns page');

    // The desktop bar renders too (jsdom has no media queries), so the
    // mobile one is identified by its own control.
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeTruthy();
    // "Sending / Campaigns" in the crumb and again as the mobile title.
    expect(screen.getAllByText('Sending / Campaigns')).toHaveLength(2);
    expect(screen.getAllByText('NV').length).toBeGreaterThan(0);
  });

  it('opens every destination in a drawer, and closes on a choice', async () => {
    renderShell(HEALTHY);
    await screen.findByText('Campaigns page');

    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('link', { name: 'Suppressions' })).toBeTruthy();

    await userEvent.click(within(drawer).getByRole('link', { name: 'Templates' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('marks the read-only workspace in the mobile bar too', async () => {
    renderShell({ ...HEALTHY, status: 'suspended' });
    await screen.findByText('Campaigns page');
    // The create button carries the same reason; the mobile bar's is the lock.
    const marks = screen.getAllByTitle('Workspace is read-only');
    expect(marks.some((element) => element.tagName === 'SPAN')).toBe(true);
  });
});

describe('A4 — not found', () => {
  function renderApp(path: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApi(HEALTHY);

    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('answers an unknown path with the frame, not a 403', async () => {
    renderApp('/aurelia-hotels/campaigns/cmp_2k9x1p');

    expect(await screen.findByText("We can't find that page")).toBeTruthy();
    // The copy is the point: the page refuses to say which of the two it is.
    expect(document.body.textContent).toContain('Relayd shows the same page in both cases');
    expect(document.body.textContent).toContain('/aurelia-hotels/campaigns/cmp_2k9x1p');
  });

  it('offers the dashboard and a workspace switch', async () => {
    renderApp('/nope');

    const dashboard = await screen.findByRole('link', { name: 'Go to your dashboard' });
    expect(dashboard.getAttribute('href')).toBe('/dashboard');

    const swap = await screen.findByRole('button', { name: /Switch workspace/u });
    await waitFor(() => {
      expect(swap.hasAttribute('disabled')).toBe(false);
    });

    await userEvent.click(swap);
    expect(within(screen.getByRole('listbox', { name: 'Workspaces' })).getByText('Aurelia Hotels Group')).toBeTruthy();
  });
});
