import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { WorkspaceId } from '@relayd/types';
import { workspaces } from './identity.js';

/**
 * Billing, mirroring migration 0013_billing.sql.
 *
 * The division of labour (CLAUDE.md section 10): Stripe owns money objects —
 * charges, invoices, subscription status, refunds, payment methods. We own
 * plans, features, limits, entitlements, usage, and the workspace-to-Stripe
 * mapping. Everything in the "projections of Stripe" group below is a mirror
 * kept convergent by re-fetching, never by applying a webhook payload.
 *
 * Two things in here are load-bearing beyond their size:
 *
 *   `billing_customers.provider_customer_id` is nullable, and that null is
 *   R18. The row is written before Stripe is called, so a crash between the
 *   two leaves a `pending` row the reconciler can finish rather than a Stripe
 *   customer nothing can map to a workspace.
 *
 *   `usage_aggregates.last_usage_record_id` is R15. It is what makes
 *   aggregation idempotent, and it is why a billing job can be retried.
 *
 * `plans`, `features`, `plan_features` and `prices` carry no `workspace_id`
 * and have no RLS policy. They are the same for every workspace, and a policy
 * on them would have nothing to compare against.
 */

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

const updatedAt = timestamp('updated_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// --------------------------------------------------------------- catalogue

export const plans = pgTable(
  'plans',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * Ordering for the pricing page and, more importantly, for deciding
     * whether a change is an upgrade or a downgrade. Comparing prices would
     * get that wrong the first time somebody runs a promotion.
     */
    rank: smallint('rank').notNull(),
    isPublic: boolean('is_public').notNull().default(true),
    trialDays: smallint('trial_days').notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('uq_plans_rank').on(table.rank)],
);

export type FeatureKind = 'limit' | 'flag' | 'metered';

export const features = pgTable('features', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull().$type<FeatureKind>(),
  unit: text('unit'),
  createdAt,
});

export const planFeatures = pgTable(
  'plan_features',
  {
    planCode: text('plan_code')
      .notNull()
      .references(() => plans.code, { onDelete: 'cascade' }),
    featureKey: text('feature_key')
      .notNull()
      .references(() => features.key, { onDelete: 'cascade' }),

    /**
     * Null means unlimited, which is different from 0 and must stay
     * distinguishable: a plan with no campaigns and a plan with unlimited
     * campaigns are not the same plan.
     */
    limitValue: bigint('limit_value', { mode: 'number' }),
    flagValue: boolean('flag_value'),

    overageAllowed: boolean('overage_allowed').notNull().default(false),
    overageHardCapMultiple: numeric('overage_hard_cap_multiple', { precision: 4, scale: 1 })
      .notNull()
      .default('3.0'),
  },
  (table) => [primaryKey({ columns: [table.planCode, table.featureKey] })],
);

export type PriceInterval = 'month' | 'year';

export const prices = pgTable(
  'prices',
  {
    id: text('id').primaryKey(),
    planCode: text('plan_code')
      .notNull()
      .references(() => plans.code, { onDelete: 'restrict' }),
    provider: text('provider').notNull().default('stripe'),
    providerPriceId: text('provider_price_id').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    unitAmount: integer('unit_amount').notNull(),
    interval: text('interval').notNull().$type<PriceInterval>(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt,
  },
  (table) => [uniqueIndex('uq_prices_provider').on(table.provider, table.providerPriceId)],
);

// ----------------------------------------------------------- the mapping

export type BillingCustomerStatus = 'pending' | 'active' | 'failed';

export const billingCustomers = pgTable(
  'billing_customers',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    provider: text('provider').notNull().default('stripe'),
    /** Null until Stripe has answered. That null is the whole point of R18. */
    providerCustomerId: text('provider_customer_id'),
    status: text('status').notNull().default('pending').$type<BillingCustomerStatus>(),
    email: text('email'),
    /**
     * The invoice identity a customer edits on I8 (migration 0022).
     *
     * Null until they fill it in: a workspace has a billing customer row from
     * the moment before Stripe is first called (R18), and none of this is
     * known then. `address` is one text column rather than the structured set
     * Stripe Tax wants — see the migration for why, and for what has to
     * change before tax is calculated.
     */
    company: text('company'),
    address: text('address'),
    taxId: text('tax_id'),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('uq_bc_workspace').on(table.workspaceId, table.provider),
    uniqueIndex('uq_bc_provider_id')
      .on(table.provider, table.providerCustomerId)
      .where(sql`provider_customer_id IS NOT NULL`),
  ],
);

