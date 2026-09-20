// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Permission } from '@relayd/types';
import { configureApi } from '../src/api/client.js';
import type { BillingOverview, PlanSummary, UsageRow } from '../src/api/billing.js';
import { BillingPage } from '../src/routes/billing/overview.js';
import { PlansPage } from '../src/routes/billing/plans.js';
import { InvoicesPage } from '../src/routes/billing/invoices.js';
import { PaymentMethodPage } from '../src/routes/billing/payment-method.js';
import { CancelSubscriptionPage } from '../src/routes/billing/cancel-subscription.js';
import { CheckoutCancelledPage, CheckoutSuccessPage } from '../src/routes/billing/checkout.js';
import { billingRoutes } from '../src/routes/billing/routes.js';
import {
  featureLabel,
  formatMoney,
  formatPeriod,
  formatRetrySchedule,
} from '../src/routes/billing/parts.js';

/**
 * Section I — billing.
 *
 * The things asserted here are the ones a redesign quietly removes, and each
 * of them is a rule from CLAUDE.md or from the frames:
 *
 *   the success page never claims a subscription it has not seen (section 10);
 *   `billing:write` is owner-only, so an admin sees the page and cannot move
 *   money, with the reason in the tooltip (section 11);
 *   a downgrade is pre-checked and its blockers are listed with a way to fix
 *   each one (I3);
 *   unlimited gets a count and no bar, because a bar at 0% reads as "you have
 *   nothing" and one at 100% reads as "you are out";
 *   the old /billing/subscription/cancel path still lands somewhere.
 */

const responses = new Map<string, unknown>();

/** Who the page thinks is signed in. Swapped per test. */
let role: { can: Permission[]; workspace: string } = {
  can: ['billing:read', 'billing:write'],
  workspace: 'Northwind Voyages',
};

vi.mock('../src/auth/AuthProvider.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    memberships: [],
    currentWorkspaceId: 'ws_1',
    user: { id: 'u_1', name: 'Dana Haddad', email: 'dana@northwind.travel' },
    current: { workspaceId: 'ws_1', workspaceName: role.workspace, workspaceSlug: 'nv', role: 'owner' },
    permissions: role.can,
    can: (permission: Permission) => role.can.includes(permission),
  }),
}));

const PLANS: PlanSummary[] = [
  {
    code: 'starter',
    name: 'Starter',
    rank: 10,
    trialDays: 14,
    price: { month: 4900, year: 4083, currency: 'usd' },
    overagePer1000: 150,
    limits: { 'emails.sent': 25_000, 'contacts.stored': 10_000, 'workspace.seats': 3 },
    flags: { 'campaigns.sending_pools': false, 'api.access': false },
    comparison: { 'providers.connections': '1', support: 'Email' },
  },
  {
    code: 'growth',
    name: 'Growth',
    rank: 20,
    trialDays: 14,
    price: { month: 24_900, year: 20_750, currency: 'usd' },
    overagePer1000: 120,
    limits: {
      'emails.sent': 250_000,
      'contacts.stored': 100_000,
      'workspace.seats': 10,
      'analytics.retention_days': 396,
    },
    flags: { 'campaigns.sending_pools': true, 'api.access': true },
    comparison: { 'providers.connections': 'Unlimited', support: 'Priority' },
  },
  {
    code: 'scale',
    name: 'Scale',
    rank: 30,
    trialDays: 0,
    price: { month: 74_900, year: 62_417, currency: 'usd' },
    overagePer1000: 90,
    limits: { 'emails.sent': 1_000_000, 'contacts.stored': 500_000, 'workspace.seats': null },
    flags: { 'campaigns.sending_pools': true, 'api.access': true },
    comparison: { 'providers.connections': 'Unlimited', support: 'Named contact' },
  },
];

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
  state: { workspaceSuspended: false, subscriptionSuspended: false, pastDue: false, hasSubscription: true },
  usage: [
    {
      featureKey: 'emails.sent',
      used: 184_320,
      included: 250_000,
      overage: 0,
      periodEnd: '2026-10-01T00:00:00.000Z',
    },
  ],
  paymentMethod: {
    brand: 'visa',
    last4: '4242',
    expMonth: 8,
    expYear: 2028,
    isDefault: true,
    holder: 'Dana Haddad',
    addedAt: '2026-04-14T00:00:00.000Z',
    declinedOn: [],
  },
  nextInvoice: {
    at: '2026-10-01T00:00:00.000Z',
    total: 24_900,
    currency: 'usd',
    planAmount: 24_900,
    overageAmount: 0,
    includedEmails: 250_000,
    overagePer1000: 120,
  },
  billingDetails: {
    email: 'billing@northwind.travel',
    company: 'Northwind Voyages LLC',
    address: 'Office 1204, Marina Plaza, Dubai',
    taxId: 'AE100 2345 6789 0',
  },
  dunning: null,
  deliveryUncertain: 412,
};

