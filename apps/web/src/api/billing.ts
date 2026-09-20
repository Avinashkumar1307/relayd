import { api } from './client.js';

/**
 * Billing endpoints (section I).
 *
 * Nothing here computes money and nothing decides entitlement. The server
 * does both, and the read-only fields below exist so the UI can *show* a
 * customer where they stand — never so it can decide whether to let them
 * act (CLAUDE.md section 10: entitlement checks are server-side only).
 *
 * ## What the frames draw that the API does not send yet
 *
 * The I frames are a priced billing screen: I1a shows the next invoice and
 * the overage rate, I2 prices four plans and compares twelve rows, I4/I5
 * show a prorated charge, I8 edits the invoice address, I9 lists exactly
 * what cancelling costs. `apps/api/src/routes/billing.ts` serves the plan
 * catalogue, the overview, usage, invoices, checkout, the checkout status,
 * the portal, the downgrade pre-check, the plan change and the cancel — and
 * none of them carry money or an address, because the catalogue in
 * `@relayd/billing` has no prices in it.
 *
 * Every field the frames need and the server does not send is optional here
 * and marked `BACKEND PENDING`, so the same page renders correctly against
 * the preview backend (which supplies them) and the real one (which does
 * not) — degraded, never broken.
 */

export type Interval = 'month' | 'year';

/** A price in minor units, as Stripe reports one. */
export interface PlanPrice {
  /** Minor units per month on the monthly interval. Null when bespoke. */
  month: number | null;
  /** Minor units per month when billed annually. Null when bespoke. */
  year: number | null;
  currency: string;
}

export interface PlanSummary {
  code: string;
  name: string;
  description?: string;
  rank: number;
  trialDays: number;
  limits: Record<string, number | null>;
  flags: Record<string, boolean>;

  /** BACKEND PENDING: GET /billing/plans (I2 prices each column). */
  price?: PlanPrice;
  /** BACKEND PENDING: GET /billing/plans (I2's "Overage per 1,000" row). */
  overagePer1000?: number | null;
  /**
   * BACKEND PENDING: GET /billing/plans.
   *
   * The I2 rows the feature catalogue has no key for — provider
   * connections, complaint thresholds, SIEM export, SSO, support tier. A
   * string renders as itself, `true`/`false` as a tick or a dash, and an
   * absent key as a dash.
   */
  comparison?: Record<string, string | boolean | null>;
  /** Priced by contract rather than self-serve: the Enterprise column. */
  custom?: boolean;
}

export interface UsageRow {
  featureKey: string;
  used: number;
  /** Null is unlimited, which is not the same as zero. */
  included: number | null;
  overage: number;
  periodEnd: string;
}

export interface BillingState {
  workspaceSuspended: boolean;
  subscriptionSuspended: boolean;
  pastDue: boolean;
  hasSubscription: boolean;
}

export interface SubscriptionSummary {
  planCode: string;
  planName: string;
  interval: Interval;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  scheduledPlanCode: string | null;
  scheduledChangeAt: string | null;
  trialEnd: string | null;
}

export interface PaymentMethodSummary {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  /** BACKEND PENDING: GET /billing (I8's "Default" badge). */
  isDefault?: boolean;
  /** BACKEND PENDING: GET /billing (I8: "· Dana Haddad · added 14 Apr 2026"). */
  holder?: string | null;
  addedAt?: string | null;
  /** BACKEND PENDING: GET /billing (I1b prints the decline dates in red). */
  declinedOn?: string[];
}

/** BACKEND PENDING: GET /billing — I1a's "Next invoice · estimate" card. */
export interface NextInvoiceEstimate {
  at: string;
  total: number;
  currency: string;
  planAmount: number;
  overageAmount: number;
  /** The included allowance the overage rate applies past. */
  includedEmails: number | null;
  /** Minor units per 1,000 emails over the allowance. */
  overagePer1000: number | null;
}

/** BACKEND PENDING: GET /billing — I1a's receipts line and I8's form. */
export interface BillingDetails {
  email: string;
  company: string;
  address: string;
  taxId: string;
}

/** BACKEND PENDING: GET /billing — the I1b past-due card. */
export interface DunningSummary {
  invoiceNumber: string;
  amount: number;
  currency: string;
  daysPastDue: number;
  /** "was declined on 15 Sep and again on 17 Sep" */
  declinedOn: string[];
  /** "We retry on 19, 22 and 26 Sep" */
  retryOn: string[];
  /** Sending continues until this date, then launches are blocked. */
  sendingBlockedAt: string;
}

export interface BillingOverview {
  subscription: SubscriptionSummary | null;
  state: BillingState;
  usage: UsageRow[];
  paymentMethod: PaymentMethodSummary | null;
  /** BACKEND PENDING: GET /billing. */
  nextInvoice?: NextInvoiceEstimate | null;
  /** BACKEND PENDING: GET /billing. */
  billingDetails?: BillingDetails | null;
  /** BACKEND PENDING: GET /billing. */
  dunning?: DunningSummary | null;
  /**
   * BACKEND PENDING: GET /billing.
   *
   * Sends this period that reached `delivery_uncertain` and are therefore
   * unbilled (D3). I1a names the number, because a customer counting their
   * own sends will otherwise find it missing.
   */
  deliveryUncertain?: number;
}

