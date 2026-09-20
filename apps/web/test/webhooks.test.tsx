// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi } from '../src/api/client.js';
import type { WebhookDelivery, WebhookEndpoint } from '../src/api/platform.js';
import { WebhookDeliveriesPage, WebhooksPage } from '../src/routes/settings/webhooks.js';

/**
 * J4 — outbound webhooks.
 *
 * The rules being held to here are the ones that make the screens worth
 * having: "Auto-disabled" and "Disabled" stay apart because only one of them
 * is something to fix; the delivery log shows the code the customer's own
 * server returned rather than a tick; and an auto-disabled endpoint says
 * when it stopped, what is replayable and for how long, because that is the
 * whole recovery procedure.
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

const ACTIVE: WebhookEndpoint = {
  id: 'whk_01J7Q2',
  url: 'https://api.northwind.travel/relayd/events',
  description: 'Production CRM · delivery + engagement sync',
  events: ['delivered', 'hard_bounced', 'complained', 'unsubscribed', 'clicked'],
  status: 'active',
  consecutiveFailures: 0,
  successRate7d: 99.8,
  lastDeliveryAt: new Date(Date.now() - 120_000).toISOString(),
  lastSuccessAt: null,
  lastFailureAt: null,
  disabledAt: null,
  disabledReason: null,
  secretMasked: 'whsec_4a1f••••••••••••••••••••••',
  secretCreatedAt: '2026-06-02T12:00:00.000Z',
  secretRotatedAt: null,
  undeliveredCount: null,
  replayableUntil: null,
  lastResponse: null,
  createdAt: '2026-06-02T12:00:00.000Z',
};

const AUTO_DISABLED: WebhookEndpoint = {
  ...ACTIVE,
  id: 'whk_01J7Q8',
  url: 'https://crm-staging.northwind.travel/hooks',
  description: 'Staging CRM · all events',
  events: ['*'],
  status: 'disabled',
  consecutiveFailures: 50,
  successRate7d: 12.4,
  lastDeliveryAt: '2026-09-17T06:12:00.000Z',
  disabledAt: '2026-09-17T06:12:00.000Z',
  disabledReason: '50 consecutive failures',
  undeliveredCount: 1284,
  replayableUntil: '2026-09-24T06:12:00.000Z',
  lastResponse: 'HTTP/1.1 503 Service Unavailable\nretry-after: 120',
};

const PAUSED: WebhookEndpoint = {
  ...ACTIVE,
  id: 'whk_01J7QA',
  url: 'https://legacy.northwind.travel/wh',
  description: 'Old reporting job · disabled manually 2 Aug',
  events: ['delivered'],
  status: 'paused',
  successRate7d: null,
  lastDeliveryAt: '2026-08-02T12:00:00.000Z',
};

const FAILED_DELIVERY: WebhookDelivery = {
  id: 8,
  eventType: 'delivered',
  eventId: 'evt_01J8ZJ2K9QF3',
  attempt: 6,
  status: 'failed',
  responseCode: 503,
  responseBody: null,
  error: null,
  durationMs: 10_004,
  nextRetryLabel: 'Endpoint disabled',
  scheduledFor: '2026-09-17T06:12:04.000Z',
  deliveredAt: '2026-09-17T06:12:04.000Z',
  createdAt: '2026-09-17T06:12:04.000Z',
};

const TIMED_OUT: WebhookDelivery = {
  ...FAILED_DELIVERY,
  id: 5,
  eventType: 'hard_bounced',
  eventId: 'evt_01J8Z7QK1N0P',
  attempt: 3,
  responseCode: null,
  error: 'Timeout',
  durationMs: 10_000,
  nextRetryLabel: null,
};

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();
  readOnly = false;

  responses.set('GET /webhook-endpoints/event-types', {
    eventTypes: ['sent', 'delivered', 'clicked', 'campaign.completed'],
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).split('?')[0] ?? '';
      const method = init?.method ?? 'GET';

      const match = [...responses.entries()]
        .filter(([pattern]) => {
          const [patternMethod, patternPath] = pattern.split(' ');
          return method === patternMethod && url.includes(String(patternPath));
        })
        .sort((a, b) => b[0].length - a[0].length)[0];

      if (match === undefined) {
        return new Response(
          JSON.stringify({
            error: { code: 'not_found', message: 'no stub', requestId: 'req_01J9J4FK' },
          }),
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

/** The desktop table. Both list pages also render a mobile card list, so an
 *  unscoped getByText finds both. */
