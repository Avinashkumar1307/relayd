import { iso } from './clock.js';

/**
 * Section I fixtures: plans, the subscription, usage and invoices.
 *
 * DEMO ONLY. Every number here is the one the I frames print, so the preview
 * and the design can be put side by side: Growth at $249, 184,320 of 250,000
 * emails, 48,213 of 100,000 contacts, 6 of 10 seats, Visa 4242 expiring
 * 08/2028, and the seven invoices of I7.
 *
 * The frozen clock is 19 Sep 2026, so `iso(-12)` is 1 Oct 2026 — the renewal
 * date every frame quotes.
 */

/** 1 Oct 2026 — the period end every I frame prints. */
const PERIOD_END = iso(-12);
/** 1 Sep 2026 — the period start. */
const PERIOD_START = iso(18);

export const plans = [
  {
    code: 'starter',
    name: 'Starter',
    description: 'For a first list and a regular newsletter.',
    rank: 10,
    trialDays: 14,
    price: { month: 4900, year: 4083, currency: 'usd' },
    overagePer1000: 150,
    limits: {
      'emails.sent': 25_000,
      'contacts.stored': 10_000,
      'workspace.seats': 3,
      'analytics.retention_days': 91,
    },
    flags: { 'campaigns.sending_pools': false, 'api.access': false },
    comparison: {
      'providers.connections': '1',
      'complaint.thresholds': false,
      'audit.export': false,
      sso: false,
      support: 'Email',
    },
  },
  {
    code: 'growth',
    name: 'Growth',
    description: 'For a team sending regularly across several audiences.',
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
    comparison: {
      'providers.connections': 'Unlimited',
      'complaint.thresholds': false,
      'audit.export': false,
      sso: false,
      support: 'Priority',
    },
  },
  {
    code: 'scale',
    name: 'Scale',
    description: 'For a business sending at volume across brands.',
    rank: 30,
    trialDays: 0,
    price: { month: 74_900, year: 62_417, currency: 'usd' },
    overagePer1000: 90,
    limits: {
      'emails.sent': 1_000_000,
      'contacts.stored': 500_000,
      'workspace.seats': 25,
      'analytics.retention_days': 761,
    },
    flags: { 'campaigns.sending_pools': true, 'api.access': true },
    comparison: {
      'providers.connections': 'Unlimited',
      'complaint.thresholds': true,
      'audit.export': true,
      sso: false,
      support: 'Named contact',
    },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Annual contract, dedicated support and an SLA.',
    rank: 40,
    trialDays: 0,
    custom: true,
    limits: { 'workspace.seats': null },
    flags: { 'campaigns.sending_pools': true, 'api.access': true },
    comparison: {
      'emails.sent': '2M+',
      overage: 'Custom',
      'contacts.stored': 'Custom',
      'analytics.retention_days': 'Custom',
      'providers.connections': 'Unlimited',
      'complaint.thresholds': true,
      'audit.export': true,
      sso: true,
      support: 'Dedicated + SLA',
    },
  },
];

export const billingOverview = {
  subscription: {
    planCode: 'growth',
    planName: 'Growth',
    interval: 'month',
    status: 'active',
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    scheduledPlanCode: null,
    scheduledChangeAt: null,
    trialEnd: null,
  },
  state: { workspaceSuspended: false, subscriptionSuspended: false, pastDue: false, hasSubscription: true },
  usage: [
    { featureKey: 'emails.sent', used: 184_320, included: 250_000, overage: 0, periodEnd: PERIOD_END },
    { featureKey: 'contacts.stored', used: 48_213, included: 100_000, overage: 0, periodEnd: PERIOD_END },
    { featureKey: 'workspace.seats', used: 6, included: 10, overage: 0, periodEnd: PERIOD_END },
  ],
  paymentMethod: {
    brand: 'visa',
    last4: '4242',
    expMonth: 8,
    expYear: 2028,
    isDefault: true,
    holder: 'Dana Haddad',
    addedAt: iso(158),
    declinedOn: [],
  },
  nextInvoice: {
    at: PERIOD_END,
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
    address: 'Office 1204, Marina Plaza, Dubai Marina, Dubai, United Arab Emirates',
    taxId: 'AE100 2345 6789 0',
  },
  dunning: null,
  deliveryUncertain: 412,
};

