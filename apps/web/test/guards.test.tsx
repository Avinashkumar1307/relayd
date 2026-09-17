// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { IfPermitted, RequireAuth, RequirePermission } from '../src/auth/guards.js';
import { configureApi, setAccessToken } from '../src/api/client.js';

const fetchMock = vi.fn();

/** Answers the refresh-on-load call with a session, or with a 401. */
function mockSession(
  memberships: { workspaceId: string; workspaceName: string; workspaceSlug: string; role: string }[] | null,
) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/auth/refresh')) {
      return memberships === null
        ? new Response(
            JSON.stringify({ error: { code: 'unauthenticated', message: 'no', requestId: 'r' } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ data: { accessToken: 'token', memberships } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function renderWithAuth(ui: ReactNode, initialPath = '/protected') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/protected" element={ui} />
            <Route path="/login" element={<p>Sign in page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const OWNER = [
  { workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'owner' },
];
const VIEWER = [
  { workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'viewer' },
];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  configureApi({ baseUrl: '/api/v1' });
  setAccessToken(null);
  globalThis.localStorage?.clear();
});

afterEach(() => {
  // Vitest does not run React Testing Library's automatic cleanup unless
  // `globals` is enabled, and it is not. Without this, every render stays in
  // the document and `screen` queries find the previous test's markup — which
  // shows up as a role-gating test passing for the wrong reason.
  cleanup();
  vi.unstubAllGlobals();
});

describe('RequireAuth', () => {
  it('redirects an anonymous visitor to login', async () => {
    mockSession(null);
    renderWithAuth(
      <RequireAuth>
        <p>Secret content</p>
      </RequireAuth>,
    );

    await waitFor(() => {
      expect(screen.getByText('Sign in page')).toBeDefined();
    });
    expect(screen.queryByText('Secret content')).toBeNull();
  });

  it('renders the page for a signed-in user', async () => {
    mockSession(OWNER);
    renderWithAuth(
      <RequireAuth>
        <p>Secret content</p>
      </RequireAuth>,
    );

    await waitFor(() => {
      expect(screen.getByText('Secret content')).toBeDefined();
    });
  });

  it('shows a loading state rather than flashing the login page', async () => {
    // Without this, every reload flashes "signed out" for the duration of the
    // refresh round trip, which reads as a bug to the user.
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              new Response(JSON.stringify({ data: { accessToken: 't', memberships: OWNER } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
        }),
    );

    renderWithAuth(
      <RequireAuth>
        <p>Secret content</p>
      </RequireAuth>,
    );

    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.queryByText('Sign in page')).toBeNull();

    release?.();
    await waitFor(() => {
      expect(screen.getByText('Secret content')).toBeDefined();
    });
  });
});

describe('role-aware gating', () => {
  it('shows a control an owner may use', async () => {
    mockSession(OWNER);
    renderWithAuth(
      <RequireAuth>
        <IfPermitted permission="billing:write">
          <button type="button">Change plan</button>
        </IfPermitted>
      </RequireAuth>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Change plan' })).toBeDefined();
    });
  });

  it('hides a control a viewer may not use', async () => {
    mockSession(VIEWER);
    renderWithAuth(
      <RequireAuth>
        <IfPermitted permission="billing:write">
          <button type="button">Change plan</button>
        </IfPermitted>
      </RequireAuth>,
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
    });
  });

  it('hides campaign:launch from an editor but keeps campaign:write', async () => {
    mockSession([
      { workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'editor' },
    ]);

    renderWithAuth(
      <RequireAuth>
        <IfPermitted permission="campaign:write">
          <span>Edit campaign</span>
        </IfPermitted>
        <IfPermitted permission="campaign:launch">
          <span>Launch campaign</span>
        </IfPermitted>
      </RequireAuth>,
    );

    await waitFor(() => {
      expect(screen.getByText('Edit campaign')).toBeDefined();
    });
    expect(screen.queryByText('Launch campaign')).toBeNull();
  });

  it('explains rather than 404s when a page needs a permission the role lacks', async () => {
    mockSession(VIEWER);
    renderWithAuth(
      <RequireAuth>
        <RequirePermission permission="workspace:update">
          <p>Settings form</p>
        </RequirePermission>
      </RequireAuth>,
    );

    await waitFor(() => {
      expect(screen.getByText(/do not have access/iu)).toBeDefined();
    });
    expect(screen.queryByText('Settings form')).toBeNull();
    // Names the missing permission, so the user can ask for the right thing.
    expect(screen.getByText('workspace:update')).toBeDefined();
  });
});