const table = (name: string): HTMLElement => screen.getByRole('table', { name });

function wrap(path = '/settings/webhooks') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/webhooks" element={<WebhooksPage />} />
          <Route path="/settings/webhooks/:id" element={<WebhooksPage />} />
          <Route path="/settings/webhooks/:id/deliveries" element={<WebhookDeliveriesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('J4a — the endpoint list', () => {
  it('lists the URL, the description and what it subscribes to', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    wrap();

    await screen.findAllByText('https://api.northwind.travel/relayd/events');
    const rows = table('Webhook endpoints');
    expect(within(rows).getByText('https://api.northwind.travel/relayd/events')).toBeTruthy();
    expect(within(rows).getByText('Production CRM · delivery + engagement sync')).toBeTruthy();
    expect(within(rows).getByText('hard_bounced')).toBeTruthy();
  });

  it('keeps "Auto-disabled" and "Disabled" apart', async () => {
    // One of the two is something to fix and one is something somebody
    // chose. A single grey badge for both hides which happened.
    responses.set('GET /webhook-endpoints', [AUTO_DISABLED, PAUSED]);
    wrap();

    await screen.findAllByText('Auto-disabled');
    const rows = table('Webhook endpoints');
    expect(within(rows).getByText('Auto-disabled')).toBeTruthy();
    expect(within(rows).getByText('Disabled')).toBeTruthy();
  });

  it('prints a failing success rate in danger and a healthy one plainly', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE, AUTO_DISABLED]);
    wrap();

    await screen.findAllByText(/12\.4%/u);
    const rows = table('Webhook endpoints');
    expect(within(rows).getByText('12.4%').className).toContain('text-danger-text');
    expect(within(rows).getByText('99.8%').className).not.toContain('text-danger-text');
  });

  it('prints a whole percentage without a decimal, and an em dash for none', async () => {
    responses.set('GET /webhook-endpoints', [{ ...ACTIVE, successRate7d: 100 }, PAUSED]);
    wrap();

    await screen.findAllByText(/100%/u);
    const rows = table('Webhook endpoints');
    expect(within(rows).getByText('100%')).toBeTruthy();
    expect(within(rows).getByText('—')).toBeTruthy();
  });

  it('raises a banner naming the host, the response and the replay window', async () => {
    // "An endpoint failed" is not something anyone can act on.
    responses.set('GET /webhook-endpoints', [ACTIVE, AUTO_DISABLED]);
    wrap();

    expect(await screen.findByText('1 endpoint was auto-disabled')).toBeTruthy();
    expect(
      screen.getByText(/crm-staging\.northwind\.travel, last response 503/u),
    ).toBeTruthy();
    expect(screen.getByText(/can be replayed for 7 days/u)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View delivery log' }).getAttribute('href')).toBe(
      '/settings/webhooks/whk_01J7Q8/deliveries',
    );
  });

  it('raises no banner when nothing is auto-disabled', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE, PAUSED]);
    wrap();

    await screen.findAllByText('https://api.northwind.travel/relayd/events');
    expect(screen.queryByText(/auto-disabled/u)).toBe(null);
  });

  it('offers a delivery log and an edit on every row', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    wrap();

    await screen.findAllByRole('link', {
      name: 'Delivery log for https://api.northwind.travel/relayd/events',
    });
    const rows = table('Webhook endpoints');
    expect(
      within(rows)
        .getByRole('link', { name: 'Delivery log for https://api.northwind.travel/relayd/events' })
        .getAttribute('href'),
    ).toBe('/settings/webhooks/whk_01J7Q2/deliveries');
    expect(
      within(rows)
        .getByRole('link', { name: 'Edit https://api.northwind.travel/relayd/events' })
        .getAttribute('href'),
    ).toBe('/settings/webhooks/whk_01J7Q2');
  });

  it('disables Add endpoint in a read-only workspace, and says why', async () => {
    readOnly = true;
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    wrap();

    // K2: the rows stay visible; only the writes go.
    expect((await screen.findAllByText('https://api.northwind.travel/relayd/events')).length).toBeGreaterThan(0);
    const add = screen.getByRole('button', { name: 'Add endpoint' });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(add.getAttribute('title')).toBe('Workspace is read-only');
  });
});

