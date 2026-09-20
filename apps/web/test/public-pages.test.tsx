// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { publicRoutes } from '../src/routes/public/routes.js';

/**
 * Section A — the public pages (design frames A1, A2).
 *
 * The rules being tested are the design's, not pixels: who sees the landing
 * page and who is redirected past it, where the calls to action go, and the
 * one piece of behaviour on each page (the annual toggle's arithmetic and
 * the single-open FAQ).
 */

const realFetch = window.fetch;

function stubSession(authenticated: boolean): void {
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.endsWith('/auth/refresh')) {
      if (!authenticated) return new Response('{}', { status: 401 });
      return new Response(
        JSON.stringify({
          data: {
            accessToken: 'test-token',
            memberships: [
              {
                workspaceId: 'ws_1',
                workspaceName: 'Northwind Voyages',
                workspaceSlug: 'northwind-voyages',
                role: 'owner',
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response('{}', { status: 404 });
  }) as typeof window.fetch;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            {publicRoutes}
            <Route path="/dashboard" element={<div>DASHBOARD</div>} />
            <Route path="/register" element={<div>REGISTER</div>} />
            <Route path="/login" element={<div>LOGIN</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
});

afterEach(() => {
  // No `globals: true` in vitest.config.ts, so nothing unmounts by itself.
  cleanup();
  window.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('A1 landing', () => {
  it('shows the landing page to an anonymous visitor', async () => {
    stubSession(false);
    renderAt('/');

    expect(
      await screen.findByRole('heading', { name: 'Send campaigns through your own provider', level: 1 }),
    ).toBeTruthy();

    // The frame's three steps and the honest-numbers promise.
    expect(screen.getByRole('heading', { name: 'Three steps to your first send' })).toBeTruthy();
    expect(screen.getByText('Connect your provider')).toBeTruthy();
    // Once in the hero's reassurance row, once as a trust card.
    expect(screen.getAllByText('EU data region')).toHaveLength(2);
  });

  it('redirects a signed-in visitor to the dashboard', async () => {
    stubSession(true);
    renderAt('/');

    await waitFor(() => {
      expect(screen.getByText('DASHBOARD')).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { name: 'Send campaigns through your own provider' })).toBeNull();
  });

  it('points both calls to action at registration and sign-in', async () => {
    stubSession(false);
    renderAt('/');

    const start = await screen.findByRole('link', { name: 'Start free — no card' });
    expect(start.getAttribute('href')).toBe('/register');
    expect(screen.getByRole('link', { name: 'Create your workspace' }).getAttribute('href')).toBe('/register');
    expect(screen.getByRole('link', { name: 'See pricing' }).getAttribute('href')).toBe('/pricing');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    expect(screen.getByRole('link', { name: 'Get started' }).getAttribute('href')).toBe('/register');
  });

  it('shows the campaign panel with delivery uncertain counted, not hidden', async () => {
    stubSession(false);
    renderAt('/');

    expect(await screen.findByText('Autumn Escapes: Dubai → Santorini')).toBeTruthy();
    // The state badge and the bar's own "Sending" segment.
    expect(screen.getAllByText('Sending')).toHaveLength(2);
    // INVARIANTS D3: uncertain recipients are visible and unbilled. The
    // landing page says both.
    expect(screen.getByText('Delivery uncertain')).toBeTruthy();
    expect(screen.getByText('Delivery uncertain · 335')).toBeTruthy();
    expect(screen.getByText('Not billed')).toBeTruthy();
    // Open rate is never presented as exact.
    expect(screen.getByText('approx.')).toBeTruthy();
  });

  it('prints every segment of the hero bar with its count', async () => {
    stubSession(false);
    renderAt('/');

    // The sheet's fixed order, with counts always in the legend (frame A1).
    const legend: [string, string][] = [
      ['Delivered', '29,876'],
      ['Pending / queued', '16,595'],
      ['Sending', '1,240'],
      ['Soft bounce', '214'],
      ['Hard bounce / complaint / failed', '108'],
      ['Delivery uncertain', '180'],
    ];

    await screen.findByText('Autumn Escapes: Dubai → Santorini');
    for (const [label, count] of legend) {
      // "Sending" is also the campaign's state badge, so this counts rather
      // than insisting on one match.
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      expect(screen.getAllByText(count).length).toBeGreaterThan(0);
    }
  });
});

describe('A2 pricing', () => {
  it('renders the four plans monthly by default', async () => {
    stubSession(false);
    renderAt('/pricing');

    expect(await screen.findByRole('heading', { name: 'Pay for what you send', level: 1 })).toBeTruthy();

    for (const plan of ['Starter', 'Growth', 'Scale', 'Enterprise']) {
      expect(screen.getByText(plan)).toBeTruthy();
    }

    expect(screen.getByText('$49')).toBeTruthy();
    expect(screen.getByText('$249')).toBeTruthy();
    expect(screen.getByText('$749')).toBeTruthy();
    // Enterprise's price, and its Contacts and Analytics retention rows.
    expect(screen.getAllByText('Custom')).toHaveLength(3);
    expect(screen.getAllByText('billed monthly · cancel anytime')).toHaveLength(3);
    expect(screen.getByText('Most teams')).toBeTruthy();
  });

  it('switches to the annual prices and back', async () => {
    stubSession(false);
    renderAt('/pricing');

    await userEvent.click(await screen.findByRole('button', { name: /Annual/u }));

    // round(monthly * 10 / 12), and the year billed at ten months.
    expect(screen.getByText('$41')).toBeTruthy();
    expect(screen.getByText('$208')).toBeTruthy();
    expect(screen.getByText('$624')).toBeTruthy();
    expect(screen.getByText('$490 billed yearly')).toBeTruthy();
    expect(screen.getByText('$2490 billed yearly')).toBeTruthy();
    // Enterprise never gets a price.
    expect(screen.getByText('Annual contract')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(screen.getByText('$249')).toBeTruthy();
  });

  it('sends every plan call to action to registration', async () => {
    stubSession(false);
    renderAt('/pricing');

    const starts = await screen.findAllByRole('link', { name: 'Start free' });
    expect(starts).toHaveLength(3);
    for (const link of starts) expect(link.getAttribute('href')).toBe('/register');
    expect(screen.getByRole('link', { name: 'Talk to sales' }).getAttribute('href')).toBe('/register');
  });

  it('opens one FAQ answer at a time', async () => {
    stubSession(false);
    renderAt('/pricing');

    // The first question starts open, as the frame draws it.
    const first = await screen.findByRole('button', { name: /Do I still pay Amazon SES or SendGrid\?/u });
    expect(first.getAttribute('aria-expanded')).toBe('true');

    const second = screen.getByRole('button', { name: /What counts as an email sent\?/u });
    await userEvent.click(second);

    expect(second.getAttribute('aria-expanded')).toBe('true');
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/Test sends are not billed\./u)).toBeTruthy();

    // Clicking the open one closes it.
    await userEvent.click(second);
    expect(second.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the retention rule (D5) on the page', async () => {
    stubSession(false);
    renderAt('/pricing');

    expect(await screen.findByText('Retention applies forward.')).toBeTruthy();
    expect(screen.getByText(/is not restored if you upgrade later/u)).toBeTruthy();
  });
});