const INVOICE = {
  id: 'in_0912',
  number: 'INV-2026-0912',
  status: 'paid',
  currency: 'usd',
  total: 24_900,
  amountDue: 0,
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  paidAt: '2026-09-01T00:00:00.000Z',
  hostedInvoiceUrl: 'https://invoice.stripe.com/i/1',
  pdfUrl: 'https://invoice.stripe.com/i/1.pdf',
  createdAt: '2026-09-01T00:00:00.000Z',
  periodLabel: 'Sep 2026 · Growth',
  paymentLabel: 'Visa •••• 4242',
};

const sent: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();
  sent.length = 0;
  role = { can: ['billing:read', 'billing:write'], workspace: 'Northwind Voyages' };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      sent.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });

      // Longest matching pattern wins, so "/billing/plan-change/preview" is
      // not answered by the stub for "/billing".
      const match = [...responses.entries()]
        .filter(([pattern]) => {
          const [patternMethod, patternPath] = pattern.split(' ');
          return method === patternMethod && url.includes(String(patternPath));
        })
        .sort((a, b) => b[0].length - a[0].length)[0];

      if (match === undefined) {
        return new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'no stub', requestId: 'req_stub' } }),
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
          <Route path="/billing/cancel" element={children} />
          <Route path="/billing/invoices" element={children} />
          <Route path="/billing/payment-method" element={children} />
          <Route path="/billing/cancel-subscription" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function standardStubs() {
  responses.set('GET /billing/plans', PLANS);
  responses.set('GET /billing/invoices', [INVOICE]);
  responses.set('GET /billing', OVERVIEW);
}

