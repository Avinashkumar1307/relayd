// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';

/**
 * The shell and the sign-in page, mounted through the real App with the API
 * mocked (the Phase 1 handoff: "against mocked API responses for now").
 *
 * Two questions a screenshot cannot answer:
 *
 *   Does the wired shell render the design's navigation for a signed-in
 *   member, with billing locked for a non-owner and the current section
 *   announced?
 *
 *   Does the sign-in page render B1's copy and controls, and does the eye
 *   toggle work through React Hook Form's `register` ref?
 */

const SESSION = {
  accessToken: 'tok',
  memberships: [
    { workspaceId: 'ws-nv', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind-voyages', role: 'editor' },
    { workspaceId: 'ws-ah', workspaceName: 'Aurelia Hotels Group', workspaceSlug: 'aurelia', role: 'admin' },
  ],
};

let signedIn = true;

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return signedIn
          ? new Response(JSON.stringify({ data: SESSION }), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'no', requestId: 'r' } }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
      }
      // Any page query: an empty but well-formed answer.
      return new Response(JSON.stringify({ data: { overview: null, items: [], nextCursor: null } }), {
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

function mount(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the shell, signed in as an editor', () => {
  it('renders the sidebar from the design, with billing locked', async () => {
    signedIn = true;
    mount('/campaigns');

    const nav = await screen.findByRole('navigation', { name: 'Sections' });

    for (const label of ['Overview', 'Audience', 'Sending', 'Delivery', 'Analytics', 'Settings']) {
      expect(within(nav).getByText(label)).toBeTruthy();
    }
    expect(within(nav).getByRole('link', { current: 'page' }).textContent).toContain('Campaigns');

    // An editor is not the owner: billing shows locked, not as a link.
    expect(within(nav).queryByRole('link', { name: /Billing/u })).toBeNull();
    expect(within(nav).getByTitle('Owner only')).toBeTruthy();
  });

  it('puts the workspace in the top bar breadcrumb with its monogram', async () => {
    signedIn = true;
    mount('/campaigns');

    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('NV')).toBeTruthy();
    expect(within(crumbs).getByText('Northwind Voyages')).toBeTruthy();
    expect(within(crumbs).getByText('Campaigns')).toBeTruthy();
  });

  it('lists the other workspace in the switcher', async () => {
    signedIn = true;
    mount('/campaigns');

    await screen.findByRole('navigation', { name: 'Sections' });
    expect(screen.getByRole('button', { name: /Northwind Voyages/u })).toBeTruthy();
  });
});

describe('B1 Sign in /login', () => {
  it('renders the frame: title, subtitle, fields, forgot link, button, footer, create-account line', async () => {
    signedIn = false;
    mount('/login');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText('Use the work email you registered with.')).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Forgot password?' }).getAttribute('href')).toBe('/forgot-password');
    expect(screen.getByRole('button', { name: 'Sign in' }).getAttribute('type')).toBe('submit');
    expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe('/register');
    expect(screen.getByText('© 2026 Relayd')).toBeTruthy();
    expect(screen.getByText('Relayd', { selector: 'span' })).toBeTruthy();
  });

  it('shows the password behind the eye toggle', async () => {
    signedIn = false;
    mount('/login');

    const password = (await screen.findByLabelText('Password')) as HTMLInputElement;
    expect(password.type).toBe('password');

    screen.getByRole('button', { name: 'Show password' }).click();
    await waitFor(() => expect(password.type).toBe('text'));
  });

  it('does not render the app shell around the sign-in page', async () => {
    signedIn = false;
    mount('/login');

    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
  });
});
