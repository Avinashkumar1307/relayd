// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { configureApi } from '../src/api/client.js';
import { ApiSettingsPage } from '../src/routes/settings/api.js';

/**
 * The API and webhooks settings page.
 *
 * Its one job is to hand over a credential exactly once, in a way a person
 * cannot miss and cannot half-copy. The tests are mostly about that, and
 * about the two things a redesign would quietly remove: the reveal saying it
 * will not be shown again, and a revoked key staying in the list.
 */

const responses = new Map<string, unknown>();

const KEY = {
  id: 'key-1',
  name: 'CI deploy',
  keyPrefix: 'rk_live_a1b2c3d4',
  scopes: ['contact:read', 'campaign:write'],
  lastUsedAt: null,
  expiresAt: '2027-09-19T12:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-09-19T12:00:00.000Z',
};

const ENDPOINT = {
  id: 'ep-1',
  url: 'https://hooks.example.com/relayd',
  events: ['campaign.launched'],
  status: 'active' as const,
  description: null,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  disabledAt: null,
  disabledReason: null,
  secretRotatedAt: null,
  createdAt: '2026-09-19T12:00:00.000Z',
};

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();

  responses.set('GET /api-keys/scopes', { scopes: ['contact:read', 'campaign:write'] });
  responses.set('GET /webhook-endpoints/event-types', {
    eventTypes: ['campaign.launched', 'email.bounced'],
  });

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
          JSON.stringify({ error: { code: 'not_found', message: 'no stub', requestId: 'r' } }),
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

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/api']}>
        <Routes>
          <Route path="/settings/api" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the key list', () => {
  it('shows the prefix and never a whole key', async () => {
    responses.set('GET /api-keys', [KEY]);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    expect(await screen.findByText('CI deploy')).toBeTruthy();
    expect(screen.getByText(/rk_live_a1b2c3d4…/u)).toBeTruthy();
  });

  it('keeps a revoked key in the list, with the date', async () => {
    // The question after a leak is "was it revoked, and when". A list that
    // hides them answers with silence.
    responses.set('GET /api-keys', [{ ...KEY, revokedAt: '2026-09-18T00:00:00.000Z' }]);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    expect(await screen.findByText(/Revoked/u)).toBeTruthy();
  });

  it('offers no revoke button for an already revoked key', async () => {
    responses.set('GET /api-keys', [{ ...KEY, revokedAt: '2026-09-18T00:00:00.000Z' }]);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await screen.findByText(/Revoked/u);
    expect(screen.queryByText('Revoke')).toBe(null);
  });

  it('confirms before revoking', async () => {
    // One click away from breaking a production integration is one click too
    // few.
    responses.set('GET /api-keys', [KEY]);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Revoke'));

    expect(screen.getByText('Confirm')).toBeTruthy();
  });

  it('says so when there are none', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    expect(await screen.findByText('No API keys')).toBeTruthy();
  });
});

describe('creating a key', () => {
  it('offers only the scopes this person can grant', async () => {
    // Offering `billing:write` and letting the POST refuse it is a form the
    // user cannot complete and cannot see why.
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Create key'));

    expect(await screen.findByText('contact:read')).toBeTruthy();
    expect(screen.queryByText('billing:write')).toBe(null);
  });

  it('reveals the key once, and says it will not be shown again', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);
    responses.set('POST /api-keys', { ...KEY, keyShownOnce: 'rk_live_thesecretvalue' });

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Create key'));
    await userEvent.type(screen.getByPlaceholderText('CI deploy'), 'CI');
    await userEvent.click(screen.getByText('contact:read'));
    await userEvent.click(screen.getByText('Create'));

    expect(await screen.findByText('rk_live_thesecretvalue')).toBeTruthy();
    expect(screen.getByText(/cannot show it to you again/u)).toBeTruthy();
  });

  it('will not submit with neither a name nor a scope', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Create key'));

    expect((await screen.findByText('Create')).hasAttribute('disabled')).toBe(true);
  });

  it('will not submit without a name', async () => {
    // Checked on its own, because a test that leaves both empty passes even
    // if only one of the two conditions survives.
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Create key'));
    await userEvent.click(await screen.findByText('contact:read'));

    expect(screen.getByText('Create').hasAttribute('disabled')).toBe(true);
  });

  it('will not submit without a scope', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Create key'));
    await userEvent.type(await screen.findByPlaceholderText('CI deploy'), 'CI');

    expect(screen.getByText('Create').hasAttribute('disabled')).toBe(true);
  });
});

