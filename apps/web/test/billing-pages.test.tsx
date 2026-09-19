// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { configureApi } from '../src/api/client.js';
import type { BillingOverview, UsageRow } from '../src/api/billing.js';
import {
  BillingPage,
  CancelSubscriptionPage,
  CheckoutSuccessPage,
  InvoicesPage,
  PlansPage,
  featureLabel,
  formatMoney,
} from '../src/routes/billing/billing.js';

/**
 * The billing pages.
 *
 * Three behaviours here are product decisions with consequences, and all three
 * are the kind a redesign quietly removes:
 *
 *   the success page polls rather than trusting the redirect, and says
 *   something useful when it gives up;
 *
 *   a downgrade is pre-checked and the blockers are listed before the confirm
 *   button is offered;
 *
 *   an unlimited feature gets a count and no progress bar.
 */

const responses = new Map<string, unknown>();

const OVERVIEW: BillingOverview = {
  subscription: {
    planCode: 'growth',
    planName: 'Growth',
    interval: 'month',
    status: 'active',
    currentPeriodStart: '2026-09-01T00:00:00.000Z',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    scheduledPlanCode: null,
    scheduledChangeAt: null,
    trialEnd: null,
  },
  state: {
    workspaceSuspended: false,
    subscriptionSuspended: false,
    pastDue: false,
    hasSubscription: true,
  },
  usage: [
    {
      featureKey: 'emails.sent',
      used: 40_000,
      included: 100_000,
      overage: 0,
      percentUsed: 40,
      periodEnd: '2026-10-01T00:00:00.000Z',
    },
  ],
  paymentMethod: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 },
};

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();

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

      const body = match[1];
      if (typeof body === 'object' && body !== null && '__error' in body) {
        const error = body as { __error: { status: number; body: unknown } };
        return new Response(JSON.stringify(error.__error.body), {
          status: error.__error.status,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ data: body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function wrap(children: ReactNode, path = '/billing') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/billing" element={children} />
          <Route path="/billing/plans" element={children} />
          <Route path="/billing/success" element={children} />
          <Route path="/billing/invoices" element={children} />
          <Route path="/billing/subscription/cancel" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the billing page', () => {
  it('shows the plan and the period', async () => {
    responses.set('GET /billing', OVERVIEW);

    wrap(<BillingPage />);

    expect(await screen.findByText('Growth')).toBeTruthy();
    expect(screen.getByText('Monthly')).toBeTruthy();
  });

  it('shows the card without showing a number', async () => {
    // We never see a PAN and must not look as though we do.
    responses.set('GET /billing', OVERVIEW);

    wrap(<BillingPage />);

    expect(await screen.findByText(/ending 4242/u)).toBeTruthy();
  });

  it('offers a plan when there is no subscription', async () => {
    responses.set('GET /billing', {
      ...OVERVIEW,
      subscription: null,
      state: { ...OVERVIEW.state, hasSubscription: false },
    });

    wrap(<BillingPage />);

    expect(await screen.findByText('No active subscription')).toBeTruthy();
  });

  it('says what a scheduled downgrade will do and when', async () => {
    responses.set('GET /billing', {
      ...OVERVIEW,
      subscription: {
        ...OVERVIEW.subscription,
        scheduledPlanCode: 'starter',
        scheduledChangeAt: '2026-10-01T00:00:00.000Z',
      },
    });

    wrap(<BillingPage />);

    expect(await screen.findByText(/Until then nothing changes/u)).toBeTruthy();
  });
});

describe('the dunning banner', () => {
  it('says what to do about a failed payment', async () => {
    // "Payment failed" and nothing else makes the customer go looking for the
    // page they are already on.
    responses.set('GET /billing', { ...OVERVIEW, state: { ...OVERVIEW.state, pastDue: true } });

    wrap(<BillingPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Everything still works for now/u)).toBeTruthy();
  });

  it('promises nothing is deleted when suspended', async () => {
    // It is the first thing a customer in this state wants to know.
    responses.set('GET /billing', {
      ...OVERVIEW,
      state: { ...OVERVIEW.state, subscriptionSuspended: true },
    });

    wrap(<BillingPage />);

    expect(await screen.findByText(/Nothing has been deleted/u)).toBeTruthy();
  });

  it('does not tell a suspended workspace to pay', async () => {
    // A workspace suspension is not fixed by money, and saying so saves a
    // failed payment and a support ticket.
    responses.set('GET /billing', {
      ...OVERVIEW,
      state: { ...OVERVIEW.state, workspaceSuspended: true },
    });

    wrap(<BillingPage />);

    expect(await screen.findByText(/not something a payment fixes/u)).toBeTruthy();
  });

  it('shows nothing when everything is fine', async () => {
    // A banner that appears when there is no problem teaches people to ignore
    // banners.
    responses.set('GET /billing', OVERVIEW);

    wrap(<BillingPage />);

    await screen.findByText('Growth');
    expect(screen.queryByRole('alert')).toBe(null);
  });
});