// ------------------------------------------------------------- the money

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    billingCustomerId: uuid('billing_customer_id')
      .notNull()
      .references(() => billingCustomers.id, { onDelete: 'cascade' }),
    planCode: text('plan_code')
      .notNull()
      .references(() => plans.code, { onDelete: 'restrict' }),

    provider: text('provider').notNull().default('stripe'),
    providerSubscriptionId: text('provider_subscription_id').notNull(),

    status: text('status').notNull().$type<SubscriptionStatus>(),

    currentPeriodStart: ts('current_period_start').notNull(),
    currentPeriodEnd: ts('current_period_end').notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: ts('canceled_at'),
    trialEnd: ts('trial_end'),

    /** The dunning clock. Set when an invoice first fails, cleared when one is paid. */
    gracePeriodEnd: ts('grace_period_end'),

    /**
     * A downgrade takes effect at period end. Stored rather than applied, so
     * the customer keeps what they paid for until the period they paid for
     * ends.
     */
    scheduledPlanCode: text('scheduled_plan_code').references(() => plans.code, {
      onDelete: 'restrict',
    }),
    scheduledChangeAt: ts('scheduled_change_at'),

    /**
     * Out-of-order webhooks are routine. A write whose version is not greater
     * than this one is discarded.
     */
    providerStateVersion: bigint('provider_state_version', { mode: 'number' })
      .notNull()
      .default(0),

    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('uq_sub_provider').on(table.provider, table.providerSubscriptionId),
    /**
     * One active subscription per workspace. Partial rather than total: a
     * workspace that cancelled and resubscribed has two rows and only one of
     * them is live, and a total unique index would refuse the second signup.
     */
    uniqueIndex('uq_sub_active_ws')
      .on(table.workspaceId)
      .where(sql`status IN ('trialing', 'active', 'past_due', 'unpaid')`),
    index('ix_sub_grace').on(table.gracePeriodEnd).where(sql`grace_period_end IS NOT NULL`),
    index('ix_sub_scheduled')
      .on(table.scheduledChangeAt)
      .where(sql`scheduled_change_at IS NOT NULL`),
  ],
);

export const subscriptionItems = pgTable(
  'subscription_items',
  {
    id: uuid('id').primaryKey(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    providerItemId: text('provider_item_id').notNull(),
    priceId: text('price_id').references(() => prices.id, { onDelete: 'set null' }),
    quantity: integer('quantity').notNull().default(1),
    isMetered: boolean('is_metered').notNull().default(false),
    createdAt,
  },
  (table) => [uniqueIndex('uq_si_provider').on(table.providerItemId)],
);

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    billingCustomerId: uuid('billing_customer_id')
      .notNull()
      .references(() => billingCustomers.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),

    provider: text('provider').notNull().default('stripe'),
    providerInvoiceId: text('provider_invoice_id').notNull(),
    number: text('number'),

    status: text('status').notNull().$type<InvoiceStatus>(),
    currency: char('currency', { length: 3 }).notNull(),
    subtotal: integer('subtotal').notNull(),
    tax: integer('tax').notNull().default(0),
    total: integer('total').notNull(),
    amountPaid: integer('amount_paid').notNull().default(0),
    amountDue: integer('amount_due').notNull().default(0),

    periodStart: ts('period_start'),
    periodEnd: ts('period_end'),
    dueAt: ts('due_at'),
    paidAt: ts('paid_at'),

    hostedInvoiceUrl: text('hosted_invoice_url'),
    pdfUrl: text('pdf_url'),

    providerStateVersion: bigint('provider_state_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('uq_invoice_provider').on(table.provider, table.providerInvoiceId),
    index('ix_invoices_ws').on(table.workspaceId, table.createdAt.desc()),
  ],
);

