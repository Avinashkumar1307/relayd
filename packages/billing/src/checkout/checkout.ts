import type { BillingProviderAdapter, CheckoutSession } from '../port.js';

/**
 * Starting a subscription (INVARIANTS R18, review finding F18).
 *
 * The ordering is the whole of it, and it is the opposite of the natural one:
 *
 *   1. Write `billing_customers` locally with status `pending`.
 *   2. Call Stripe to create the customer.
 *   3. Write the returned id back, status `active`.
 *   4. Create the Checkout Session, carrying our id in two places.
 *
 * The natural order — create in Stripe, then store what comes back — loses
 * the mapping when the process dies between the two. What is left is a Stripe
 * customer that will happily be charged and that nothing can connect to a
 * workspace, and the only way to find it is to read every customer in the
 * account by hand.
 *
 * Doing it this way, the same crash leaves a `pending` row: visible, obviously
 * incomplete, and finishable by the reconciler. The cost is a row that may
 * never be completed, which is a cheap thing to have.
 *
 * Step 4 carries `client_reference_id = workspaceId` **and**
 * `metadata.billing_customer_id`. Both, because the webhook resolves through
 * metadata and must never create a mapping of its own — a webhook that could
 * create one would recreate exactly the ambiguity this ordering removes.
 */

export type CheckoutFailure =
  | 'already_subscribed'
  | 'unknown_plan'
  | 'plan_not_self_serve'
  | 'no_price'
  | 'provider_failed';

export interface CheckoutPort {
  /** The workspace's live subscription, if it has one. */
  activeSubscription(workspaceId: string): Promise<{ id: string; planCode: string } | null>;

  /** The existing mapping, in whatever state it is in. */
  findBillingCustomer(workspaceId: string): Promise<{
    id: string;
    providerCustomerId: string | null;
    status: 'pending' | 'active' | 'failed';
  } | null>;

  /** R18 step 1. Written before Stripe is called. */
  createPendingBillingCustomer(input: {
    id: string;
    workspaceId: string;
    email: string;
  }): Promise<void>;

  /** R18 step 3. */
  attachProviderCustomer(input: {
    billingCustomerId: string;
    providerCustomerId: string;
  }): Promise<void>;

  markBillingCustomerFailed(input: { billingCustomerId: string; reason: string }): Promise<void>;

  /** The active price for a plan and interval. */
  findPrice(input: { planCode: string; interval: 'month' | 'year' }): Promise<{
    id: string;
    providerPriceId: string;
  } | null>;

  recordEvent(input: { workspaceId: string; eventType: string; detail: unknown }): Promise<void>;
}

export interface CheckoutResult {
  ok: boolean;
  session?: CheckoutSession;
  failure?: CheckoutFailure;
  message?: string;
}

export interface StartCheckoutInput {
  workspaceId: string;
  email: string;
  planCode: string;
  interval: 'month' | 'year';
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
  /** Supplied so the id is known before the row is written. */
  newBillingCustomerId: string;
  /** Plans a customer may select. Passed in so this file holds no plan codes. */
  isSelfServe: (planCode: string) => boolean;
}

