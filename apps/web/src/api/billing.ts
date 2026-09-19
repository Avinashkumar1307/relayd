import { api } from './client.js';

/**
 * Billing endpoints.
 *
 * Nothing here computes money and nothing decides entitlement. The server
 * does both, and the read-only check below exists so the UI can *show* a
 * customer where they stand — never so it can decide whether to let them act.
 */

export type Interval = 'month' | 'year';

export interface PlanSummary {
  code: string;
  name: string;
  description?: string;
  rank: number;
  trialDays: number;
  limits: Record<string, number | null>;
  flags: Record<string, boolean>;
}

export interface UsageRow {
  featureKey: string;
  used: number;
  /** Null is unlimited, which is not the same as zero. */
  included: number | null;
  overage: number;
  /** Null when the feature is unlimited — a percentage of unlimited is not a number. */
  percentUsed: number | null;
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

export interface BillingOverview {
  subscription: SubscriptionSummary | null;
  state: BillingState;
  usage: UsageRow[];
  paymentMethod: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  } | null;
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
}

export interface DowngradeConflict {
  feature: string;
  current: number;
  targetLimit: number;
}

export interface PlanChangePreview {
  from: string | null;
  to: string;
  blocked: boolean;
  conflicts: DowngradeConflict[];
}

/**
 * What the success page should do next, decided by the server.
 *
 * The threshold lives in one place rather than being a number somebody has to
 * remember to change here as well.
 */
export interface CheckoutStatus {
  ready: boolean;
  planCode?: string;
  action: 'poll' | 'fallback' | 'give_up' | 'done';
}

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

  cancel: (input: { immediately: boolean }) =>
    api.post<{ endsAt: string | null }>('/billing/cancel', input),
};