export type PaymentStatus =
  | 'succeeded'
  | 'processing'
  | 'requires_action'
  | 'failed'
  | 'canceled';

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    provider: text('provider').notNull().default('stripe'),
    providerPaymentId: text('provider_payment_id').notNull(),
    status: text('status').notNull().$type<PaymentStatus>(),
    amount: integer('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    providerStateVersion: bigint('provider_state_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt,
  },
  (table) => [uniqueIndex('uq_payment_provider').on(table.provider, table.providerPaymentId)],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    provider: text('provider').notNull().default('stripe'),
    providerRefundId: text('provider_refund_id').notNull(),
    amount: integer('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    reason: text('reason'),
    createdAt,
  },
  (table) => [uniqueIndex('uq_refund_provider').on(table.provider, table.providerRefundId)],
);

export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    billingCustomerId: uuid('billing_customer_id')
      .notNull()
      .references(() => billingCustomers.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('stripe'),
    providerPaymentMethodId: text('provider_payment_method_id').notNull(),
    /** Display only. We never see a PAN; Stripe does not give us one. */
    brand: text('brand'),
    last4: char('last4', { length: 4 }),
    expMonth: smallint('exp_month'),
    expYear: smallint('exp_year'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt,
  },
  (table) => [
    uniqueIndex('uq_pm_provider').on(table.provider, table.providerPaymentMethodId),
    // Partial. Without the predicate this would allow one payment method per
    // workspace rather than one default.
    uniqueIndex('uq_pm_default').on(table.workspaceId).where(sql`is_default`),
  ],
);

export type CouponDuration = 'once' | 'repeating' | 'forever';

export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull().default('stripe'),
    providerCouponId: text('provider_coupon_id').notNull(),
    code: text('code'),
    percentOff: numeric('percent_off', { precision: 5, scale: 2 }),
    amountOff: integer('amount_off'),
    currency: char('currency', { length: 3 }),
    duration: text('duration').$type<CouponDuration>(),
    durationInMonths: smallint('duration_in_months'),
    createdAt,
  },
  (table) => [uniqueIndex('uq_coupon_provider').on(table.provider, table.providerCouponId)],
);

export const discounts = pgTable('discounts', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' })
    .$type<WorkspaceId>(),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
    onDelete: 'cascade',
  }),
  couponId: uuid('coupon_id')
    .notNull()
    .references(() => coupons.id, { onDelete: 'restrict' }),
  startsAt: ts('starts_at').notNull().default(sql`now()`),
  endsAt: ts('ends_at'),
  createdAt,
});

// --------------------------------------------------------- what we enforce

/**
 * A rebuildable projection of subscriptions x plan_features.
 *
 * Nothing may read a plan code to make a decision; the gate reads this table,
 * which is what lets a plan change take effect everywhere at once. R28: the
 * launch transaction reads the row `FOR SHARE`, so a downgrade committing
 * concurrently cannot change the limit underneath a snapshot.
 */
export const entitlements = pgTable(
  'entitlements',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    featureKey: text('feature_key')
      .notNull()
      .references(() => features.key, { onDelete: 'cascade' }),

    /** Null means unlimited. Distinct from 0. */
    limitValue: bigint('limit_value', { mode: 'number' }),
    flagValue: boolean('flag_value'),

    sourceSubscriptionId: uuid('source_subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    sourcePlanCode: text('source_plan_code').references(() => plans.code, {
      onDelete: 'set null',
    }),

    computedAt: ts('computed_at').notNull().default(sql`now()`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.featureKey] }),
    index('ix_entitlements_source')
      .on(table.sourceSubscriptionId)
      .where(sql`source_subscription_id IS NOT NULL`),
  ],
);

/**
 * The counter the entitlement gate reads, with R15's watermark.
 *
 * `last_usage_record_id` is what makes aggregation idempotent: the pass reads
 * `usage_records` at `id > watermark` and advances it in the same
 * transaction. Running three times produces the totals of running once, which
 * is the difference between a billing job that can be retried and one that
 * cannot.
 */
