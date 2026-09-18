/**
 * The billing provider port.
 *
 * One provider, Stripe, and deliberately no abstraction for a hypothetical
 * second one (D1, CLAUDE.md §2). This interface exists for a different
 * reason: so that everything above it can be tested without a network, and so
 * that the Stripe SDK is confined to `packages/billing/adapters` where the
 * lint rule can see it.
 *
 * The shapes below are ours, not Stripe's. An adapter translates. That is
 * what lets a Stripe API version bump be a change in one directory rather
 * than a change everywhere a subscription is read.
 */

export type ObjectType =
  | 'customer'
  | 'subscription'
  | 'invoice'
  | 'payment_intent'
  | 'charge'
  | 'payment_method';

/**
 * A provider event, after signature verification and normalisation.
 *
 * `payload` is kept whole for the inbox, but nothing downstream reads it to
 * decide anything — the handler re-fetches the object instead. See
 * `refetch.ts` for why.
 */
export interface NormalisedBillingEvent {
  providerEventId: string;
  type: string;
  objectType: ObjectType | null;
  providerObjectId: string | null;
  /** From `metadata.billing_customer_id` or `client_reference_id` (R18). */
  billingCustomerId: string | null;
  workspaceId: string | null;
  createdAt: Date;
  payload: unknown;
}

export interface ProviderCustomer {
  id: string;
  email: string | null;
  deleted: boolean;
}

export interface ProviderSubscription {
  id: string;
  customerId: string;
  status:
    | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled'
    | 'incomplete' | 'incomplete_expired' | 'paused';
  /** The price the subscription is on, which the adapter maps to a plan. */
  priceIds: string[];
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  trialEnd: Date | null;
  /**
   * The monotonic version used to discard stale writes.
   *
   * Stripe has no version field, so the adapter synthesises one from the
   * object's own timestamps. That is the adapter's job precisely because the
   * choice is provider-specific and the rule above it is not.
   */
  stateVersion: number;
  items: { id: string; priceId: string; quantity: number; isMetered: boolean }[];
}

export interface ProviderInvoice {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  amountDue: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  stateVersion: number;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: Date;
}

export interface BillingProviderAdapter {
  /**
   * Verifies a webhook signature over the raw bytes.
   *
   * Raw bytes, never a parsed body: every signature scheme signs what was
   * sent, and re-serialising parsed JSON changes it. `apps/edge` mounts this
   * before any JSON parser for that reason.
   */
  verifyWebhook(input: {
    rawBody: Buffer;
    signature: string;
  }): Promise<NormalisedBillingEvent>;

  createCustomer(input: {
    /** Ours. Carried in metadata so a webhook can resolve without a lookup (R18). */
    billingCustomerId: string;
    workspaceId: string;
    email: string;
    name?: string;
  }): Promise<ProviderCustomer>;

  /**
   * A Checkout Session.
   *
   * `clientReferenceId` and `metadata.billing_customer_id` are both set, and
   * both are required by R18: the webhook resolves through metadata and never
   * creates a mapping of its own.
   */
  createCheckoutSession(input: {
    providerCustomerId: string;
    billingCustomerId: string;
    workspaceId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number;
  }): Promise<CheckoutSession>;

  createPortalSession(input: {
    providerCustomerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  fetchSubscription(id: string): Promise<ProviderSubscription | null>;
  fetchInvoice(id: string): Promise<ProviderInvoice | null>;
  fetchCustomer(id: string): Promise<ProviderCustomer | null>;

  /**
   * Changes the plan on an existing subscription.
   *
   * Modifies rather than creating a second subscription — docs/05 is explicit,
   * and two live subscriptions for one workspace bills twice and is
   * discovered at renewal.
   */
  updateSubscriptionPrice(input: {
    providerSubscriptionId: string;
    priceId: string;
    /** Immediate with proration for an upgrade; at period end for a downgrade. */
    prorate: boolean;
  }): Promise<ProviderSubscription>;

  cancelSubscription(input: {
    providerSubscriptionId: string;
    atPeriodEnd: boolean;
  }): Promise<ProviderSubscription>;

  /** Reports metered usage for an overage item. */
  reportUsage(input: {
    providerItemId: string;
    quantity: number;
    timestamp: Date;
    /** Set, so a retried report replaces rather than adds. */
    idempotencyKey: string;
  }): Promise<void>;

  /** R19: objects the provider changed recently, for the nightly reconciler. */
  listRecentlyChangedSubscriptions(since: Date): Promise<ProviderSubscription[]>;
}

/**
 * A provider call that failed.
 *
 * Scrubbed at the adapter boundary like the email providers', and for the
 * same reason: Stripe's errors carry the request and sometimes the key.
 */
export class BillingProviderError extends Error {
  constructor(
    readonly kind:
      | 'auth_failed'
      | 'rate_limited'
      | 'invalid_request'
      | 'card_declined'
      | 'provider_unavailable'
      | 'not_found'
      | 'unknown',
    message: string,
    readonly retryable: boolean,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'BillingProviderError';
  }
}