/** I7's seven invoices, newest first. */
export const invoices = [
  { id: 'in_0912', number: 'INV-2026-0912', status: 'paid', currency: 'usd', total: 24_900, amountDue: 0, periodStart: PERIOD_START, periodEnd: PERIOD_END, paidAt: iso(18), hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(18), periodLabel: 'Sep 2026 · Growth', paymentLabel: 'Visa •••• 4242' },
  { id: 'in_0801', number: 'INV-2026-0801', status: 'paid', currency: 'usd', total: 26_124, amountDue: 0, periodStart: iso(49), periodEnd: iso(18), paidAt: iso(49), hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(49), periodLabel: 'Aug 2026 · Growth + 10,200 overage', paymentLabel: 'Visa •••• 4242' },
  { id: 'in_0701', number: 'INV-2026-0701', status: 'paid', currency: 'usd', total: 24_900, amountDue: 0, periodStart: iso(80), periodEnd: iso(49), paidAt: iso(80), hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(80), periodLabel: 'Jul 2026 · Growth', paymentLabel: 'Visa •••• 4242' },
  { id: 'in_0601', number: 'INV-2026-0601', status: 'paid', currency: 'usd', total: 24_900, amountDue: 0, periodStart: iso(110), periodEnd: iso(80), paidAt: iso(110), hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(110), periodLabel: 'Jun 2026 · Growth', paymentLabel: 'Visa •••• 4242' },
  { id: 'in_0501', number: 'INV-2026-0501', status: 'paid', currency: 'usd', total: 38_560, amountDue: 0, periodStart: iso(141), periodEnd: iso(110), paidAt: iso(141), hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(141), periodLabel: 'May 2026 · Growth (prorated from 14 Apr)', paymentLabel: 'Visa •••• 4242' },
  { id: 'in_0414', number: 'INV-2026-0414', status: 'void', currency: 'usd', total: 0, amountDue: 0, periodStart: null, periodEnd: null, paidAt: null, hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(158), periodLabel: 'Plan change credit · Starter → Growth', paymentLabel: null },
  { id: 'in_0401', number: 'INV-2026-0401', status: 'paid', currency: 'usd', total: 4_900, amountDue: 0, periodStart: iso(171), periodEnd: iso(141), paidAt: iso(171), hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(171), periodLabel: 'Apr 2026 · Starter', paymentLabel: 'Visa •••• 4242' },
];

/**
 * I3's blocked downgrade to Starter: four limits over, each with the page
 * that fixes it. Emails cannot be fixed at all — the period has to end —
 * and saying so is the point of the row.
 */
export const downgradeConflicts = [
  {
    feature: 'contacts.stored',
    current: 48_213,
    targetLimit: 10_000,
    hint: 'Archive or delete to get under the limit; suppressions do not count',
    fixLabel: 'Manage contacts',
    fixHref: '/audience/contacts',
  },
  {
    feature: 'workspace.seats',
    current: 6,
    targetLimit: 3,
    hint: 'Remove members or pending invitations',
    fixLabel: 'Manage team',
    fixHref: '/settings/team',
  },
  {
    feature: 'providers.connections',
    current: 3,
    targetLimit: 1,
    hint: 'Starter allows one connection',
    fixLabel: 'Manage providers',
    fixHref: '/providers',
  },
  {
    feature: 'emails.sent',
    current: 184_320,
    targetLimit: 25_000,
    hint: 'Resets on 1 Oct; the downgrade can only start then',
    fixLabel: 'Wait for 1 Oct',
    fixHref: '/billing',
  },
];
