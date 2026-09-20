// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { providersRoutes } from '../src/routes/providers/routes.js';

/**
 * Section E, tested on the frames' rules rather than on pixels.
 *
 * What these hold onto: a connection card says what E1a says (health, the
 * provider's own cap, whether events are actually arriving); SMTP is
 * labelled best-effort everywhere it is offered or used, which is D4; the
 * inbound webhook URL is shown exactly once and is unreachable afterwards;
 * no credential is ever echoed or read back; the sender table answers "can
 * this address send" and where its quota comes from; and a missing
 * permission removes the write actions rather than failing on the server.
 */

const fetchMock = vi.fn();

const OWNER = [
  { workspaceId: 'ws-1', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind', role: 'owner' },
];
const VIEWER = [
  { workspaceId: 'ws-1', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind', role: 'viewer' },
];

interface Stub {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { status?: number; body: unknown };
}

const calls: { url: string; method: string; body: unknown }[] = [];

function mockApi(routes: Stub[], role = OWNER) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });

    if (url.includes('/auth/refresh')) {
      return new Response(
        JSON.stringify({
          data: {
            accessToken: 't',
            memberships: role,
            user: { id: 'u1', name: 'Dana Haddad', email: 'dana@northwind.travel' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const route = routes.find((candidate) => candidate.match(url, init));
    const result = route?.respond(url, init) ?? { body: { data: [] } };

    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** The whole section's route table, so `/senders/:id` is the drawer it is. */
function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>{providersRoutes}</Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  calls.length = 0;
  configureApi({ baseUrl: '/api/v1' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prv_ses_eu1',
    providerType: 'ses',
    name: 'eu-west-1 · production',
    status: 'active',
    hasWebhookSecret: true,
    lastVerifiedAt: '2026-03-12T08:20:00.000Z',
    lastError: null,
    quotaSnapshot: { max24Hour: 50_000, sentLast24Hours: 41_200, maxSendRate: 14 },
    capabilities: { supportsWebhooks: true, reportsQuota: true },
    createdAt: '2026-03-12T08:20:00.000Z',
    ...overrides,
  };
}

const isProviders = (url: string): boolean => url.includes('/providers') && !url.includes('/identities');

describe('the connection card', () => {
  it('shows status, last check and the provider cap', async () => {
    mockApi([
      { match: (url) => isProviders(url), respond: () => ({ body: { data: [connection()] } }) },
    ]);

    renderAt('/providers');

    expect(await screen.findByText('Amazon SES')).toBeTruthy();
    expect(screen.getByText('eu-west-1 · production')).toBeTruthy();
    expect(screen.getByText('Healthy')).toBeTruthy();
    expect(screen.getByText('Verified 12 Mar 2026')).toBeTruthy();
    expect(screen.getByText('41,200 / 50,000')).toBeTruthy();
    // Relayd's own throttle, which is not the provider's cap and is the
    // number a customer plans a launch window around.
    expect(screen.getByText('Relayd throttles to this')).toBeTruthy();
  });

  it('shows the last error where there is one', async () => {
    mockApi([
      {
        match: (url) => isProviders(url),
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

    renderAt('/providers');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/rejected these credentials/u)).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('says whether delivery events are actually arriving', async () => {
    // E1a's third cell. A webhook that silently stopped is the one failure
    // a customer cannot see from anywhere else in the product.
    mockApi([
      {
        match: (url) => isProviders(url),
        respond: () => ({
          body: {
            data: [
              connection({
                status: 'degraded',
                webhook: {
                  state: 'no_events',
                  label: 'No events since 08:40',
                  detail: 'No events since 08:40 · check Event Webhook in SendGrid',
                },
              }),
            ],
          },
        }),
      },
    ]);

    renderAt('/providers');

    expect(await screen.findByText('No events since 08:40')).toBeTruthy();
    expect(screen.getByText(/check Event Webhook in SendGrid/u)).toBeTruthy();
  });

  it('labels SMTP best-effort on the card, not only at connect time', async () => {
    // D4. The person reading this page a month later is the one planning a
    // campaign, and they need to know what tracking they are not getting.
    mockApi([
      {
        match: (url) => isProviders(url),
        respond: () => ({
          body: {
            data: [
              connection({
                id: 'prv_smtp_1',
                providerType: 'smtp',
                name: 'mail.northwind.travel',
                capabilities: { supportsWebhooks: false },
                hasWebhookSecret: false,
              }),
            ],
          },
        }),
      },
    ]);

    renderAt('/providers');

    expect(await screen.findByText('Best-effort delivery feedback')).toBeTruthy();
    expect(screen.getByText('Best-effort · no webhooks')).toBeTruthy();
  });

  it('draws the empty state E1e draws, with its own way in', async () => {
    mockApi([{ match: (url) => isProviders(url), respond: () => ({ body: { data: [] } }) }]);

    renderAt('/providers');

    expect(await screen.findByText('No provider connected')).toBeTruthy();
    expect(
      screen.getByText(/Relayd sends through your Amazon SES, SendGrid or SMTP account/u),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Connect provider' }).length).toBe(2);
  });

  it('gives the request id when the list fails to load', async () => {
    mockApi([
      {
        match: (url) => isProviders(url),
        respond: () => ({
          status: 500,
          body: { error: { code: 'internal', message: 'boom', requestId: 'req_01J9E1FZ2M8T' } },
        }),
      },
    ]);

    renderAt('/providers');

    expect(await screen.findByText("We couldn't load provider connections")).toBeTruthy();
    expect(screen.getByText('req_01J9E1FZ2M8T')).toBeTruthy();
  });

  it('hides connect and disconnect from a viewer', async () => {
    mockApi([{ match: (url) => isProviders(url), respond: () => ({ body: { data: [connection()] } }) }], VIEWER);

    renderAt('/providers');
    await screen.findByText('Amazon SES');

    expect(screen.queryByRole('button', { name: /Connect provider/u })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).toBeNull();
  });
});

describe('connecting a provider', () => {
  const INGEST = 'https://hooks.relayd.io/in/prv_ses_eu1/9f2c1a7e4b3d8c5f2a1e6b9d0c4f7a2e';

  function connectStubs(warnings: string[] = []) {
    return [
      {
        match: (url: string, init?: RequestInit) =>
          url.endsWith('/providers') && init?.method === 'POST',
        respond: () => ({
          status: 201,
          body: { data: { ...connection(), ingestUrl: INGEST, warnings } },
        }),
      },
      { match: (url: string) => isProviders(url), respond: () => ({ body: { data: [] } }) },
    ];
  }

  async function fillSesAndSubmit() {
    await userEvent.click(await screen.findByRole('button', { name: /Amazon SES/u }));
    await userEvent.type(screen.getByLabelText('Connection label'), 'eu-west-1 · production');
    await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIA3F7Q2B9XEXAMPLE');
    await userEvent.type(screen.getByLabelText('Secret access key'), 'a-secret-value');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and connect' }));
  }

  it('offers every provider that is built, and no provider that is not', async () => {
    // Mailgun and Brevo have adapters, so they are offered on the frame's
    // own card pattern. Google Workspace is excluded by D6, and listing it
    // would be a promise the product does not keep.
    mockApi(connectStubs());

    renderAt('/providers/connect');

    expect(await screen.findByText('Which provider will this connection use?')).toBeTruthy();
    for (const name of ['Amazon SES', 'SendGrid', 'Any SMTP server', 'Mailgun', 'Brevo']) {
      expect(screen.getByRole('button', { name: new RegExp(name, 'u') })).toBeTruthy();
    }
    expect(screen.queryByText(/Google Workspace/u)).toBeNull();
  });

  it('warns about SMTP before any credential is entered', async () => {
    // The trade is made at the moment of choosing, not after the keys are in.
    mockApi(connectStubs());

    renderAt('/providers/connect');
    expect(await screen.findByText('Best-effort · no bounce webhooks')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Any SMTP server/u }));

    expect(screen.getByText(/no bounce or complaint webhooks/u)).toBeTruthy();
  });

  it('masks every credential and echoes none of them back', async () => {
    // Pasted in shared screens and captured in recordings more often than
    // anyone admits — and the database stores an ARN, never the secret.
    mockApi(connectStubs());

    renderAt('/providers/connect');
    await userEvent.click(await screen.findByRole('button', { name: /Amazon SES/u }));

    expect(screen.getByLabelText('Secret access key').getAttribute('type')).toBe('password');
    expect(screen.getByLabelText('Secret access key').getAttribute('autocomplete')).toBe('new-password');
    // The connection's label is not a credential.
    expect(screen.getByLabelText('Connection label').getAttribute('type')).not.toBe('password');
  });

  it('will not submit until the provider has everything it needs', async () => {
    mockApi(connectStubs());

    renderAt('/providers/connect');
    await userEvent.click(await screen.findByRole('button', { name: /Amazon SES/u }));

    const submit = screen.getByRole('button', { name: 'Verify and connect' });
    expect(submit.hasAttribute('disabled')).toBe(true);

    await userEvent.type(screen.getByLabelText('Connection label'), 'eu-west-1 · production');
    await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIA3F7Q2B9XEXAMPLE');
    expect(submit.hasAttribute('disabled')).toBe(true);

    await userEvent.type(screen.getByLabelText('Secret access key'), 'a-secret-value');
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('shows the ingest URL once, loudly, and never again', async () => {
    // The token in it can write delivery events into this workspace, so
    // there is no endpoint that reads it back.
    mockApi(connectStubs());

    renderAt('/providers/connect');
    await fillSesAndSubmit();

    expect(await screen.findByText(INGEST)).toBeTruthy();
    expect(screen.getByText(/shown once/u)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: "I've stored it" }));

    await waitFor(() => expect(screen.queryByText(INGEST)).toBeNull());
    expect(screen.getByText(/Rotate the connection to mint a new URL/u)).toBeTruthy();
  });

  it('never sends the credentials anywhere but the connect call', async () => {
    mockApi(connectStubs());

    renderAt('/providers/connect');
    await fillSesAndSubmit();
    await screen.findByText(INGEST);

    const withSecret = calls.filter((call) => JSON.stringify(call.body ?? '').includes('a-secret-value'));
    expect(withSecret.length).toBe(1);
    expect(withSecret[0]?.method).toBe('POST');
    expect(withSecret[0]?.url.endsWith('/providers')).toBe(true);
  });

  it('shows the warnings verification returned', async () => {
    // A sandboxed SES account delivers only to verified addresses. Without
    // this the campaign reports success and arrives nowhere.
    mockApi(connectStubs(['This SES account is in the sandbox']));

    renderAt('/providers/connect');
    await fillSesAndSubmit();

    expect(await screen.findByText(/in the sandbox/u)).toBeTruthy();
  });

  it('shows a viewer the locked page instead of the wizard', async () => {
    mockApi(connectStubs(), VIEWER);

    renderAt('/providers/connect');

    expect(await screen.findByText(/This page needs the/u)).toBeTruthy();
    expect(screen.queryByText('Which provider will this connection use?')).toBeNull();
  });
});

describe('senders', () => {
  function sender(overrides: Record<string, unknown> = {}) {
    return {
      id: 'snd_hello',
      providerId: 'prv_ses_eu1',
      identityId: 'idn_ses_travel',
      fromEmail: 'hello@northwind.travel',
      fromName: 'Northwind Voyages',
      replyTo: 'support@northwind.travel',
      status: 'active',
      dailyLimit: null,
      hourlyLimit: null,
      healthScore: 98,
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastSendAt: '2026-09-20T05:10:00.000Z',
      ...overrides,
    };
  }

  function identity(overrides: Record<string, unknown> = {}) {
    return {
      id: 'idn_ses_travel',
      providerId: 'prv_ses_eu1',
      kind: 'domain',
      value: 'northwind.travel',
      verificationStatus: 'verified',
      dkimStatus: 'pass',
      spfStatus: 'pass',
      dmarcStatus: 'pass',
      verifiedAt: '2026-03-12T09:00:00.000Z',
      ...overrides,
    };
  }

  const DNS = {
    senderId: 'snd_members',
    problem: {
      title: 'DKIM record not found.',
      detail: 'Add it at your DNS host, then check again.',
    },
    records: [
      {
        kind: 'SPF',
        purpose: 'authorises the server to send',
        status: 'verified',
        type: 'TXT',
        host: 'northwind.travel',
        value: 'v=spf1 include:amazonses.com ~all',
        found: 'Record found and includes mail.northwind.travel',
      },
      {
        kind: 'DKIM',
        purpose: 'signs each message',
        status: 'pending',
        type: 'TXT',
        host: 'rl1._domainkey.northwind.travel',
        value: 'v=DKIM1; k=rsa; p=MIIBIjANBg…',
        found: 'Not found at rl1._domainkey.northwind.travel',
      },
    ],
    lastCheckedAt: '2026-09-20T05:40:00.000Z',
    nextCheckInMinutes: 11,
  };

  function stubs(
    senders: unknown[],
    identities: unknown[] = [identity()],
    connections: unknown[] = [connection()],
  ): Stub[] {
    return [
      { match: (url) => url.includes('/dns'), respond: () => ({ body: { data: DNS } }) },
      { match: (url) => url.includes('/identities'), respond: () => ({ body: { data: identities } }) },
      { match: (url) => url.includes('/senders'), respond: () => ({ body: { data: senders } }) },
      { match: (url) => isProviders(url), respond: () => ({ body: { data: connections } }) },
    ];
  }

  it('shows the quota as numbers, and says whose quota it is', async () => {
    // A slightly shorter bar is not actionable. The bucket belongs to the
    // connection, which is the single most common misreading of this screen.
    // Queries are scoped to the table because the page also renders the
    // 390px card list, which CSS hides and jsdom does not.
    mockApi(stubs([sender()]));

    renderAt('/senders');

    const table = within(await screen.findByRole('table'));
    expect(table.getByText('hello@northwind.travel')).toBeTruthy();
    expect(table.getByText('41,200 / 50,000')).toBeTruthy();
    await waitFor(() => expect(table.getByText('shared connection quota')).toBeTruthy());
    expect(
      screen.getAllByText(/Senders on the same connection share that connection's daily quota/u)
        .length,
    ).toBeGreaterThan(0);
  });

  it('shows the identity verification status and why it is not passing', async () => {
    // An identity can stop being verified without anyone touching Relayd —
    // a DNS record removed, a domain expired.
    mockApi(
      stubs(
        [sender({ id: 'snd_members', fromName: 'Northwind Miles' })],
        [identity({ verificationStatus: 'pending', dkimStatus: null })],
      ),
    );

    renderAt('/senders');

    const table = within(await screen.findByRole('table'));
    await waitFor(() => expect(table.getByText('Pending DNS')).toBeTruthy());
    expect(table.getByText('DKIM record missing')).toBeTruthy();
  });

  it('offers a test send only once the identity is verified', async () => {
    mockApi(stubs([sender()], [identity({ verificationStatus: 'failed' })]));

    renderAt('/senders');
    const table = within(await screen.findByRole('table'));

    await waitFor(() => {
      const test = table.getByRole('button', { name: 'Send test' });
      expect(test.hasAttribute('disabled')).toBe(true);
      expect(test.getAttribute('title')).toBe('Available once verified');
    });
  });

  it('draws the empty state E2e draws', async () => {
    mockApi(stubs([]));

    renderAt('/senders');

    expect(await screen.findByText('No senders yet')).toBeTruthy();
    expect(screen.getByText(/We generate the SPF, DKIM and DMARC records/u)).toBeTruthy();
  });

  it('gives the request id when the list fails to load', async () => {
    mockApi([
      { match: (url) => url.includes('/senders'), respond: () => ({
        status: 500,
        body: { error: { code: 'internal', message: 'boom', requestId: 'req_01J9E2FZ2M8T' } },
      }) },
      { match: (url) => isProviders(url), respond: () => ({ body: { data: [connection()] } }) },
    ]);

    renderAt('/senders');

    expect(await screen.findByText("We couldn't load senders")).toBeTruthy();
    expect(screen.getByText('req_01J9E2FZ2M8T')).toBeTruthy();
  });
});

describe('the DNS drawer', () => {
  const sender = {
    id: 'snd_members',
    providerId: 'prv_smtp_1',
    identityId: 'idn_smtp_travel',
    fromEmail: 'members@northwind.travel',
    fromName: 'Northwind Miles',
    replyTo: null,
    status: 'cooling_down',
    dailyLimit: null,
    hourlyLimit: null,
    healthScore: 74,
    consecutiveFailures: 3,
    cooldownUntil: '2026-09-21T00:00:00.000Z',
    lastSendAt: '2026-09-05T10:30:00.000Z',
  };

  const identity = {
    id: 'idn_smtp_travel',
    providerId: 'prv_smtp_1',
    kind: 'domain',
    value: 'northwind.travel',
    verificationStatus: 'pending',
    dkimStatus: null,
    spfStatus: 'pass',
    dmarcStatus: 'pass',
    verifiedAt: null,
  };

  const smtp = connection({
    id: 'prv_smtp_1',
    providerType: 'smtp',
    name: 'mail.northwind.travel',
    capabilities: { supportsWebhooks: false },
    hasWebhookSecret: false,
  });

  const dns = {
    senderId: 'snd_members',
    problem: {
      title: 'DKIM record not found.',
      detail:
        'Add it at your DNS host, then check again. Propagation can take up to 48 hours; we re-check every 15 minutes.',
    },
    records: [
      {
        kind: 'DKIM',
        purpose: 'signs each message',
        status: 'pending',
        type: 'TXT',
        host: 'rl1._domainkey.northwind.travel',
        value: 'v=DKIM1; k=rsa; p=MIIBIjANBg…',
        found: 'Not found at rl1._domainkey.northwind.travel',
      },
    ],
    lastCheckedAt: '2026-09-20T05:40:00.000Z',
    nextCheckInMinutes: 11,
  };

  function stubs(role = OWNER) {
    mockApi(
      [
        { match: (url) => url.includes('/dns'), respond: () => ({ body: { data: dns } }) },
        { match: (url) => url.includes('/identities'), respond: () => ({ body: { data: [identity] } }) },
        { match: (url) => url.includes('/senders'), respond: () => ({ body: { data: [sender] } }) },
        { match: (url) => isProviders(url), respond: () => ({ body: { data: [smtp] } }) },
      ],
      role,
    );
  }

  it('opens from the row and states the problem before the records', async () => {
    stubs();

    renderAt('/senders');
    const table = within(await screen.findByRole('table'));
    await userEvent.click(table.getByRole('button', { name: 'DNS' }));

    expect(await screen.findByText('DKIM record not found.')).toBeTruthy();
    expect(screen.getByText(/Propagation can take up to 48 hours/u)).toBeTruthy();
  });

  it('is a route, so the records survive a reload and can be sent on', async () => {
    stubs();

    renderAt('/senders/snd_members');

    expect(await screen.findByText('rl1._domainkey.northwind.travel')).toBeTruthy();
    expect(screen.getByText('Not found at rl1._domainkey.northwind.travel')).toBeTruthy();
  });

  it('gives every record its own copy button', async () => {
    // The customer pasting these is usually not the person reading this
    // screen, and a hand-retyped DKIM key never verifies.
    stubs();

    renderAt('/senders/snd_members');
    await screen.findByText('rl1._domainkey.northwind.travel');

    expect(screen.getByLabelText('Copy DKIM host')).toBeTruthy();
    expect(screen.getByLabelText('Copy DKIM value')).toBeTruthy();
  });

  it('re-checks on demand rather than only on the timer', async () => {
    stubs();

    renderAt('/senders/snd_members');
    await screen.findByText('rl1._domainkey.northwind.travel');
    calls.length = 0;

    await userEvent.click(screen.getByRole('button', { name: 'Check DNS now' }));

    await waitFor(() =>
      expect(
        calls.some((call) => call.method === 'POST' && call.url.includes('/senders/snd_members/dns/check')),
      ).toBe(true),
    );
  });

  it('says when a sender is cooling down, and until when', async () => {
    // A sender in cooldown is a campaign that will stall. E2a has no status
    // column, so the drawer is where this has to be said.
    stubs();

    renderAt('/senders/snd_members');

    expect(await screen.findByText('Cooling down')).toBeTruthy();
    expect(screen.getByText('until 21 Sep 2026')).toBeTruthy();
  });

  it('marks an SMTP sender best-effort in the drawer', async () => {
    // D4, at the moment someone is deciding whether to send from it.
    stubs();

    renderAt('/senders/snd_members');

    expect(await screen.findByText('Best-effort delivery feedback')).toBeTruthy();
  });

  it('will not offer a test send from an unverified identity', async () => {
    stubs();

    renderAt('/senders/snd_members');
    const test = await screen.findByRole('button', { name: 'Send test email' });

    expect(test.hasAttribute('disabled')).toBe(true);
    expect(test.getAttribute('title')).toBe('Available once verified');
  });

  it('hides remove from a viewer', async () => {
    stubs(VIEWER);

    renderAt('/senders/snd_members');
    await screen.findByText('rl1._domainkey.northwind.travel');

    expect(screen.queryByRole('button', { name: 'Remove sender' })).toBeNull();
    // The records themselves stay readable: a viewer is often the person
    // who administers the domain.
    expect(screen.getByText('Not found at rl1._domainkey.northwind.travel')).toBeTruthy();
  });
});
