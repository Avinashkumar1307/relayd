import type { Route } from '../state.js';
import { nowIso } from '../state.js';
import { billingOverview, downgradeConflicts, invoices, plans } from '../data/billing.js';

/**
 * Section I demo routes: plans, the overview, invoices and the checkout
 * flow.
 *
 * DEMO ONLY.
 *
 * ## Seeing the states the frames draw
 *
 * Five of the I frames are a state of a page rather than a page: I1b is
 * /billing with a payment behind, I7e and I7f are the empty and failed
 * invoice lists, I5a and I5c are the success page waiting and giving up.
 * The demo server matches on the path alone, so the variant is read from
 * the SPA's own query string instead:
 *
 *   /billing?demo=past_due            I1b
 *   /billing/invoices?demo=empty      I7e
 *   /billing/success?demo=timeout     I5c
 *
 * I7f, the failed invoice list, is not one of these: the demo transport
 * only answers 200, and the honest way to see that state is the unit test
 * that renders it.
 *
 * With no `demo` parameter /billing/success polls three times and then
 * confirms, which is I5a followed by I5b — the real sequence, at a speed
 * somebody can watch.
 */

function variant(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') ?? '';
  } catch {
    return '';
  }
}

/** I1b: the same workspace four days past due. */
function pastDue(): unknown {
  return {
    ...billingOverview,
    state: { ...billingOverview.state, pastDue: true },
    paymentMethod: { ...billingOverview.paymentMethod, declinedOn: ['2026-09-15', '2026-09-17'] },
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
}

/**
 * How many times the success page has asked. Reset on reload, like every
 * other piece of demo state — the point is to watch the wait, not to model
 * a webhook.
 */
let polls = 0;

export const routes: Route[] = [
  { method: 'GET', pattern: /^\/billing\/plans$/u, handler: () => plans },
  { method: 'GET', pattern: /^\/billing\/usage$/u, handler: () => billingOverview.usage },

  {
    method: 'GET',
    pattern: /^\/billing\/invoices$/u,
    handler: () => (variant() === 'empty' ? [] : invoices),
  },

  {
    method: 'GET',
    pattern: /^\/billing\/checkout\/status$/u,
    handler: () => {
      if (variant() === 'timeout') return { ready: false, action: 'give_up', requestId: 'req_01J9I5CHKOUT7Q' };

      polls += 1;
      if (polls < 4) return { ready: false, action: 'poll' };

      return {
        ready: true,
        action: 'done',
        planCode: billingOverview.subscription.planCode,
        planName: billingOverview.subscription.planName,
        confirmedAt: nowIso(),
        chargedToday: 18_333,
        currency: 'usd',
        invoiceUrl: '#',
      };
    },
  },

  {
    method: 'POST',
    pattern: /^\/billing\/checkout$/u,
    handler: () => ({ id: 'cs_live_a1B2c3d4e5f6g7h8i9zY', url: '/billing/success?session_id=cs_live_a1B2c3d4e5f6g7h8i9zY', expiresAt: nowIso() }),
  },

  { method: 'POST', pattern: /^\/billing\/portal$/u, handler: () => ({ url: '/billing/payment-method?demo=portal' }) },

  {
    method: 'GET',
    pattern: /^\/billing\/plan-change\/preview$/u,
    handler: () => ({
      from: billingOverview.subscription.planCode,
      to: 'starter',
      blocked: true,
      conflicts: downgradeConflicts,
      effectiveAt: billingOverview.subscription.currentPeriodEnd,
      proration: { dueToday: 18_333, currency: 'usd', periodLabel: '20–30 Sep' },
    }),
  },

  {
    method: 'POST',
    pattern: /^\/billing\/plan$/u,
    handler: () => ({
      direction: 'downgrade',
      appliesAt: 'period_end',
      effectiveAt: billingOverview.subscription.currentPeriodEnd,
    }),
  },

  {
    method: 'POST',
    pattern: /^\/billing\/cancel$/u,
    handler: () => ({ endsAt: billingOverview.subscription.currentPeriodEnd }),
  },

  { method: 'POST', pattern: /^\/billing\/reactivate$/u, handler: () => ({ ok: true }) },
  { method: 'POST', pattern: /^\/billing\/retry-payment$/u, handler: () => ({ ok: true }) },
  { method: 'POST', pattern: /^\/billing\/export$/u, handler: () => ({ ok: true }) },
  {
    method: 'PATCH',
    pattern: /^\/billing\/details$/u,
    handler: (_match, body) => body ?? billingOverview.billingDetails,
  },

  // Last, so /billing/plans and friends are not shadowed by the bare path.
  {
    method: 'GET',
    pattern: /^\/billing$/u,
    handler: () => (variant() === 'past_due' ? pastDue() : billingOverview),
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/billing',
  '/billing/plans',
  '/billing/invoices',
  '/billing/payment-method',
  '/billing/cancel-subscription',
  '/billing/checkout',
  '/billing/success',
  '/billing/cancel',
];