export interface InvoiceRow {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  total: number;
  amountDue: number;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  createdAt: string;
  /** BACKEND PENDING: GET /billing/invoices (I7's "Period · plan" column). */
  periodLabel?: string;
  /** BACKEND PENDING: GET /billing/invoices (I7's "Payment" column). */
  paymentLabel?: string | null;
}

export interface DowngradeConflict {
  feature: string;
  current: number;
  targetLimit: number;
  /** BACKEND PENDING: I3 prints a sentence under each blocked row. */
  hint?: string;
  /** BACKEND PENDING: I3's "Fix" column — a label and an in-app route. */
  fixLabel?: string;
  fixHref?: string;
}

export interface PlanChangePreview {
  from: string | null;
  to: string;
  blocked: boolean;
  conflicts: DowngradeConflict[];
  /** BACKEND PENDING: the date a downgrade would take effect (I2/I3). */
  effectiveAt?: string | null;
  /** BACKEND PENDING: what an upgrade costs today (I2's caption, I4). */
  proration?: { dueToday: number; currency: string; periodLabel: string } | null;
}

/**
 * What the success page should do next, decided by the server.
 *
 * The threshold lives in one place rather than being a number somebody has
 * to remember to change here as well.
 */
export interface CheckoutStatus {
  ready: boolean;
  planCode?: string;
  action: 'poll' | 'fallback' | 'give_up' | 'done';
  /** BACKEND PENDING: I5b names the plan and the moment Stripe confirmed. */
  planName?: string;
  confirmedAt?: string;
  /** BACKEND PENDING: I5b's "Charged today · prorated". */
  chargedToday?: number;
  currency?: string;
  /** BACKEND PENDING: I5c quotes a request ID to support. */
  requestId?: string;
  /** BACKEND PENDING: I5b's "View invoice". */
  invoiceUrl?: string | null;
}

export const billingKeys = {
  all: (workspaceId: string) => ['billing', workspaceId] as const,
  overview: (workspaceId: string) => ['billing', workspaceId, 'overview'] as const,
  plans: (workspaceId: string) => ['billing', workspaceId, 'plans'] as const,
  invoices: (workspaceId: string) => ['billing', workspaceId, 'invoices'] as const,
  planChange: (workspaceId: string, planCode: string) =>
    ['billing', workspaceId, 'plan-change', planCode] as const,
  checkoutStatus: (workspaceId: string) => ['billing', workspaceId, 'checkout-status'] as const,
};

export const billingApi = {
  plans: () => api.get<PlanSummary[]>('/billing/plans'),

  overview: () => api.get<BillingOverview>('/billing'),

  usage: () => api.get<UsageRow[]>('/billing/usage'),

  invoices: (input: { limit?: number } = {}) => api.get<InvoiceRow[]>('/billing/invoices', input),

  checkout: (input: { planCode: string; interval: Interval }) =>
    api.post<{ id: string; url: string; expiresAt: string }>('/billing/checkout', input),

  checkoutStatus: (elapsedMs: number) =>
    api.get<CheckoutStatus>('/billing/checkout/status', { elapsedMs: String(elapsedMs) }),

  portal: () => api.post<{ url: string }>('/billing/portal', {}),

  planChangePreview: (planCode: string) =>
    api.get<PlanChangePreview>('/billing/plan-change/preview', { planCode }),

  changePlan: (input: { planCode: string; interval: Interval }) =>
    api.post<{
      direction: 'upgrade' | 'downgrade' | 'interval_only' | 'none';
      appliesAt: 'immediately' | 'period_end';
      effectiveAt: string | null;
    }>('/billing/plan', input),

  cancel: (input: { immediately: boolean; reason?: string }) =>
    api.post<{ endsAt: string | null }>('/billing/cancel', input),

  /**
   * I9b's "Reactivate Growth".
   *
   * The server clears the scheduled cancellation at Stripe and writes
   * nothing locally — the `customer.subscription.updated` webhook carries
   * the authoritative flag. Invalidate and re-read rather than trusting
   * this response.
   */
  reactivate: () => api.post<{ ok: boolean }>('/billing/reactivate', {}),

  /**
   * I1b's "Retry now".
   *
   * The invoice is chosen server-side. `ok` means Stripe accepted the
   * instruction, never that the card cleared — that arrives as a webhook.
   */
  retryPayment: () => api.post<{ ok: boolean }>('/billing/retry-payment', {}),

  /** I8's "Save details". */
  saveDetails: (input: BillingDetails) =>
    api.patch<BillingDetails>('/billing/details', input),

  /** I9a/I9b's "Export everything". Answers 202: the export is a job. */
  exportEverything: () => api.post<{ ok: boolean }>('/billing/export', {}),
};