describe('webhook endpoints', () => {
  it('lists the URL and what it subscribes to', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [ENDPOINT]);

    wrap(<ApiSettingsPage />);

    expect(await screen.findByText('https://hooks.example.com/relayd')).toBeTruthy();
    expect(screen.getByText('campaign.launched')).toBeTruthy();
  });

  it('explains a disabled endpoint and how to recover it', async () => {
    // "Disabled" with no explanation is a support ticket. So is not saying
    // what happens to the events that were missed.
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [
      { ...ENDPOINT, status: 'disabled', disabledReason: 'Fifty consecutive failures' },
    ]);

    wrap(<ApiSettingsPage />);

    expect(await screen.findByText(/We stopped sending to this endpoint/u)).toBeTruthy();
    expect(screen.getByText(/Fifty consecutive failures/u)).toBeTruthy();
    expect(screen.getByText(/nothing that happened while it was disabled is resent/iu)).toBeTruthy();
  });

  it('warns about a failing endpoint without alarming', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [
      { ...ENDPOINT, status: 'failing', consecutiveFailures: 6 },
    ]);

    wrap(<ApiSettingsPage />);

    expect(await screen.findByText(/We are still trying/u)).toBeTruthy();
  });

  it('offers Resume rather than Pause for a disabled one', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [{ ...ENDPOINT, status: 'disabled' }]);

    wrap(<ApiSettingsPage />);

    expect(await screen.findByText('Resume')).toBeTruthy();
    expect(screen.queryByText('Pause')).toBe(null);
  });

  it('explains the rotation overlap', async () => {
    // The thing that makes rotation safe to do is the thing a customer needs
    // told, or they will rotate and redeploy in the wrong order.
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [
      { ...ENDPOINT, secretRotatedAt: '2026-09-19T12:00:00.000Z' },
    ]);

    wrap(<ApiSettingsPage />);

    expect(await screen.findByText(/previous secret keeps working for 24 hours/u)).toBeTruthy();
  });

  it('reveals a rotated secret once', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [ENDPOINT]);
    responses.set('POST /webhook-endpoints/ep-1/rotate-secret', {
      ...ENDPOINT,
      secretShownOnce: 'whsec_rotatedvalue',
    });

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Rotate secret'));

    expect(await screen.findByText('whsec_rotatedvalue')).toBeTruthy();
  });

  it('describes the signature scheme alongside the secret', async () => {
    // So an integrator can write the verifier without leaving the page.
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [ENDPOINT]);
    responses.set('POST /webhook-endpoints/ep-1/rotate-secret', {
      ...ENDPOINT,
      secretShownOnce: 'whsec_rotatedvalue',
    });

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Rotate secret'));

    expect(await screen.findByText(/Relayd-Signature/u)).toBeTruthy();
    expect(screen.getByText(/HMAC-SHA256/u)).toBeTruthy();
  });

  it('shows the response an endpoint actually returned', async () => {
    // "It failed" is not something an integrator can act on.
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [ENDPOINT]);
    responses.set('GET /webhook-endpoints/ep-1/deliveries', [
      {
        id: 1,
        eventType: 'campaign.launched',
        eventId: 'evt-1',
        attempt: 3,
        status: 'failed',
        responseCode: 502,
        responseBody: null,
        error: null,
        durationMs: 120,
        scheduledFor: '2026-09-19T12:00:00.000Z',
        deliveredAt: null,
        createdAt: '2026-09-19T12:00:00.000Z',
      },
    ]);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Recent deliveries'));

    expect(await screen.findByText('502')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('says so when nothing has been delivered', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', [ENDPOINT]);
    responses.set('GET /webhook-endpoints/ep-1/deliveries', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Recent deliveries'));

    expect(await screen.findByText(/Nothing delivered to this endpoint yet/u)).toBeTruthy();
  });
});

describe('adding an endpoint', () => {
  it('says the URL must be https and public', async () => {
    // Before the server refuses it, so the customer does not have to guess
    // from a 400.
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Add endpoint'));

    expect(
      await screen.findByText(/Must be https and reachable from the internet/u),
    ).toBeTruthy();
  });

  it('offers a wildcard that covers events added later', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Add endpoint'));

    expect(
      await screen.findByText(/Everything, including events we add later/u),
    ).toBeTruthy();
  });

  it('disables the individual types once the wildcard is chosen', async () => {
    // Otherwise the form lets somebody build a selection the server will
    // collapse, and the result contradicts what they picked.
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Add endpoint'));
    await userEvent.click(await screen.findByText(/Everything, including/u));

    await waitFor(() => {
      const checkbox = screen
        .getByText('campaign.launched')
        .closest('label')
        ?.querySelector('input');
      expect(checkbox?.disabled).toBe(true);
    });
  });

  it('surfaces the server message when the URL is refused', async () => {
    responses.set('GET /api-keys', []);
    responses.set('GET /webhook-endpoints', []);

    wrap(<ApiSettingsPage />);

    await userEvent.click(await screen.findByText('Add endpoint'));
    await userEvent.type(
      screen.getByPlaceholderText('https://example.com/hooks/relayd'),
      'https://10.0.0.1/x',
    );
    await userEvent.click(screen.getByText('campaign.launched'));
    await userEvent.click(screen.getByText('Add'));

    // The stub 404s an unmatched POST, so what is asserted is that the
    // server's message reaches the user rather than being swallowed.
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
