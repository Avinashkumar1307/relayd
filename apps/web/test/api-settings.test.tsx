// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { configureApi } from '../src/api/client.js';
import type { ApiKey } from '../src/api/platform.js';
import { ApiKeysPage, NewApiKeyPage } from '../src/routes/settings/api-keys.js';

/**
 * J3 — API keys.
 *
 * The page's one job is to hand over a credential exactly once, so the tests
 * are mostly about that and about the three things a redesign would quietly
 * remove: the create dialog saying in words that there are no billing scopes
 * (CLAUDE.md section 11), a revoked key staying in the list with its date,
 * and the reveal page refusing to exist without a secret to reveal.
 */

const responses = new Map<string, unknown>();

let readOnly = false;

vi.mock('../src/auth/AuthProvider.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    memberships: [],
    currentWorkspaceId: 'ws_1',
    user: { id: 'u_1', name: 'Dana Haddad', email: 'dana@northwind.travel' },
    current: {
      workspaceId: 'ws_1',
      workspaceName: 'Northwind Voyages',
      workspaceSlug: 'nv',
      role: 'owner',
    },
    permissions: ['apikey:write'],
    can: () => true,
  }),
}));

vi.mock('../src/auth/workspace-state.js', () => ({
  useReadOnly: () => readOnly,
  useWorkspaceStatus: () => ({ status: readOnly ? 'suspended' : 'active', loading: false }),
  useWorkspaceRecord: () => ({
    data: { id: 'ws_1', name: 'Northwind Voyages', slug: 'nv', timezone: 'UTC' },
    isPending: false,
  }),
}));

const KEY: ApiKey = {
  id: 'key_01J7Q1',
  name: 'Production sync',
  keyPrefix: 'rk_live_7f3a',
  environment: 'live',
  integration: 'HubSpot',
  createdByName: 'Omar Haddad',
  revokedByName: null,
  scopes: ['contacts:write', 'campaigns:read'],
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-06-02T12:00:00.000Z',
};

const SCOPES = {
  scopes: [
    'contacts:read',
    'contacts:write',
    'campaigns:launch',
    'reports:read',
    'webhooks:manage',
  ],
};

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();
  readOnly = false;

  responses.set('GET /api-keys/scopes', SCOPES);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      const match = [...responses.entries()]
        .filter(([pattern]) => {
          const [patternMethod, patternPath] = pattern.split(' ');
          return method === patternMethod && url.includes(String(patternPath));
        })
        .sort((a, b) => b[0].length - a[0].length)[0];

      if (match === undefined) {
        return new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'no stub', requestId: 'req_01J9J3FK' } }),
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

/** The desktop table. Every list page also renders a mobile card list, so an
 *  unscoped getByText finds both. */
const table = (): HTMLElement => screen.getByRole('table', { name: 'API keys' });

function wrap(children: ReactNode, path = '/settings/api', state?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: path, state }]}>
        <Routes>
          <Route path="/settings/api" element={children} />
          <Route path="/settings/api/new" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ISSUED = {
  ...KEY,
  id: 'key_new',
  name: 'CRM sync (HubSpot)',
  keyPrefix: 'rk_live_3e9c',
  scopes: ['contacts:read', 'contacts:write', 'lists:read'],
  createdAt: '2026-09-20T09:14:00.000Z',
  keyShownOnce: 'rk_live_3e9c7a1d5b2f8e4c0a6d9b3f7e1c5a8d2b4f6e0c',
};