describe('the billing overview (I1a)', () => {
  it('names the plan, the price and what it includes', async () => {
    standardStubs();
    wrap(<BillingPage />);

    expect(await screen.findByText('Growth')).toBeTruthy();
    expect(screen.getByText('$249 / month')).toBeTruthy();
    expect(screen.getByText(/250,000 emails, 100,000 contacts, 10 seats/u)).toBeTruthy();
  });

  it('shows the card without ever showing a number', async () => {
    // We never see a PAN and must not look as though we do.
    standardStubs();
    wrap(<BillingPage />);

    expect(await screen.findByText(/4242/u)).toBeTruthy();
    expect(screen.getByText('Expires 08/2028 · default')).toBeTruthy();
  });

  it('estimates the next invoice and names the overage rate', async () => {
    standardStubs();
    wrap(<BillingPage />);

    expect(await screen.findByText('If you pass 250,000 emails')).toBeTruthy();
    expect(screen.getAllByText('$249.00').length).toBeGreaterThan(0);
    expect(screen.getByText('$1.20 per 1,000 extra')).toBeTruthy();
  });

  it('says delivery-uncertain sends were not counted', async () => {
    // D3: a crash after the provider accepted leaves the recipient unbilled.
    // A customer counting their own sends would otherwise find them missing.
    standardStubs();
    wrap(<BillingPage />);

    expect(
      await screen.findByText(/412 delivery-uncertain sends this period are not counted/u),
    ).toBeTruthy();
  });

  it('offers a plan when there is no subscription', async () => {
    standardStubs();
    responses.set('GET /billing', {
      ...OVERVIEW,
      subscription: null,
      nextInvoice: null,
      state: { ...OVERVIEW.state, hasSubscription: false },
    });

    wrap(<BillingPage />);

    expect(await screen.findByText('Choose a plan')).toBeTruthy();
  });

  it('says what a scheduled downgrade will do and when', async () => {
    standardStubs();
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

describe('the dunning card (I1b)', () => {
  const PAST_DUE: BillingOverview = {
    ...OVERVIEW,
    state: { ...OVERVIEW.state, pastDue: true },
    paymentMethod: { ...OVERVIEW.paymentMethod, declinedOn: ['2026-09-15', '2026-09-17'] } as never,
    dunning: {
      invoiceNumber: 'INV-2026-0912',
      amount: 24_900,
      currency: 'usd',
      daysPastDue: 4,
      declinedOn: ['2026-09-15', '2026-09-17'],
      retryOn: ['2026-09-19', '2026-09-22', '2026-09-26'],
      sendingBlockedAt: '2026-09-29',
    },
  };

  it('names the invoice, the retries and the date sending stops', async () => {
    // "Payment failed" and nothing else makes the customer go looking for the
    // page they are already on.
    standardStubs();
    responses.set('GET /billing', PAST_DUE);

    wrap(<BillingPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('INV-2026-0912');
    expect(alert.textContent).toContain('4 days past due');
    expect(alert.textContent).toContain('19, 22 and 26 Sep');
    expect(alert.textContent).toContain('29 Sep');
    expect(alert.textContent).toContain('Nothing is deleted');
  });

  it('marks the card as declined rather than as expiring', async () => {
    standardStubs();
    responses.set('GET /billing', PAST_DUE);

    wrap(<BillingPage />);

    expect(await screen.findByText('Declined 15 Sep and 17 Sep')).toBeTruthy();
  });

  it('does not tell a suspended workspace to pay', async () => {
    // A workspace suspension is not fixed by money, and saying so saves a
    // failed payment and a support ticket.
    standardStubs();
    responses.set('GET /billing', {
      ...OVERVIEW,
      state: { ...OVERVIEW.state, workspaceSuspended: true },
    });

    wrap(<BillingPage />);

    expect(await screen.findByText(/not something a payment fixes/u)).toBeTruthy();
    expect(screen.queryByText('Retry now')).toBe(null);
  });

  it('shows nothing when everything is fine', async () => {
    // A banner that appears when there is no problem teaches people to
    // ignore banners.
    standardStubs();
    wrap(<BillingPage />);

    await screen.findByText('Growth');
    expect(screen.queryByRole('alert')).toBe(null);
  });
});

describe('billing:write is owner-only', () => {
  it('disables the money controls for an admin and says why', async () => {
    // CLAUDE.md section 11: billing:write is the owner's alone. docs/09: a
    // missing permission disables the action and says why.
    role = { can: ['billing:read'], workspace: 'Northwind Voyages' };
    standardStubs();

    wrap(<BillingPage />);

    const cancel = await screen.findByText('Cancel subscription');
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    expect(cancel.getAttribute('title')).toBe('Only the workspace owner can change billing');
  });

  it('still shows the admin what the workspace is paying', async () => {
    role = { can: ['billing:read'], workspace: 'Northwind Voyages' };
    standardStubs();

    wrap(<BillingPage />);

    expect(await screen.findByText('Growth')).toBeTruthy();
    expect(screen.getAllByText('$249.00').length).toBeGreaterThan(0);
  });

  it('disables the plan buttons for an admin', async () => {
    role = { can: ['billing:read'], workspace: 'Northwind Voyages' };
    standardStubs();
    responses.set('GET /billing/plan-change/preview', { from: 'growth', to: 'scale', blocked: false, conflicts: [] });

    wrap(<PlansPage />, '/billing/plans');

    const upgrade = await screen.findByRole('button', { name: /Upgrade now/u });
    expect(upgrade.hasAttribute('disabled')).toBe(true);
    expect(upgrade.getAttribute('title')).toBe('Only the workspace owner can change billing');
  });
});

describe('the usage meters', () => {
  function withUsage(usage: UsageRow[]) {
    standardStubs();
    responses.set('GET /billing', { ...OVERVIEW, usage });
    wrap(<BillingPage />);
  }

  it('draws a bar against a limit', async () => {
    withUsage([
      {
        featureKey: 'emails.sent',
        used: 125_000,
        included: 250_000,
        overage: 0,
        periodEnd: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('50% used')).toBeTruthy();
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
        periodEnd: '2026-10-01T00:00:00.000Z',
      },
    ]);

    expect(await screen.findByText('Unlimited')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBe(null);
  });
});

describe('the plans page (I2)', () => {
  beforeEach(() => {
    standardStubs();
    responses.set('GET /billing/plan-change/preview', {
      from: 'growth',
      to: 'scale',
      blocked: false,
      conflicts: [],
      effectiveAt: '2026-10-01T00:00:00.000Z',
      proration: { dueToday: 18_333, currency: 'usd', periodLabel: '20–30 Sep' },
    });
  });

  it('marks the plan already held and does not offer to buy it again', async () => {
    wrap(<PlansPage />, '/billing/plans');

    const current = await screen.findByRole('button', { name: 'Current plan' });
    expect(current.hasAttribute('disabled')).toBe(true);
  });

  it('labels a higher plan an upgrade and a lower one a scheduled downgrade', async () => {
    // Rank decides, never the price and never the code: a promotion that
    // moves a price must not turn a downgrade into an "upgrade" that skips
    // the over-limit pre-check.
    wrap(<PlansPage />, '/billing/plans');

    expect(await screen.findByRole('button', { name: /Upgrade now/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Schedule downgrade for 1 Oct/u })).toBeTruthy();
  });

  it('says what the upgrade costs today', async () => {
    wrap(<PlansPage />, '/billing/plans');

    expect(await screen.findByText('Charged $183.33 today for 20–30 Sep')).toBeTruthy();
  });

  it('renders unlimited rather than a number, and a dash for an absent flag', async () => {
    wrap(<PlansPage />, '/billing/plans');

    await screen.findByRole('button', { name: 'Current plan' });
    expect(screen.getAllByText('Unlimited').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('switches the whole table to the annual price', async () => {
    wrap(<PlansPage />, '/billing/plans');

    await screen.findByText('$249');
    await userEvent.click(screen.getByRole('button', { name: /Annual/u }));

    expect(await screen.findByText('$207.50')).toBeTruthy();
    expect(screen.getAllByText('billed yearly').length).toBeGreaterThan(0);
  });

  it('sends the customer to the handoff page rather than straight to Stripe', async () => {
    // The checkout session is created on /billing/checkout, which tells the
    // customer where they are going and what it costs before it leaves.
    wrap(<PlansPage />, '/billing/plans');

    await userEvent.click(await screen.findByRole('button', { name: /Upgrade now/u }));

    expect(sent.some((request) => request.method === 'POST' && request.url.includes('/billing/checkout'))).toBe(
      false,
    );
  });
});

describe('a blocked downgrade (I3)', () => {
  it('lists every item that is over the limit, with a way to fix each', async () => {
    // "You cannot downgrade" with no explanation is a support ticket. The
    // customer usually can, once they know what to archive.
    standardStubs();
    responses.set('GET /billing/plan-change/preview', {
      from: 'growth',
      to: 'starter',
      blocked: true,
      effectiveAt: '2026-10-01T00:00:00.000Z',
      conflicts: [
        {
          feature: 'contacts.stored',
          current: 48_213,
          targetLimit: 10_000,
          hint: 'Archive or delete to get under the limit; suppressions do not count',
          fixLabel: 'Manage contacts',
          fixHref: '/audience/contacts',
        },
      ],
    });

    wrap(<PlansPage />, '/billing/plans');

    await userEvent.click(await screen.findByRole('button', { name: /Schedule downgrade/u }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("Can't schedule the downgrade to Starter yet");
    expect(within(dialog).getByText('48,213')).toBeTruthy();
    expect(within(dialog).getByText('10,000')).toBeTruthy();
    expect(within(dialog).getByText(/suppressions do not count/u)).toBeTruthy();
    expect(within(dialog).getByText(/Manage contacts/u).getAttribute('href')).toBe('/audience/contacts');
  });

  it('keeps the schedule button disabled while anything is over', async () => {
    standardStubs();
    responses.set('GET /billing/plan-change/preview', {
      from: 'growth',
      to: 'starter',
      blocked: true,
      conflicts: [{ feature: 'contacts.stored', current: 48_213, targetLimit: 10_000 }],
    });

    wrap(<PlansPage />, '/billing/plans');
    await userEvent.click(await screen.findByRole('button', { name: /Schedule downgrade/u }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Schedule downgrade' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(sent.some((request) => request.method === 'POST' && request.url.includes('/billing/plan'))).toBe(false);
  });

  it('schedules the downgrade when nothing blocks it', async () => {
    standardStubs();
    responses.set('GET /billing/plan-change/preview', {
      from: 'growth',
      to: 'starter',
      blocked: false,
      conflicts: [],
      effectiveAt: '2026-10-01T00:00:00.000Z',
    });
    responses.set('POST /billing/plan', {
      direction: 'downgrade',
      appliesAt: 'period_end',
      effectiveAt: '2026-10-01T00:00:00.000Z',
    });

    wrap(<PlansPage />, '/billing/plans');
    await userEvent.click(await screen.findByRole('button', { name: /Schedule downgrade/u }));

    await waitFor(() => {
      const change = sent.find((request) => request.method === 'POST' && request.url.endsWith('/billing/plan'));
      expect(change?.body).toEqual({ planCode: 'starter', interval: 'month' });
    });
  });
});

describe('the success page (I5)', () => {
  it('says the payment went through while it waits, and claims nothing', async () => {
    // The customer has just been charged. A bare spinner is the worst
    // available thing to show them — and a premature "you are all set" is
    // worse still.
    responses.set('GET /billing/checkout/status', { ready: false, action: 'poll' });
    responses.set('GET /billing', OVERVIEW);

    wrap(<CheckoutSuccessPage />, '/billing/success?session_id=cs_live_a1B2c3');

    expect(await screen.findByText('Confirming your subscription…')).toBeTruthy();
    expect(screen.getByText(/waiting for the confirmation event before switching the plan/u)).toBeTruthy();
    expect(screen.queryByText(/Back to billing/u)).toBe(null);
  });

  it('confirms only once the subscription row exists', async () => {
    responses.set('GET /billing/checkout/status', {
      ready: true,
      action: 'done',
      planCode: 'scale',
      planName: 'Scale',
      chargedToday: 18_333,
      currency: 'usd',
    });
    responses.set('GET /billing', OVERVIEW);

    wrap(<CheckoutSuccessPage />, '/billing/success?session_id=cs_live_a1B2c3');

    expect(await screen.findByText('Scale is active')).toBeTruthy();
    expect(screen.getByText('$183.33')).toBeTruthy();
  });

  it('gives up with a request ID rather than spinning forever', async () => {
    responses.set('GET /billing/checkout/status', {
      ready: false,
      action: 'give_up',
      requestId: 'req_01J9I5CHKOUT7Q',
    });
    responses.set('GET /billing', OVERVIEW);

    wrap(<CheckoutSuccessPage />, '/billing/success?session_id=cs_live_a1B2c3');

    expect(await screen.findByText("We haven't received confirmation yet")).toBeTruthy();
    expect(screen.getByText('req_01J9I5CHKOUT7Q')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep waiting' })).toBeTruthy();
  });

  it('promises no double charge and an unchanged plan when it gives up', async () => {
    responses.set('GET /billing/checkout/status', { ready: false, action: 'give_up' });
    responses.set('GET /billing', OVERVIEW);

    wrap(<CheckoutSuccessPage />, '/billing/success?session_id=cs_live_a1B2c3');

    expect(await screen.findByText(/have not been charged twice/u)).toBeTruthy();
    expect(screen.getByText('still Growth')).toBeTruthy();
  });
});

describe('the cancelled checkout (I6)', () => {
  it('says nothing was paid and nothing changed', async () => {
    responses.set('GET /billing', OVERVIEW);

    wrap(<CheckoutCancelledPage />, '/billing/cancel');

    expect(await screen.findByText('Checkout cancelled')).toBeTruthy();
    expect(
      await screen.findByText(/No payment was made and nothing changed\. Northwind Voyages stays on Growth/u),
    ).toBeTruthy();
  });
});

describe('invoices (I7)', () => {
  it('lists them with the period, the status and a PDF', async () => {
    standardStubs();

    wrap(<InvoicesPage />, '/billing/invoices');

    expect(await screen.findByText('INV-2026-0912')).toBeTruthy();
    expect(screen.getByText('Sep 2026 · Growth')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText('1 invoice · totals in USD · taxes shown on the PDF')).toBeTruthy();
  });

  it('opens the provider PDF in a new tab, safely', async () => {
    // `noopener` matters: without it the opened page can navigate ours.
    standardStubs();

    wrap(<InvoicesPage />, '/billing/invoices');

    const link = await screen.findByText('PDF');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('says what will appear here and offers a plan when there are none (I7e)', async () => {
    standardStubs();
    responses.set('GET /billing/invoices', []);

    wrap(<InvoicesPage />, '/billing/invoices');

    expect(await screen.findByText('No invoices yet')).toBeTruthy();
    expect(screen.getByText(/we email a copy to billing@northwind.travel each month/u)).toBeTruthy();
    expect(screen.getByText('See plans')).toBeTruthy();
    expect(screen.queryByText('Download all (CSV)')).toBe(null);
  });

  it('gives support a request ID when the list fails (I7f)', async () => {
    standardStubs();
    responses.set('GET /billing/invoices', {
      __error: {
        status: 500,
        body: { error: { code: 'internal_error', message: 'nope', requestId: 'req_01J9I7FR8D2L' } },
      },
    });

    wrap(<InvoicesPage />, '/billing/invoices');

    expect(await screen.findByText("We couldn't load invoices")).toBeTruthy();
    expect(screen.getByText('req_01J9I7FR8D2L')).toBeTruthy();
    expect(screen.getByText(/subscription and payment method are unaffected/u)).toBeTruthy();
  });
});

describe('the payment method page (I8)', () => {
  it('says Relayd never stores the card and sends the owner to Stripe', async () => {
    standardStubs();
    responses.set('POST /billing/portal', { url: 'https://billing.stripe.com/p/session' });

    wrap(<PaymentMethodPage />, '/billing/payment-method');

    expect(await screen.findByText(/Relayd never stores card numbers/u)).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: /Update in Stripe portal/u }));

    await waitFor(() => {
      expect(sent.some((request) => request.method === 'POST' && request.url.includes('/billing/portal'))).toBe(
        true,
      );
    });
  });

  it('fills the invoice details from the workspace and saves them', async () => {
    standardStubs();
    responses.set('PATCH /billing/details', OVERVIEW.billingDetails);

    wrap(<PaymentMethodPage />, '/billing/payment-method');

    const email = (await screen.findByLabelText('Billing email')) as HTMLInputElement;
    await waitFor(() => expect(email.value).toBe('billing@northwind.travel'));

    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => {
      const save = sent.find((request) => request.method === 'PATCH');
      expect(save?.body).toMatchObject({ company: 'Northwind Voyages LLC' });
    });
  });

  it('refuses an invoice address with no billing email', async () => {
    standardStubs();

    wrap(<PaymentMethodPage />, '/billing/payment-method');

    const email = (await screen.findByLabelText('Billing email')) as HTMLInputElement;
    await waitFor(() => expect(email.value).toBe('billing@northwind.travel'));

    await userEvent.clear(email);
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText('A billing email is required')).toBeTruthy();
    expect(sent.some((request) => request.method === 'PATCH')).toBe(false);
  });

  it('locks the form for an admin and says why', async () => {
    role = { can: ['billing:read'], workspace: 'Northwind Voyages' };
    standardStubs();

    wrap(<PaymentMethodPage />, '/billing/payment-method');

    const save = await screen.findByRole('button', { name: 'Save details' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(save.getAttribute('title')).toBe('Only the workspace owner can change billing');
  });
});

describe('cancelling (I9)', () => {
  it('says exactly what is kept and exactly what stops, with no offer in between', async () => {
    standardStubs();

    wrap(<CancelSubscriptionPage />, '/billing/cancel-subscription');

    expect(await screen.findByText('Cancel the Growth subscription?')).toBeTruthy();
    expect(screen.getByText(/No offers, no extra steps: one confirmation below/u)).toBeTruthy();
    expect(screen.getByText('You keep until 1 Oct 2026')).toBeTruthy();
    expect(screen.getByText('From 1 Oct 2026')).toBeTruthy();
    expect(screen.getByText(/Workspace becomes read-only/u)).toBeTruthy();
    expect(screen.getByText(/data is deleted on 31 Oct/u)).toBeTruthy();
  });

  it('offers the export before the deletion date, not after', async () => {
    standardStubs();
    responses.set('POST /billing/export', { ok: true });

    wrap(<CancelSubscriptionPage />, '/billing/cancel-subscription');

    await userEvent.click(await screen.findByRole('button', { name: 'Export everything' }));

    await waitFor(() => {
      expect(sent.some((request) => request.url.includes('/billing/export'))).toBe(true);
    });
  });

  it('cancels at the period end and passes the reason along', async () => {
    standardStubs();
    responses.set('POST /billing/cancel', { endsAt: '2026-10-01T00:00:00.000Z' });

    wrap(<CancelSubscriptionPage />, '/billing/cancel-subscription');

    await userEvent.type(await screen.findByLabelText(/Why are you cancelling/u), 'Too expensive');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));

    await waitFor(() => {
      const request = sent.find((item) => item.url.includes('/billing/cancel'));
      expect(request?.body).toEqual({ immediately: false, reason: 'Too expensive' });
    });
  });

  it('confirms with the dates that matter and a way back (I9b)', async () => {
    standardStubs();
    responses.set('POST /billing/cancel', { endsAt: '2026-10-01T00:00:00.000Z' });

    wrap(<CancelSubscriptionPage />, '/billing/cancel-subscription');

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel subscription' }));

    expect(await screen.findByText('Subscription cancelled')).toBeTruthy();
    expect(screen.getByText('Read-only from')).toBeTruthy();
    expect(screen.getByText('31 Oct 2026 · export until then')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reactivate Growth' })).toBeTruthy();
  });

  it('never offers an immediate cancellation', async () => {
    // Ending a paid period early with no refund is not a thing to hide
    // behind a radio button, and the frames do not offer it.
    standardStubs();

    wrap(<CancelSubscriptionPage />, '/billing/cancel-subscription');

    await screen.findByText('Cancel the Growth subscription?');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('disables the confirmation for an admin', async () => {
    role = { can: ['billing:read'], workspace: 'Northwind Voyages' };
    standardStubs();

    wrap(<CancelSubscriptionPage />, '/billing/cancel-subscription');

    const confirm = await screen.findByRole('button', { name: 'Cancel subscription' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(confirm.getAttribute('title')).toBe('Only the workspace owner can change billing');
  });
});

describe('the route table', () => {
  it('keeps the old cancel path working', () => {
    // The design moved the page to /billing/cancel-subscription. A link in
    // somebody's tab should not 404 because a route was renamed.
    const paths = JSON.stringify(billingRoutes);
    expect(paths).toContain('/billing/cancel-subscription');
    expect(paths).toContain('/billing/subscription/cancel');
  });
});

describe('formatting', () => {
  it('renders minor units as money', () => {
    // Stripe gives cents. Nobody reads cents.
    expect(formatMoney(24_900, 'usd')).toBe('$249.00');
  });

  it('does not crash on a malformed currency code', () => {
    // Intl throws a RangeError for anything that is not three letters. A
    // truncated code from a misconfigured Stripe account must not take the
    // billing page down with it.
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

  it('prints a within-month period once', () => {
    expect(formatPeriod('2026-09-01T00:00:00.000Z', '2026-09-19T00:00:00.000Z')).toBe('1–19 Sep 2026');
  });

  it('prints the retry schedule with one month, as the frame does', () => {
    expect(formatRetrySchedule(['2026-09-19', '2026-09-22', '2026-09-26'])).toBe('19, 22 and 26 Sep');
  });

  it('survives an empty retry schedule', () => {
    expect(formatRetrySchedule([])).toBe('—');
  });
});
