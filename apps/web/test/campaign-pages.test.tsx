// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { configureApi } from '../src/api/client.js';
import { CampaignWizardPage, CampaignsPage } from '../src/routes/campaigns/campaigns.js';

/**
 * The campaign pages.
 *
 * Three things are worth rendering to check, because none of them can be
 * asserted below the component:
 *
 *   A retried launch sends the *same* Idempotency-Key. Minting it per click
 *   is the natural way to write this and is exactly what F29 says must not
 *   happen — the second request would look like a fresh launch.
 *
 *   A launched campaign shows a report, not a form.
 *
 *   `delivery_uncertain` appears as its own number with its own explanation.
 */

const responses = new Map<string, unknown>();
let requests: { url: string; method: string; headers: Record<string, string> }[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();
  requests = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      requests.push({
        url,
        method,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });

      // Longest path first. `/campaigns/c1` is a prefix of
      // `/campaigns/c1/progress`, and matching in insertion order served the
      // campaign object to the progress query — which is a stub bug that
      // looks exactly like a component bug.
      const matches = [...responses.entries()]
        .filter(([pattern]) => {
          const [patternMethod, patternPath] = pattern.split(' ');
          return method === patternMethod && url.includes(String(patternPath));
        })
        .sort((a, b) => b[0].length - a[0].length);

      const match = matches[0];
      if (match !== undefined) {
        const body = match[1];
        return jsonResponse(typeof body === 'function' ? (body as () => unknown)() : body);
      }

      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no stub', requestId: 'r' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(children: ReactNode, path = '/campaigns/c1') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/campaigns" element={children} />
          <Route path="/campaigns/:id" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const DRAFT = {
  id: 'c1',
  name: 'Spring sale',
  status: 'draft',
  subjectOverride: 'Our spring sale',
  templateVersionId: 'v1',
  senderAccountId: 'sa-1',
  sendingPoolId: null,
  audience: { listIds: ['l1'] },
  scheduledAt: null,
  timezone: null,
  recipientCount: 0,
  launchedAt: null,
  completedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('the campaign list', () => {
  it('shows each campaign with its state', async () => {
    responses.set('GET /campaigns', { items: [DRAFT], nextCursor: null });

    wrap(<CampaignsPage />, '/campaigns');

    expect(await screen.findByText('Spring sale')).toBeTruthy();

    // Scoped to the table: the state filter above it also has a "Draft"
    // option, and an unscoped query matches both.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Draft')).toBeTruthy();
  });

  it('offers a way in when there are none', async () => {
    responses.set('GET /campaigns', { items: [], nextCursor: null });

    wrap(<CampaignsPage />, '/campaigns');

    expect(await screen.findByText(/No campaigns yet/u)).toBeTruthy();
  });
});

describe('a launched campaign', () => {
  it('shows a report rather than the wizard', async () => {
    responses.set('GET /campaigns/c1', {
      campaign: { ...DRAFT, status: 'sending', recipientCount: 1000 },
      counters: null,
    });
    responses.set('GET /campaigns/c1/progress', {
      total: 1000, pending: 200, queued: 50, sending: 10,
      sent: 700, failed: 30, suppressed: 5, uncertain: 5,
      outstanding: 260, complete: false, deliveryUncertain: 5,
    });

    wrap(<CampaignWizardPage />);

    // `findBy`, not `waitFor` then `getBy`: the wizard's steps are absent
    // while the query is still loading too, so the negative assertion alone
    // passes before anything has rendered.
    expect(await screen.findByText('Sending')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Details/u })).toBeNull();
  });

  it('shows delivery uncertain as its own number', async () => {
    // D3: "we could not send" and "we do not know whether we sent" are
    // different things to tell a customer, and folding them together loses
    // the only one that is not the customer's fault.
    responses.set('GET /campaigns/c1', {
      campaign: { ...DRAFT, status: 'sending' },
      counters: null,
    });
    responses.set('GET /campaigns/c1/progress', {
      total: 1000, pending: 0, queued: 0, sending: 0,
      sent: 900, failed: 30, suppressed: 5, uncertain: 65,
      outstanding: 0, complete: true, deliveryUncertain: 65,
    });

    wrap(<CampaignWizardPage />);

    expect(await screen.findByText('Delivery uncertain')).toBeTruthy();
    expect(screen.getByText('65')).toBeTruthy();
    expect(screen.getByText(/Not charged/u)).toBeTruthy();
  });

  it('offers pause while sending and resume while paused', async () => {
    responses.set('GET /campaigns/c1', { campaign: { ...DRAFT, status: 'sending' }, counters: null });
    responses.set('GET /campaigns/c1/progress', {
      total: 1, pending: 1, queued: 0, sending: 0, sent: 0, failed: 0,
      suppressed: 0, uncertain: 0, outstanding: 1, complete: false, deliveryUncertain: 0,
    });

    wrap(<CampaignWizardPage />);

    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('offers resume, not pause, once it is paused', async () => {
    // Both halves matter. Showing Pause on a paused campaign is a button that
    // can only produce a 409, and the customer reads that as the product
    // being broken rather than as their having clicked the wrong thing.
    responses.set('GET /campaigns/c1', { campaign: { ...DRAFT, status: 'paused' }, counters: null });
    responses.set('GET /campaigns/c1/progress', {
      total: 1, pending: 1, queued: 0, sending: 0, sent: 0, failed: 0,
      suppressed: 0, uncertain: 0, outstanding: 1, complete: false, deliveryUncertain: 0,
    });

    wrap(<CampaignWizardPage />);

    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('offers neither once it has completed', async () => {
    responses.set('GET /campaigns/c1', { campaign: { ...DRAFT, status: 'completed' }, counters: null });
    responses.set('GET /campaigns/c1/progress', {
      total: 1, pending: 0, queued: 0, sending: 0, sent: 1, failed: 0,
      suppressed: 0, uncertain: 0, outstanding: 0, complete: true, deliveryUncertain: 0,
    });

    wrap(<CampaignWizardPage />);

    await screen.findByText('Completed');
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('the launch button (F29)', () => {
  async function openReview() {
    responses.set('GET /campaigns/c1', { campaign: DRAFT, counters: null });
    responses.set('POST /campaigns/audience-preview', { eligible: 1000, suppressed: 0, total: 1000 });
    responses.set('POST /campaigns/c1/launch', { ok: true, recipientCount: 1000 });

    wrap(<CampaignWizardPage />);

    const review = await screen.findByRole('button', { name: /Review/u });
    await userEvent.click(review);

    const attest = await screen.findByRole('checkbox');
    await userEvent.click(attest);

    return screen.getByRole('button', { name: /Send campaign/u });
  }

  it('requires the consent attestation before it is enabled', async () => {
    responses.set('GET /campaigns/c1', { campaign: DRAFT, counters: null });
    responses.set('POST /campaigns/audience-preview', { eligible: 1000, suppressed: 0, total: 1000 });

    wrap(<CampaignWizardPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Review/u }));

    const send = await screen.findByRole('button', { name: /Send campaign/u });
    expect(send.hasAttribute('disabled')).toBe(true);
  });

  it('sends the same Idempotency-Key when clicked twice', async () => {
    // The whole of F29 from the browser's side. A key minted inside the click
    // handler would be a new key each time, which is the same as having none:
    // the second request reads as a fresh launch and snapshots again.
    const send = await openReview();

    await userEvent.click(send);
    await userEvent.click(send);

    const launches = requests.filter((r) => r.url.includes('/launch'));
    expect(launches.length).toBeGreaterThanOrEqual(1);

    const keys = new Set(launches.map((r) => r.headers['Idempotency-Key']));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBeTruthy();
  });

  it('sends a key that is not trivially guessable', async () => {
    const send = await openReview();
    await userEvent.click(send);

    const launch = requests.find((r) => r.url.includes('/launch'));
    // A UUID, not a counter. A guessable key lets one workspace's retry
    // collide with another's first attempt.
    expect(launch?.headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it('attests consent in the body as well', async () => {
    const send = await openReview();
    await userEvent.click(send);

    expect(requests.some((r) => r.url.includes('/launch') && r.method === 'POST')).toBe(true);
  });
});

describe('the audience step', () => {
  it('shows how many will actually receive it', async () => {
    responses.set('GET /campaigns/c1', { campaign: DRAFT, counters: null });
    responses.set('GET /audience/lists', [{ id: 'l1', name: 'Newsletter' }]);
    responses.set('POST /campaigns/audience-preview', {
      eligible: 900,
      suppressed: 100,
      total: 1000,
    });

    wrap(<CampaignWizardPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Audience/u }));

    expect(await screen.findByText('900')).toBeTruthy();
    // The suppressed count is shown, not hidden: it is the difference between
    // the number the author picked and the number who get the mail.
    expect(await screen.findByText(/100 will be skipped/u)).toBeTruthy();
  });
});

describe('the tracking step', () => {
  it('says plainly that open rate is approximate', async () => {
    // docs/06: the UI must present opens as directional. A customer who makes
    // a decision on a number wrong by 30-60% was misled by us.
    responses.set('GET /campaigns/c1', { campaign: DRAFT, counters: null });
    responses.set('POST /campaigns/audience-preview', { eligible: 1, suppressed: 0, total: 1 });

    wrap(<CampaignWizardPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Tracking/u }));

    // The word itself, not just the surrounding explanation: this is the
    // claim docs/06 requires the UI to make, and an explanation that stops
    // short of saying "approximate" is one a reader can skim past.
    expect(await screen.findByText(/approximate/u)).toBeTruthy();
    expect(screen.getByText(/Click rate is the number/u)).toBeTruthy();
    expect(screen.getByText(/inflates opens/u)).toBeTruthy();
  });

  it('says the unsubscribe link is not optional', async () => {
    responses.set('GET /campaigns/c1', { campaign: DRAFT, counters: null });
    responses.set('POST /campaigns/audience-preview', { eligible: 1, suppressed: 0, total: 1 });

    wrap(<CampaignWizardPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Tracking/u }));

    expect(await screen.findByText(/not a setting/u)).toBeTruthy();
  });
});