describe('J4e / J4f — nothing, and nothing loaded', () => {
  it('says what an endpoint is for', async () => {
    responses.set('GET /webhook-endpoints', []);
    wrap();

    expect(await screen.findByText('No endpoints yet')).toBeTruthy();
    expect(screen.getByText(/Add an HTTPS endpoint to receive signed events/u)).toBeTruthy();
  });

  it('says delivery is unaffected, and shows the request ID', async () => {
    wrap();

    expect(await screen.findByText("We couldn't load webhooks")).toBeTruthy();
    expect(screen.getByText(/Event delivery is unaffected/u)).toBeTruthy();
    expect(screen.getByText('req_01J9J4FK')).toBeTruthy();
  });
});

describe('J4b — the edit drawer', () => {
  it('opens over the list for the row in the URL', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE, PAUSED]);
    wrap('/settings/webhooks/whk_01J7Q2');

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Edit endpoint')).toBeTruthy();
    expect(within(drawer).getByText('whk_01J7Q2')).toBeTruthy();
    expect(
      (within(drawer).getByLabelText('Endpoint URL') as HTMLInputElement).value,
    ).toBe('https://api.northwind.travel/relayd/events');
  });

  it('states the contract the endpoint has to meet', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    wrap('/settings/webhooks/whk_01J7Q2');

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('HTTPS only. Respond 2xx within 10 seconds.')).toBeTruthy();
  });

  it('masks the signing secret and offers only to rotate it', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    wrap('/settings/webhooks/whk_01J7Q2');

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('whsec_4a1f••••••••••••••••••••••')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Rotate' })).toBeTruthy();
  });

  it('shows a rotated secret once and explains the 24-hour overlap', async () => {
    // The thing that makes rotation safe to do is the thing a customer needs
    // told, or they will rotate and redeploy in the wrong order.
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    responses.set('POST /webhook-endpoints/whk_01J7Q2/rotate-secret', {
      ...ACTIVE,
      secretShownOnce: 'whsec_rotatedvalue',
    });
    wrap('/settings/webhooks/whk_01J7Q2');

    await userEvent.click(await screen.findByRole('button', { name: 'Rotate' }));

    expect(await screen.findByText('whsec_rotatedvalue')).toBeTruthy();
    expect(screen.getByText(/keeps working for 24 hours/u)).toBeTruthy();
  });

  it('turning the endpoint off saves it as paused, not deleted', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    responses.set('PATCH /webhook-endpoints/whk_01J7Q2', { ...ACTIVE, status: 'paused' });
    wrap('/settings/webhooks/whk_01J7Q2');

    const drawer = await screen.findByRole('dialog');
    await userEvent.click(within(drawer).getByRole('switch'));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const patch = calls.find((call) => (call[1] as RequestInit).method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(String((patch?.[1] as RequestInit).body)).status).toBe('paused');
    });
  });

  it('says what deleting costs, and points at the softer option', async () => {
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    wrap('/settings/webhooks/whk_01J7Q2');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete endpoint' }));

    expect(await screen.findByText('Delete this endpoint?')).toBeTruthy();
    expect(screen.getByText(/Undelivered events are dropped, not held/u)).toBeTruthy();
    expect(screen.getByText(/turn the endpoint off instead/u)).toBeTruthy();
  });

  it('disables every write in the drawer when the workspace is read-only', async () => {
    readOnly = true;
    responses.set('GET /webhook-endpoints', [ACTIVE]);
    wrap('/settings/webhooks/whk_01J7Q2');

    const drawer = await screen.findByRole('dialog');
    for (const name of ['Save', 'Rotate', 'Send test event', 'Delete endpoint']) {
      expect(within(drawer).getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
  });
});

