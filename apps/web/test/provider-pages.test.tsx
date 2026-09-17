// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { ProvidersPage } from '../src/routes/providers/providers.js';
import { SendersPage } from '../src/routes/providers/senders.js';

const fetchMock = vi.fn();

const OWNER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'owner' }];
const VIEWER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'viewer' }];

interface Route {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { status?: number; body: unknown };
}

function mockApi(routes: Route[], role = OWNER) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/auth/refresh')) {
      return new Response(JSON.stringify({ data: { accessToken: 't', memberships: role } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const route = routes.find((candidate) => candidate.match(url, init));
    if (route === undefined) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const result = route.respond(url, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function renderPage(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>{ui}</AuthProvider>
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

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    providerType: 'ses',
    name: 'Production SES',
    status: 'active',
    hasWebhookSecret: true,
    lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    lastError: null,
    quotaSnapshot: { max24Hour: 50_000, sentLast24Hours: 120, maxSendRate: 14 },
    capabilities: { supportsWebhooks: true, reportsQuota: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('the connection card', () => {
  it('shows status, last check and the provider cap', async () => {
    mockApi([
      { match: (url) => url.endsWith('/providers'), respond: () => ({ body: { data: [connection()] } }) },
    ]);

    renderPage(<ProvidersPage />);

    expect(await screen.findByText('Production SES')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('120 / 50,000')).toBeTruthy();
  });

  it('shows the last error where there is one', async () => {
    mockApi([
      {
        match: (url) => url.endsWith('/providers'),
        respond: () => ({
          body: {
            data: [
              connection({
                status: 'error',
                lastError: { kind: 'auth_failed', message: 'The provider rejected these credentials' },
              }),
            ],
          },
        }),
      },
    ]);

    renderPage(<ProvidersPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/rejected these credentials/u)).toBeTruthy();
  });

  it('labels SMTP best-effort on the card, not only at connect time', async () => {
    // D4. The person reading this page a month later is the one planning a
    // campaign, and they need to know what tracking they are not getting.
    mockApi([
      {
        match: (url) => url.endsWith('/providers'),
        respond: () => ({
          body: {
            data: [
              connection({
                id: 'conn-2',
                providerType: 'smtp',
                name: 'Office SMTP',
                capabilities: { supportsWebhooks: false },
                hasWebhookSecret: false,
                quotaSnapshot: null,
              }),
            ],
          },
        }),
      },
    ]);

    renderPage(<ProvidersPage />);

    expect(await screen.findByText(/no delivery feedback/u)).toBeTruthy();
    expect(screen.getByText('Not supported')).toBeTruthy();
  });

  it('hides connect and disconnect from a viewer', async () => {
    mockApi(
      [{ match: (url) => url.endsWith('/providers'), respond: () => ({ body: { data: [connection()] } }) }],
      VIEWER,
    );

    renderPage(<ProvidersPage />);
    await screen.findByText('Production SES');

    expect(screen.queryByRole('button', { name: 'Connect a provider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });
});

describe('connecting', () => {
  it('shows the ingest URL once, loudly, and never again', async () => {
    // The token in it can write delivery events into this workspace.
    const ingestUrl = 'https://edge.relayd.test/ingest/v1/ses/tok_abcdefghijklmnopqrstuvwxyz012345';
    let connected = false;

    mockApi([
      {
        match: (url, init) => url.endsWith('/providers') && init?.method === 'POST',
        respond: () => {
          connected = true;
          return {
            status: 201,
            body: { data: { ...connection(), ingestUrl, warnings: [] } },
          };
        },
      },
      {
        match: (url) => url.endsWith('/providers'),
        respond: () => ({ body: { data: connected ? [connection()] : [] } }),
      },
    ]);

    renderPage(<ProvidersPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Connect a provider' }));

    await userEvent.type(screen.getByLabelText('A name for this connection'), 'Production SES');
    await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAIOSFODNN7EXAMPLE');
    await userEvent.type(screen.getByLabelText('Secret access key'), 'a-secret-value');
    await userEvent.type(screen.getByLabelText('Region'), 'eu-west-1');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText(ingestUrl)).toBeTruthy();
    expect(screen.getByText(/not shown again/u)).toBeTruthy();

    // Once dismissed it is gone: the list never carries it.
    await userEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    await waitFor(() => expect(screen.queryByText(ingestUrl)).toBeNull());
  });

  it('shows the warnings verification returned', async () => {
    // A sandboxed SES account delivers only to verified addresses. Without
    // this the campaign reports success and arrives nowhere.
    mockApi([
      {
        match: (url, init) => url.endsWith('/providers') && init?.method === 'POST',
        respond: () => ({
          status: 201,
          body: {
            data: {
              ...connection(),
              ingestUrl: 'https://edge.relayd.test/ingest/v1/ses/tok_x',
              warnings: ['This SES account is in the sandbox'],
            },
          },
        }),
      },
      { match: (url) => url.endsWith('/providers'), respond: () => ({ body: { data: [] } }) },
    ]);

    renderPage(<ProvidersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a provider' }));

    await userEvent.type(screen.getByLabelText('A name for this connection'), 'SES');
    await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAIOSFODNN7EXAMPLE');
    await userEvent.type(screen.getByLabelText('Secret access key'), 'secret');
    await userEvent.type(screen.getByLabelText('Region'), 'eu-west-1');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText(/in the sandbox/u)).toBeTruthy();
  });

  it('masks every credential field', async () => {
    // Pasted in shared screens and captured in recordings more often than
    // anyone admits.
    mockApi([{ match: (url) => url.endsWith('/providers'), respond: () => ({ body: { data: [] } }) }]);

    renderPage(<ProvidersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a provider' }));

    expect(screen.getByLabelText('Access key ID').getAttribute('type')).toBe('password');
    expect(screen.getByLabelText('Secret access key').getAttribute('type')).toBe('password');
    // The connection's name is not a credential.
    expect(screen.getByLabelText('A name for this connection').getAttribute('type')).toBe('text');
  });

  it('offers only the providers that are built', async () => {
    // Mailgun and Brevo are SHOULD-tier and Google is excluded by D6. Listing
    // them would be a promise the product does not keep.
    mockApi([{ match: (url) => url.endsWith('/providers'), respond: () => ({ body: { data: [] } }) }]);

    renderPage(<ProvidersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a provider' }));

    const options = within(screen.getByLabelText('Provider')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Amazon SES', 'SendGrid', 'SMTP']);
  });

  it('warns about SMTP before the credentials are entered', async () => {
    mockApi([{ match: (url) => url.endsWith('/providers'), respond: () => ({ body: { data: [] } }) }]);

    renderPage(<ProvidersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a provider' }));
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'smtp');

    expect(screen.getByText(/best-effort/u)).toBeTruthy();
  });
});

describe('senders', () => {
  function sender(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sender-1',
      providerId: 'conn-1',
      identityId: 'ident-1',
      fromEmail: 'hello@example.com',
      fromName: 'Acme',
      replyTo: null,
      status: 'active',
      dailyLimit: 5000,
      hourlyLimit: null,
      healthScore: 92,
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastSendAt: '2026-01-02T00:00:00.000Z',
      ...overrides,
    };
  }

  function routes(senders: unknown[], identities: unknown[] = []) {
    return [
      { match: (url: string) => url.endsWith('/providers'), respond: () => ({ body: { data: [connection()] } }) },
      { match: (url: string) => url.includes('/identities'), respond: () => ({ body: { data: identities } }) },
      { match: (url: string) => url.includes('/senders'), respond: () => ({ body: { data: senders } }) },
    ];
  }

  it('shows health as a number, not only a bar', async () => {
    // A slightly shorter bar is not actionable, and a bar alone cannot be
    // read by anyone using a screen reader.
    mockApi(routes([sender()]));

    renderPage(<SendersPage />);

    expect(await screen.findByText('hello@example.com')).toBeTruthy();
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('92');
    expect(screen.getByText('92')).toBeTruthy();
  });

  it('says "provider limit" rather than "unlimited" when none is set', async () => {
    // The provider's own cap still applies. Saying unlimited is a lie a
    // customer plans a campaign around.
    mockApi(routes([sender({ dailyLimit: null })]));

    renderPage(<SendersPage />);

    expect(await screen.findByText('Provider limit')).toBeTruthy();
    expect(screen.queryByText(/unlimited/iu)).toBeNull();
  });

  it('shows the identity verification status', async () => {
    // An identity can stop being verified without anyone touching Relayd —
    // a DNS record removed, a domain expired.
    mockApi(
      routes(
        [sender()],
        [
          {
            id: 'ident-1',
            providerId: 'conn-1',
            kind: 'domain',
            value: 'example.com',
            verificationStatus: 'failed',
            dkimStatus: 'pending',
            spfStatus: null,
            dmarcStatus: null,
            verifiedAt: null,
          },
        ],
      ),
    );

    renderPage(<SendersPage />);

    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
  });

  it('marks an SMTP sender best-effort in the table', async () => {
    mockApi([
      {
        match: (url: string) => url.endsWith('/providers'),
        respond: () => ({
          body: { data: [connection({ providerType: 'smtp', capabilities: { supportsWebhooks: false } })] },
        }),
      },
      { match: (url: string) => url.includes('/identities'), respond: () => ({ body: { data: [] } }) },
      { match: (url: string) => url.includes('/senders'), respond: () => ({ body: { data: [sender()] } }) },
    ]);

    renderPage(<SendersPage />);

    expect(await screen.findByText('best-effort')).toBeTruthy();
  });

  it('shows when a cooling-down sender recovers', async () => {
    mockApi(routes([sender({ status: 'cooling_down', cooldownUntil: '2026-02-01T00:00:00.000Z' })]));

    renderPage(<SendersPage />);

    expect(await screen.findByText('cooling down')).toBeTruthy();
    expect(screen.getByText(/^until /u)).toBeTruthy();
  });

  it('hides remove from a viewer', async () => {
    mockApi(routes([sender()]), VIEWER);

    renderPage(<SendersPage />);
    await screen.findByText('hello@example.com');

    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