export const usageAggregates = pgTable(
  'usage_aggregates',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    featureKey: text('feature_key')
      .notNull()
      .references(() => features.key, { onDelete: 'cascade' }),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),

    used: bigint('used', { mode: 'number' }).notNull().default(0),
    included: bigint('included', { mode: 'number' }),
    overage: bigint('overage', { mode: 'number' }).notNull().default(0),

    /** R15. UUIDv7 is time-ordered, so `>` over it is a stable cursor. */
    lastUsageRecordId: uuid('last_usage_record_id'),

    reportedToProviderAt: ts('reported_to_provider_at'),
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.featureKey, table.periodStart] }),
    index('ix_ua_period').on(table.periodEnd).where(sql`reported_to_provider_at IS NULL`),
  ],
);

// ------------------------------------------------------------- the plumbing

/**
 * The webhook inbox (R17).
 *
 * The handler verifies, inserts here, returns 200, and marks the object
 * dirty. It never calls Stripe inline — 500 events for one object would
 * otherwise be 500 API calls inside 500 HTTP handlers.
 */
export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull().default('stripe'),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),

    /**
     * Nullable: an event may arrive before we know which workspace it belongs
     * to, and refusing it would lose it.
     */
    workspaceId: uuid('workspace_id').$type<WorkspaceId>(),

    payload: jsonb('payload').notNull(),
    signatureVerifiedAt: ts('signature_verified_at').notNull().default(sql`now()`),
    processedAt: ts('processed_at'),
    processError: text('process_error'),
    receivedAt: ts('received_at').notNull().default(sql`now()`),
  },
  (table) => [
    // The idempotency key for the whole billing webhook path.
    uniqueIndex('uq_pwe_provider_event').on(table.provider, table.providerEventId),
    index('ix_pwe_unprocessed').on(table.receivedAt).where(sql`processed_at IS NULL`),
  ],
);

/** R17: the coalescing queue. One row per object, not per event. */
export const billingRefetchQueue = pgTable(
  'billing_refetch_queue',
  {
    provider: text('provider').notNull().default('stripe'),
    objectType: text('object_type').notNull(),
    providerObjectId: text('provider_object_id').notNull(),

    workspaceId: uuid('workspace_id').$type<WorkspaceId>(),
    /**
     * Bumped by every event for this object. 500 events leave one row with
     * `dirty_count = 500`, and the consumer makes one API call.
     */
    dirtyCount: integer('dirty_count').notNull().default(1),
    firstDirtyAt: ts('first_dirty_at').notNull().default(sql`now()`),
    lastDirtyAt: ts('last_dirty_at').notNull().default(sql`now()`),

    /** The rate bound: no fetch of an object fetched less than 30 seconds ago. */
    lastFetchedAt: ts('last_fetched_at'),
    fetchFailures: smallint('fetch_failures').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.objectType, table.providerObjectId] }),
    index('ix_brq_due')
      .on(table.lastDirtyAt)
      .where(sql`last_fetched_at IS NULL OR last_dirty_at > last_fetched_at`),
  ],
);

/**
 * The workspace-visible billing timeline.
 *
 * Not an audit log — this is what a customer sees on their billing page, in
 * their language.
 */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    eventType: text('event_type').notNull(),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    occurredAt: ts('occurred_at').notNull().default(sql`now()`),
  },
  (table) => [index('ix_billing_events_ws').on(table.workspaceId, table.occurredAt.desc())],
);

/** R19: what the nightly reconciler did, so a divergence can be investigated. */
export const billingReconciliationRuns = pgTable('billing_reconciliation_runs', {
  id: uuid('id').primaryKey(),
  startedAt: ts('started_at').notNull().default(sql`now()`),
  finishedAt: ts('finished_at'),
  objectsChecked: integer('objects_checked').notNull().default(0),
  divergencesFound: integer('divergences_found').notNull().default(0),
  divergencesCorrected: integer('divergences_corrected').notNull().default(0),
  detail: jsonb('detail').notNull().default(sql`'[]'::jsonb`),
  error: text('error'),
});