describe('J4c — the delivery log', () => {
  const stubLog = (endpoint: WebhookEndpoint, deliveries: WebhookDelivery[], total = 1334) => {
    responses.set('GET /webhook-endpoints', [endpoint]);
    responses.set(`GET /webhook-endpoints/${endpoint.id}/deliveries`, { deliveries, total });
  };

  it('shows the code the customer server returned, not a tick', async () => {
    stubLog(AUTO_DISABLED, [FAILED_DELIVERY, TIMED_OUT]);
    wrap('/settings/webhooks/whk_01J7Q8/deliveries');

    await screen.findAllByText('503');
    const log = table('Deliveries');
    expect(within(log).getAllByText('503').length).toBe(1);
    expect(within(log).getByText('Timeout')).toBeTruthy();
    expect(within(log).getByText('evt_01J8ZJ2K9QF3')).toBeTruthy();
    expect(within(log).getByText('10,004 ms')).toBeTruthy();
  });

  it('names when it was disabled, what is replayable and until when', async () => {
    stubLog(AUTO_DISABLED, [FAILED_DELIVERY]);
    wrap('/settings/webhooks/whk_01J7Q8/deliveries');

    expect(await screen.findByText(/Auto-disabled on 17 Sep 2026, 06:12/u)).toBeTruthy();
    expect(screen.getByText(/kept for 7 days \(until 24 Sep\)/u)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Re-enable and replay 1,284 events' }),
    ).toBeTruthy();
  });

  it('spells out the retry schedule and what ends it', async () => {
    stubLog(AUTO_DISABLED, [FAILED_DELIVERY]);
    wrap('/settings/webhooks/whk_01J7Q8/deliveries');

    expect(await screen.findByText('Retry schedule')).toBeTruthy();
    expect(screen.getByText('+24 h')).toBeTruthy();
    expect(
      screen.getByText(/50 consecutive failed events disable the endpoint\. Any 2xx resets/u),
    ).toBeTruthy();
  });

  it('shows the last response verbatim', async () => {
    stubLog(AUTO_DISABLED, [FAILED_DELIVERY]);
    wrap('/settings/webhooks/whk_01J7Q8/deliveries');

    expect(await screen.findByText('Last response')).toBeTruthy();
    expect(screen.getByText(/503 Service Unavailable/u)).toBeTruthy();
  });

  it('opens on the failures for an endpoint that is off, and the chip clears it', async () => {
    stubLog(AUTO_DISABLED, [FAILED_DELIVERY]);
    wrap('/settings/webhooks/whk_01J7Q8/deliveries');

    const clears = await screen.findAllByRole('button', { name: 'Clear the status filter' });
    const clear = clears[0] as HTMLElement;
    expect((clear.parentElement?.textContent ?? '').startsWith('Status Failed')).toBe(true);

    await userEvent.click(clear);

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.some((call) => String(call[0]).includes('status=failed'))).toBe(true);
      expect(
        calls.some(
          (call) => String(call[0]).includes('/deliveries') && !String(call[0]).includes('status='),
        ),
      ).toBe(true);
    });
  });

  it('counts the page against the total', async () => {
    stubLog(AUTO_DISABLED, [FAILED_DELIVERY, TIMED_OUT]);
    wrap('/settings/webhooks/whk_01J7Q8/deliveries');

    expect((await screen.findAllByText('Showing 1–2 of 1,334 deliveries')).length).toBeGreaterThan(0);
  });

  it('offers no re-enable for an endpoint that is running', async () => {
    stubLog(ACTIVE, [FAILED_DELIVERY]);
    wrap('/settings/webhooks/whk_01J7Q2/deliveries');

    await screen.findByText('Retry schedule');
    expect(screen.queryByText(/Re-enable/u)).toBe(null);
  });

  it('says so when nothing has been delivered yet', async () => {
    stubLog(ACTIVE, [], 0);
    wrap('/settings/webhooks/whk_01J7Q2/deliveries');

    expect((await screen.findAllByText('Nothing delivered yet')).length).toBeGreaterThan(0);
  });
});