export async function startCheckout(
  input: StartCheckoutInput,
  port: CheckoutPort,
  provider: BillingProviderAdapter,
): Promise<CheckoutResult> {
  if (!input.isSelfServe(input.planCode)) {
    // An enterprise plan reaching here would mean somebody posted a plan code
    // the pricing page never offered.
    return {
      ok: false,
      failure: 'plan_not_self_serve',
      message: 'That plan is not available for self-service signup',
    };
  }

  // A second subscription for one workspace bills twice and is discovered at
  // renewal. `uq_sub_active_ws` refuses it at the database too; this refuses
  // it before the customer has entered a card.
  if ((await port.activeSubscription(input.workspaceId)) !== null) {
    return {
      ok: false,
      failure: 'already_subscribed',
      message: 'This workspace already has an active subscription',
    };
  }

  const price = await port.findPrice({ planCode: input.planCode, interval: input.interval });
  if (price === null) {
    return { ok: false, failure: 'no_price', message: 'That plan has no price for this interval' };
  }

  const customer = await ensureProviderCustomer(input, port, provider);
  if (customer === null) {
    return {
      ok: false,
      failure: 'provider_failed',
      message: 'The payment provider could not be reached. Nothing has been charged.',
    };
  }

  try {
    const session = await provider.createCheckoutSession({
      providerCustomerId: customer.providerCustomerId,
      // Both identifiers, per R18. The webhook resolves through metadata and
      // never creates a mapping.
      billingCustomerId: customer.billingCustomerId,
      workspaceId: input.workspaceId,
      priceId: price.providerPriceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      ...(input.trialDays === undefined ? {} : { trialDays: input.trialDays }),
    });

    await port.recordEvent({
      workspaceId: input.workspaceId,
      eventType: 'checkout.started',
      detail: { planCode: input.planCode, interval: input.interval },
    });

    return { ok: true, session };
  } catch {
    // The customer exists and is reusable; only the session failed. Leaving
    // the mapping alone means a retry costs one API call rather than
    // creating a second Stripe customer.
    return {
      ok: false,
      failure: 'provider_failed',
      message: 'The payment provider could not start a checkout session',
    };
  }
}

/**
 * The R18 dance, and the one place a `pending` row is resolved.
 *
 * Reuses an existing mapping when there is one — including a `pending` one,
 * which is what makes a retry after a crash finish the job rather than
 * creating a second Stripe customer for the same workspace.
 */
async function ensureProviderCustomer(
  input: StartCheckoutInput,
  port: CheckoutPort,
  provider: BillingProviderAdapter,
): Promise<{ billingCustomerId: string; providerCustomerId: string } | null> {
  const existing = await port.findBillingCustomer(input.workspaceId);

  if (existing !== null && existing.providerCustomerId !== null) {
    return {
      billingCustomerId: existing.id,
      providerCustomerId: existing.providerCustomerId,
    };
  }

  // Either there is no row, or there is a `pending` one whose Stripe call
  // never completed. Both are finished the same way.
  const billingCustomerId = existing?.id ?? input.newBillingCustomerId;

  if (existing === null) {
    // Step 1. Before Stripe, always.
    await port.createPendingBillingCustomer({
      id: billingCustomerId,
      workspaceId: input.workspaceId,
      email: input.email,
    });
  }

  try {
    const created = await provider.createCustomer({
      billingCustomerId,
      workspaceId: input.workspaceId,
      email: input.email,
    });

    await port.attachProviderCustomer({
      billingCustomerId,
      providerCustomerId: created.id,
    });

    return { billingCustomerId, providerCustomerId: created.id };
  } catch (error) {
    // The row stays. Marked failed rather than deleted, because a deleted row
    // loses the evidence that we may already have created a Stripe customer
    // whose id we never received.
    await port.markBillingCustomerFailed({
      billingCustomerId,
      reason: error instanceof Error ? error.message : 'unknown',
    });

    return null;
  }
}

/**
 * What `/billing/success` should do while it waits.
 *
 * The frontend never trusts the redirect (CLAUDE.md §10). Stripe redirects
 * the browser as soon as payment succeeds, and the webhook that creates the
 * subscription row may not have arrived — so the page polls our API until the
 * row exists, and falls back to a server-side session lookup after ten
 * seconds.
 *
 * The fallback matters more than it looks: a customer whose webhook is
 * delayed by a Stripe incident otherwise sits on a spinner having just been
 * charged.
 */
export const SUCCESS_POLL_INTERVAL_MS = 1_000;
export const SUCCESS_FALLBACK_AFTER_MS = 10_000;
export const SUCCESS_GIVE_UP_AFTER_MS = 60_000;

export function successPollPlan(elapsedMs: number): 'poll' | 'fallback' | 'give_up' {
  if (elapsedMs >= SUCCESS_GIVE_UP_AFTER_MS) return 'give_up';
  if (elapsedMs >= SUCCESS_FALLBACK_AFTER_MS) return 'fallback';
  return 'poll';
}