describe('the usage meters', () => {
  function withUsage(usage: UsageRow[]) {
    responses.set('GET /billing', { ...OVERVIEW, usage });
    wrap(<BillingPage />);
  }

  it('draws a bar against a limit', async () => {
    withUsage([
      {
        featureKey: 'emails.sent',
        used: 40_000,
        included: 100_000,
        overage: 0,
        percentUsed: 40,
        periodEnd: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
  });

  it('draws no bar for an unlimited feature', async () => {
    // A progress bar at 0% reads as "you have nothing" and one at 100% reads
    // as "you are out". Neither is true of unlimited.
    withUsage([
      {
        featureKey: 'emails.sent',
        used: 5_000_000,
        included: null,
        overage: 0,
        percentUsed: null,
        periodEnd: '2026-10-01T00:00:00.000Z',
      },
    ]);

    // Two things here. The count is split across two JSX children, so the
    // match is on the element's own text; and the grouping is whatever the
    // runtime locale does — this machine is en-IN, where five million is
    // "50,00,000" — so the expectation is built the same way the page builds
    // it rather than hardcoded.
    const expected = `${(5_000_000).toLocaleString()} used`;

    expect(
      await screen.findByText((_text, element) => element?.textContent === expected),
    ).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBe(null);
  });

  it('says nothing about overage when there is none', async () => {
    // "0 over your allowance" is a line that makes a customer look for a
    // charge that does not exist.
    withUsage([
      {
        featureKey: 'emails.sent',
        used: 40_000,
        included: 100_000,
        overage: 0,
        percentUsed: 40,
        periodEnd: '2026-10-01T00:00:00.000Z',
      },
    ]);

    await screen.findByRole('progressbar');
    expect(screen.queryByText(/over your allowance/u)).toBe(null);
  });

  it('shows overage as its own number', async () => {
    // How full is it and how much extra will I be billed are different
    // questions, and a single percentage answers neither.
    withUsage([
      {
        featureKey: 'emails.sent',
        used: 140_000,
        included: 100_000,
        overage: 40_000,
        percentUsed: 100,
        periodEnd: '2026-10-01T00:00:00.000Z',
      },
    ]);

    expect(
      await screen.findByText(
        new RegExp(`${(40_000).toLocaleString()} over your allowance`, 'u'),
      ),
    ).toBeTruthy();
  });
});

describe('the plans page', () => {
  const PLANS_RESPONSE = [
    {
      code: 'starter',
      name: 'Starter',
      description: 'For a first list.',
      rank: 10,
      trialDays: 14,
      limits: { 'emails.sent': 10_000, 'contacts.stored': 2_500 },
      flags: {},
    },
    {
      code: 'growth',
      name: 'Growth',
      description: 'For a team.',
      rank: 20,
      trialDays: 14,
      limits: { 'emails.sent': 100_000, 'contacts.stored': 25_000 },
      flags: {},
    },
  ];

  it('marks the plan already held', async () => {
    responses.set('GET /billing/plans', PLANS_RESPONSE);
    responses.set('GET /billing', OVERVIEW);

    wrap(<PlansPage />, '/billing/plans');

    expect(await screen.findByText('Current plan')).toBeTruthy();
  });

  it('renders unlimited rather than a number', async () => {
    responses.set('GET /billing/plans', [
      { ...PLANS_RESPONSE[1], limits: { 'emails.sent': null } },
    ]);
    responses.set('GET /billing', OVERVIEW);

    wrap(<PlansPage />, '/billing/plans');

    expect(await screen.findByText('Unlimited')).toBeTruthy();
  });

  it('lists what blocks a downgrade before offering the button', async () => {
    // "You cannot downgrade" with no explanation is a support ticket. The
    // customer usually can, once they know what to delete.
    responses.set('GET /billing/plans', PLANS_RESPONSE);
    responses.set('GET /billing', OVERVIEW);
    responses.set('GET /billing/plan-change/preview', {
      from: 'growth',
      to: 'starter',
      blocked: true,
      conflicts: [{ feature: 'contacts.stored', current: 48_210, targetLimit: 2_500 }],
    });

    wrap(<PlansPage />, '/billing/plans');

    await userEvent.click(await screen.findByText('Switch to Starter'));

    expect(
      await screen.findByText(new RegExp(`${(48_210).toLocaleString()} in use`, 'u')),
    ).toBeTruthy();
    expect(screen.getByText('Confirm').hasAttribute('disabled')).toBe(true);
  });

  it('enables the confirm button when nothing blocks', async () => {
    responses.set('GET /billing/plans', PLANS_RESPONSE);
    responses.set('GET /billing', OVERVIEW);
    responses.set('GET /billing/plan-change/preview', {
      from: 'growth',
      to: 'starter',
      blocked: false,
      conflicts: [],
    });

    wrap(<PlansPage />, '/billing/plans');

    await userEvent.click(await screen.findByText('Switch to Starter'));

    await waitFor(() => {
      expect(screen.getByText('Confirm').hasAttribute('disabled')).toBe(false);
    });
  });
});

describe('the success page', () => {
  it('says the payment went through while it waits', async () => {
    // The customer has just been charged. A bare spinner is the worst
    // available thing to show them.
    responses.set('GET /billing/checkout/status', { ready: false, action: 'fallback' });

    wrap(<CheckoutSuccessPage />, '/billing/success?session_id=cs_1');

    expect(await screen.findByText(/your payment has gone through/u)).toBeTruthy();
  });

  it('confirms once the subscription row exists', async () => {
    responses.set('GET /billing/checkout/status', {
      ready: true,
      planCode: 'growth',
      action: 'done',
    });

    wrap(<CheckoutSuccessPage />, '/billing/success?session_id=cs_1');

    expect(await screen.findByText('You are all set')).toBeTruthy();
  });

  it('gives up with a reference rather than spinning forever', async () => {
    responses.set('GET /billing/checkout/status', { ready: false, action: 'give_up' });

    wrap(<CheckoutSuccessPage />, '/billing/success?session_id=cs_1');

    expect(await screen.findByText(/Your payment succeeded/u)).toBeTruthy();
    expect(screen.getByText('cs_1')).toBeTruthy();
  });

  it('promises no double charge when it gives up', async () => {
    responses.set('GET /billing/checkout/status', { ready: false, action: 'give_up' });

    wrap(<CheckoutSuccessPage />, '/billing/success?session_id=cs_1');

    expect(await screen.findByText(/will not be charged twice/u)).toBeTruthy();
  });
});

describe('invoices', () => {
  it('lists them with a link to the provider copy', async () => {
    responses.set('GET /billing/invoices', [
      {
        id: 'in_1',
        number: 'RLY-0001',
        status: 'paid',
        currency: 'usd',
        total: 4900,
        amountDue: 0,
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        paidAt: '2026-09-01T00:00:00.000Z',
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/1',
        pdfUrl: null,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    wrap(<InvoicesPage />, '/billing/invoices');

    expect(await screen.findByText('RLY-0001')).toBeTruthy();
    expect(screen.getByText('View').getAttribute('href')).toContain('invoice.stripe.com');
  });

  it('opens the provider copy in a new tab, safely', async () => {
    // `noopener` matters: without it the opened page can navigate ours.
    responses.set('GET /billing/invoices', [
      {
        id: 'in_1',
        number: null,
        status: 'open',
        currency: 'usd',
        total: 4900,
        amountDue: 4900,
        periodStart: null,
        periodEnd: null,
        paidAt: null,
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/1',
        pdfUrl: null,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    wrap(<InvoicesPage />, '/billing/invoices');

    const link = await screen.findByText('View');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('says so when there are none', async () => {
    responses.set('GET /billing/invoices', []);

    wrap(<InvoicesPage />, '/billing/invoices');

    expect(await screen.findByText('No invoices yet')).toBeTruthy();
  });
});

describe('cancelling', () => {
  it('defaults to the end of the period', async () => {
    responses.set('GET /billing', OVERVIEW);

    wrap(<CancelSubscriptionPage />, '/billing/subscription/cancel');

    const atPeriodEnd = (await screen.findAllByRole('radio'))[0] as HTMLInputElement;
    expect(atPeriodEnd.checked).toBe(true);
  });

  it('says what immediate cancellation costs', async () => {
    // It ends a paid period early with no refund. That is a thing to decide,
    // not to discover.
    responses.set('GET /billing', OVERVIEW);

    wrap(<CancelSubscriptionPage />, '/billing/subscription/cancel');

    expect(await screen.findByText(/is not refunded/u)).toBeTruthy();
  });

  it('offers a way out', async () => {
    responses.set('GET /billing', OVERVIEW);

    wrap(<CancelSubscriptionPage />, '/billing/subscription/cancel');

    expect(await screen.findByText('Keep my plan')).toBeTruthy();
  });
});

describe('formatting', () => {
  it('renders minor units as money', () => {
    // Stripe gives cents. Nobody reads cents.
    expect(formatMoney(4900, 'usd')).toContain('49');
  });

  it('renders an unrecognised but well-formed code as itself', () => {
    // Intl accepts any three letters. ZZZ is not a real currency and is not
    // an error either.
    expect(formatMoney(4900, 'zzz')).toContain('49');
  });

  it('does not crash on a malformed currency code', () => {
    // Intl throws a RangeError for anything that is not three letters. A
    // truncated or empty code from a misconfigured Stripe account must not
    // take the billing page down with it.
    for (const bad of ['', 'z', 'us dollars']) {
      expect(formatMoney(4900, bad)).toContain('49.00');
    }
  });

  it('labels a feature the way a person says it', () => {
    expect(featureLabel('emails.sent')).toBe('Emails sent');
  });

  it('falls back to the key rather than to nothing', () => {
    // An unlabelled meter is worse than one labelled `campaigns.future_thing`,
    // and the fallback is how a feature added to the catalogue and not here
    // gets noticed.
    expect(featureLabel('campaigns.future_thing')).toBe('campaigns.future_thing');
  });
});