describe('J3a — the key list', () => {
  it('shows the prefix and never a whole key', async () => {
    responses.set('GET /api-keys', [KEY]);
    wrap(<ApiKeysPage />);

    await screen.findAllByText('Production sync');
    expect(within(table()).getByText('Production sync')).toBeTruthy();
    expect(within(table()).getByText('rk_live_7f3a…')).toBeTruthy();
  });

  it('names the integration and who created it', async () => {
    responses.set('GET /api-keys', [KEY]);
    wrap(<ApiKeysPage />);

    await screen.findAllByText('HubSpot · created by Omar Haddad');
    expect(within(table()).getByText('HubSpot · created by Omar Haddad')).toBeTruthy();
  });

  it('prints Never rather than a blank for a key nothing has used', async () => {
    responses.set('GET /api-keys', [KEY]);
    wrap(<ApiKeysPage />);

    await screen.findAllByText(/Never/u);
    expect(within(table()).getByText('Never')).toBeTruthy();
  });

  it('keeps a revoked key in the list, with the date and who did it', async () => {
    // The question after a leak is "was it revoked, and when". A list that
    // hides them answers with silence.
    responses.set('GET /api-keys', [
      { ...KEY, revokedAt: '2026-08-12T00:00:00.000Z', revokedByName: 'Dana Haddad' },
    ]);
    wrap(<ApiKeysPage />);

    await screen.findAllByText('Revoked 12 Aug 2026 by Dana Haddad');
    expect(within(table()).getByText('Revoked 12 Aug 2026 by Dana Haddad')).toBeTruthy();
    expect(within(table()).getByText('Revoked')).toBeTruthy();
  });

  it('offers no revoke button for an already revoked key', async () => {
    responses.set('GET /api-keys', [{ ...KEY, revokedAt: '2026-08-12T00:00:00.000Z' }]);
    wrap(<ApiKeysPage />);

    await screen.findAllByText('Revoked');
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBe(null);
  });

  it('says what a key can never do, under the table', async () => {
    responses.set('GET /api-keys', [KEY]);
    wrap(<ApiKeysPage />);

    expect((await screen.findAllByText(/no key can touch billing/u)).length).toBeGreaterThan(0);
  });

  it('confirms before revoking, and says what breaks', async () => {
    responses.set('GET /api-keys', [KEY]);
    responses.set('DELETE /api-keys/key_01J7Q1', { revoked: true });
    wrap(<ApiKeysPage />);

    const revokes = await screen.findAllByRole('button', { name: 'Revoke' });
    await userEvent.click(revokes[0] as HTMLElement);

    expect(await screen.findByText('Revoke this key?')).toBeTruthy();
    expect(screen.getByText(/stops working immediately/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke key' })).toBeTruthy();
  });

  it('disables both writes when the workspace is read-only, and says why', async () => {
    readOnly = true;
    responses.set('GET /api-keys', [KEY]);
    wrap(<ApiKeysPage />);

    const revokes = await screen.findAllByRole('button', { name: 'Revoke' });
    for (const revoke of revokes) {
      expect(revoke.hasAttribute('disabled')).toBe(true);
      expect(revoke.getAttribute('title')).toBe('Workspace is read-only');
    }

    const create = screen.getByRole('button', { name: 'Create key' });
    expect(create.hasAttribute('disabled')).toBe(true);
    expect(create.getAttribute('title')).toBe('Workspace is read-only');

    // K2: the data stays visible.
    expect(within(table()).getByText('Production sync')).toBeTruthy();
  });
});

describe('J3e / J3f — nothing, and nothing loaded', () => {
  it('says what a key is for, and that billing is never one', async () => {
    responses.set('GET /api-keys', []);
    wrap(<ApiKeysPage />);

    expect(await screen.findByText('No API keys yet')).toBeTruthy();
    expect(screen.getByText(/Billing is never available through the API/u)).toBeTruthy();
  });

  it('shows the request ID and says existing keys keep working', async () => {
    // No stub for GET /api-keys, so the client 404s.
    wrap(<ApiKeysPage />);

    expect(await screen.findByText("We couldn't load API keys")).toBeTruthy();
    expect(screen.getByText(/Existing keys keep working/u)).toBeTruthy();
    expect(screen.getByText('req_01J9J3FK')).toBeTruthy();
  });
});

describe('J3b — creating a key', () => {
  /** Opens the dialog and hands back its scope: the page has its own
   *  "Create key" buttons (J3e draws one in the header and one in the empty
   *  state), so every assertion about the dialog is made inside it. */
  const open = async (): Promise<HTMLElement> => {
    responses.set('GET /api-keys', []);
    wrap(<ApiKeysPage />);
    const buttons = await screen.findAllByRole('button', { name: 'Create key' });
    await userEvent.click(buttons[0] as HTMLElement);
    return screen.getByRole('dialog');
  };

  it('offers only the scopes this person can grant', async () => {
    // Offering `billing:write` and letting the POST refuse it is a form the
    // user cannot complete and cannot see why.
    await open();

    expect(await screen.findByText('contacts:read')).toBeTruthy();
    expect(screen.queryByText('billing:write')).toBe(null);
  });

  it('says in words that there are no billing scopes', async () => {
    // The absence is deliberate (CLAUDE.md section 11), so it is stated. A
    // gap where a row would be reads as an oversight.
    await open();

    expect(
      await screen.findByText(/There are no billing scopes\. Plans, payment and cancellation/u),
    ).toBeTruthy();
  });

  it('groups the scopes the way the frame does', async () => {
    await open();

    expect(await screen.findByText('Contacts')).toBeTruthy();
    expect(screen.getByText('Campaigns')).toBeTruthy();
    expect(screen.getByText('Reports & webhooks')).toBeTruthy();
  });

  it('counts what is selected', async () => {
    await open();
    await userEvent.click(await screen.findByText('contacts:read'));

    expect(screen.getByText('· 1 selected')).toBeTruthy();
  });

  it('will not submit without a name', async () => {
    const dialog = await open();
    await userEvent.click(await screen.findByText('contacts:read'));

    expect(
      within(dialog).getByRole('button', { name: 'Create key' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('will not submit without a scope', async () => {
    const dialog = await open();
    await userEvent.type(await screen.findByLabelText('Name'), 'CI');

    expect(
      within(dialog).getByRole('button', { name: 'Create key' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('posts the scopes and the environment', async () => {
    responses.set('POST /api-keys', ISSUED);
    const dialog = await open();

    await userEvent.type(await screen.findByLabelText('Name'), 'CRM sync');
    await userEvent.click(screen.getByText('contacts:read'));
    await userEvent.selectOptions(screen.getByLabelText('Environment'), 'test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find(
        (call) => String(call[0]).endsWith('/api-keys') && (call[1] as RequestInit).method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        name: 'CRM sync',
        scopes: ['contacts:read'],
        environment: 'test',
      });
    });
  });
});

describe('J3c — the reveal, once', () => {
  it('shows the whole key and says it is the only time', async () => {
    wrap(<NewApiKeyPage />, '/settings/api/new', { issued: ISSUED });

    expect(await screen.findByText('Key created: CRM sync (HubSpot)')).toBeTruthy();
    expect(screen.getByText(ISSUED.keyShownOnce)).toBeTruthy();
    expect(screen.getByText('This is the only time the full key is shown.')).toBeTruthy();
  });

  it('names the scopes, the expiry and who created it', async () => {
    wrap(<NewApiKeyPage />, '/settings/api/new', { issued: ISSUED });

    expect(
      await screen.findByText(
        /Live · contacts:read, contacts:write, lists:read · never expires · created by Dana Haddad/u,
      ),
    ).toBeTruthy();
  });

  it('holds Done back until the key is acknowledged, and says why', async () => {
    wrap(<NewApiKeyPage />, '/settings/api/new', { issued: ISSUED });

    const done = await screen.findByRole('button', { name: 'Done — back to API keys' });
    expect(done.hasAttribute('disabled')).toBe(true);
    expect(done.getAttribute('title')).toBe('Confirm you have stored the key first');

    await userEvent.click(screen.getByText("I've stored this key somewhere safe"));

    expect(screen.getByRole('link', { name: 'Done — back to API keys' })).toBeTruthy();
  });

  it('goes back to the list when there is no secret to show', async () => {
    // A refresh, a bookmark or a second tab. There is nothing stored that
    // could answer, so the page does not pretend there is.
    responses.set('GET /api-keys', [KEY]);
    wrap(<NewApiKeyPage />, '/settings/api/new');

    expect(screen.queryByText(/only time the full key is shown/u)).toBe(null);
  });
});
