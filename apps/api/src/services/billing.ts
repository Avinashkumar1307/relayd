import {
  canUseFeature,
  cancelSubscription,
  changePlan,
  checkUsage,
  overageFor,
  planByCode,
  precheckDowngrade,
  selfServePlans,
  startCheckout,
  statusForDenial,
  successPollPlan,
  type BillingProviderAdapter,
  type CheckoutPort,
  type Decision,
  type FeatureKey,
  type Grant,
  type Interval,
  type PlanChangePort,
  type WorkspaceBillingState,
} from '@relayd/billing';
import { AppError } from '@relayd/types';
import type { ErrorCode, ErrorDetail } from '@relayd/types';
import type { WorkspaceScope } from '@relayd/db';

/**
 * Billing (docs/05, CLAUDE.md section 10).
 *
 * Stripe owns money objects: charges, invoices, subscription status, refunds,
 * payment methods. We own plans, features, limits, entitlements, usage and the
 * workspace-to-Stripe mapping. Nothing in this service computes an amount, and
 * nothing here decides whether a payment succeeded — both come back from the
 * webhook path as a mirror of what Stripe already decided.
 *
 * Two rules the routes above this rely on:
 *
 *   **Every entitlement check is server-side**, inside the transaction of the
 *   action it gates. The read-only checks this service exposes are for showing
 *   a customer where they stand, never for deciding whether to allow
 *   something — a client that has been told "you have room" and then acts on
 *   it is a client that can be lied to.
 *
 *   **The success page is not trusted.** Stripe redirects the browser as soon
 *   as payment succeeds, and the webhook that creates the subscription row may
 *   not have arrived. `checkoutStatus` polls for the row and falls back to a
 *   server-side session lookup after ten seconds, so a customer whose webhook
 *   is delayed by a Stripe incident is not left on a spinner having just been
 *   charged.
 */

export interface BillingRepositories {
  billing: BillingRepositoryLike;
}

/**
 * What the service needs from the database.
 *
 * Deliberately not `any` repository: this names the calls, so a repository
 * method added for something else does not silently become reachable from a
 * billing route.
 */
export interface BillingRepositoryLike {
  readEntitlements(scope: WorkspaceScope): Promise<Grant[]>;
  readBillingState(scope: WorkspaceScope): Promise<WorkspaceBillingState>;

  currentSubscription(scope: WorkspaceScope): Promise<{
    id: string;
    providerSubscriptionId: string;
    planCode: string;
    interval: Interval;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    scheduledPlanCode: string | null;
    scheduledChangeAt: Date | null;
    trialEnd: Date | null;
  } | null>;

  usageForPeriod(scope: WorkspaceScope): Promise<
    { featureKey: string; used: number; included: number | null; periodEnd: Date }[]
  >;

  currentUsageByFeature(scope: WorkspaceScope): Promise<Partial<Record<FeatureKey, number>>>;

  listInvoices(
    scope: WorkspaceScope,
    input: { limit: number; before?: Date },
  ): Promise<
    {
      id: string;
      number: string | null;
      status: string;
      currency: string;
      total: number;
      amountDue: number;
      periodStart: Date | null;
      periodEnd: Date | null;
      paidAt: Date | null;
      hostedInvoiceUrl: string | null;
      pdfUrl: string | null;
      createdAt: Date;
    }[]
  >;

  defaultPaymentMethod(scope: WorkspaceScope): Promise<{
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  } | null>;

  providerCustomerId(scope: WorkspaceScope): Promise<string | null>;

  /**
   * The address Stripe should send receipts to: the workspace owner's.
   *
   * Read server-side rather than accepted from the request. A client that
   * could choose it could create a Stripe customer carrying somebody else's
   * address, and `billing:write` is owner-only anyway — so the owner is both
   * the right answer and the only caller.
   */
  billingEmail(scope: WorkspaceScope): Promise<string | null>;

  /**
   * The invoice identity a customer edits on I8, or null before they have
   * ever saved one. Backed by `billing_customers` (migration 0022).
   */
  billingDetails(scope: WorkspaceScope): Promise<BillingDetails | null>;

  /**
   * Writes it, creating the billing customer row if there is not one yet.
   *
   * Creating it here is the R18 ordering seen from the other side: the row
   * exists before Stripe knows anything about it, and a customer who enters
   * their VAT id before they ever reach checkout is the ordinary case.
   */
  saveBillingDetails(
    scope: WorkspaceScope,
    input: BillingDetails & { newBillingCustomerId: string },
  ): Promise<BillingDetails>;
}

/** What I8 shows and edits. No amounts: this is an address, not money. */
export interface BillingDetails {
  email: string;
  company: string;
  address: string;
  taxId: string;
}

/**
 * The two subscription-lifecycle calls I9 and I1b need, which
 * `BillingProviderAdapter` does not declare.
 *
 * Optional, and narrowed here rather than added to the port in
 * `@relayd/billing`, for one reason: that interface is implemented by a fake
 * in every billing test in the repository, and a new required method breaks
 * all of them at once. Adding them properly is an owner-reviewed change to
 * `packages/billing/src/port.ts` and is raised in this batch's report.
 *
 * Until then a deployment whose adapter does not implement them answers 503
 * from the routes below, which is true — the capability is not there — and
 * is not the same as pretending the button worked.
 */
export interface SubscriptionLifecycleAdapter {
  /** Clears a scheduled cancellation. Stripe: `cancel_at_period_end = false`. */
  resumeSubscription?(input: { providerSubscriptionId: string }): Promise<void>;

  /** Attempts payment on an open invoice. Stripe: `invoices.pay`. */
  payInvoice?(input: { providerInvoiceId: string }): Promise<void>;
}

/**
 * Where a request to export everything goes (I9's "Export everything").
 *
 * A job, not a response body. A workspace's contacts, campaigns, events and
 * invoices are gigabytes and are assembled by the `io` worker; the HTTP
 * request's whole job is to record that the customer asked and to answer
 * quickly.
 */
export interface BillingExportQueue {
  enqueue(input: { workspaceId: string; requestedBy: string }): Promise<{ jobId: string }>;
}

export type BillingUnitOfWork = <T>(fn: (repos: BillingRepositories) => Promise<T>) => Promise<T>;

export interface BillingServiceOptions {
  unitOfWork: BillingUnitOfWork;
  provider: BillingProviderAdapter & SubscriptionLifecycleAdapter;
  checkoutPort: (scope: WorkspaceScope) => CheckoutPort;
  planChangePort: (scope: WorkspaceScope) => PlanChangePort;
  /** Supplied so the billing customer id is known before the row is written (R18). */
  newId: () => string;
  appUrl: string;
  /** Absent until the io worker's export queue is wired; the route then 503s. */
  exports?: BillingExportQueue;
  /** Records who asked, for the audit row on a detail change and an export. */
  audit?: BillingAuditPort;
}

/**
 * Where a billing change is recorded so a person can see it later.
 *
 * A port rather than the audit repository directly, because this service
 * already takes its database through `unitOfWork` and the billing
 * repository interface above deliberately names only billing calls — an
 * audit append reached through it would make every repository method
 * reachable from a billing route.
 */
export interface BillingAuditPort {
  record(
    scope: WorkspaceScope,
    entry: { action: string; resourceId: string; before?: unknown; after?: unknown },
  ): Promise<void>;
}

const INVOICE_PAGE = 24;

/**
 * Invoice statuses a retry could act on.
 *
 * `draft` is excluded: a draft has not been finalised and there is nothing
 * to charge. `uncollectible` is included because Stripe marks an invoice so
 * after exhausting its own retries, and the customer fixing their card and
 * pressing "Retry now" is exactly the case that gets it paid.
 */
const UNPAID_STATUSES: ReadonlySet<string> = new Set(['open', 'past_due', 'uncollectible']);

/** The audited form of a detail change: never the tax id itself. */
function redactDetails(details: BillingDetails): Record<string, unknown> {
  return {
    email: details.email,
    company: details.company,
    address: details.address,
    hasTaxId: details.taxId !== '',
  };
}

export class BillingService {
  constructor(private readonly options: BillingServiceOptions) {}

  /** The pricing page. Public plans only — enterprise is provisioned by hand. */
  plans() {
    return selfServePlans().map((plan) => ({
      code: plan.code,
      name: plan.name,
      description: plan.description,
      rank: plan.rank,
      trialDays: plan.trialDays,
      limits: plan.limits,
      flags: plan.flags,
    }));
  }

  /**
   * Everything the billing page renders.
   *
   * One call rather than five, because the page shows them together and five
   * round trips is five chances for the customer to see a half-loaded billing
   * screen.
   */
  async overview(scope: WorkspaceScope) {
    return this.options.unitOfWork(async (repos) => {
      const [subscription, state, usage, paymentMethod, storedDetails, ownerEmail] =
        await Promise.all([
          repos.billing.currentSubscription(scope),
          repos.billing.readBillingState(scope),
          repos.billing.usageForPeriod(scope),
          repos.billing.defaultPaymentMethod(scope),
          repos.billing.billingDetails(scope),
          repos.billing.billingEmail(scope),
        ]);

      return {
        subscription:
          subscription === null
            ? null
            : {
                planCode: subscription.planCode,
                planName: planByCode(subscription.planCode)?.name ?? subscription.planCode,
                interval: subscription.interval,
                status: subscription.status,
                currentPeriodStart: subscription.currentPeriodStart,
                currentPeriodEnd: subscription.currentPeriodEnd,
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                scheduledPlanCode: subscription.scheduledPlanCode,
                scheduledChangeAt: subscription.scheduledChangeAt,
                trialEnd: subscription.trialEnd,
              },
        state,
        usage: usage.map((row) => ({
          featureKey: row.featureKey,
          used: row.used,
          included: row.included,
          overage: overageFor(row.used, row.included),
          periodEnd: row.periodEnd,
        })),
        paymentMethod,
        /**
         * I8's invoice identity, on the payload the page already reads.
         *
         * The form on `/billing/payment-method` seeds itself from
         * `overview.billingDetails` and saves through
         * `PATCH /billing/details`. Leaving it off the overview meant a
         * customer who had saved their VAT id came back to an empty form
         * and could only conclude it had not been kept.
         *
         * Same fallback as `details()`: the owner's address is where
         * receipts go, and `startCheckout` answers the same way, so a
         * workspace that has never opened the form still sees a sensible
         * email rather than a blank one.
         */
        billingDetails:
          storedDetails ?? { email: ownerEmail ?? '', company: '', address: '', taxId: '' },
      };
    });
  }

  /** A read-only view of where the workspace stands. Never a permission. */
  async entitlementCheck(
    scope: WorkspaceScope,
    input: { feature: FeatureKey; requested?: number },
  ): Promise<Decision> {
    return this.options.unitOfWork(async (repos) => {
      const [grants, state, usage] = await Promise.all([
        repos.billing.readEntitlements(scope),
        repos.billing.readBillingState(scope),
        repos.billing.usageForPeriod(scope),
      ]);

      const used = usage.find((row) => row.featureKey === input.feature)?.used ?? 0;

      return input.requested === undefined
        ? canUseFeature(input.feature, grants, state)
        : checkUsage(input.feature, { used, requested: input.requested }, grants, state);
    });
  }

  /** Starts a Checkout Session. R18's ordering lives in `@relayd/billing`. */
  async startCheckout(
    scope: WorkspaceScope,
    input: { planCode: string; interval: Interval; trialDays?: number },
  ) {
    const email = await this.options.unitOfWork((repos) => repos.billing.billingEmail(scope));

    if (email === null) {
      // No owner to bill. Nothing useful can be done with a Stripe customer
      // that has no address, and inventing one would put receipts nowhere.
      throw new AppError('not_found', 'This workspace has no billing contact', 404);
    }

    const result = await startCheckout(
      {
        workspaceId: scope.workspaceId as string,
        email,
        planCode: input.planCode,
        interval: input.interval,
        successUrl: `${this.options.appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${this.options.appUrl}/billing/cancel`,
        newBillingCustomerId: this.options.newId(),
        isSelfServe: (code) => planByCode(code)?.isPublic === true,
        ...(input.trialDays === undefined ? {} : { trialDays: input.trialDays }),
      },
      this.options.checkoutPort(scope),
      this.options.provider,
    );

    if (!result.ok) {
      const { code, status } = checkoutError(result.failure);
      throw new AppError(code, result.message ?? 'Checkout could not be started', status);
    }

    return result.session;
  }

  /**
   * What `/billing/success` should do next.
   *
   * The frontend calls this on a timer with how long it has been waiting, and
   * does what it is told. Keeping the decision here means the give-up
   * threshold is not a number somebody has to remember to change in two
   * places.
   */
  async checkoutStatus(scope: WorkspaceScope, input: { elapsedMs: number }) {
    return this.options.unitOfWork(async (repos) => {
      const subscription = await repos.billing.currentSubscription(scope);

      if (subscription !== null) {
        return { ready: true as const, planCode: subscription.planCode, action: 'done' as const };
      }

      return {
        ready: false as const,
        // Not clamped. Every out-of-range value — negative, NaN — already
        // lands on `poll`, which is the safe answer, and Infinity lands on
        // `give_up`, which is the right one. A clamp here would be a guard
        // that changes nothing.
        action: successPollPlan(input.elapsedMs),
      };
    });
  }

  /** The Stripe billing portal, for card changes and invoice history. */
  async portalSession(scope: WorkspaceScope) {
    const customerId = await this.options.unitOfWork((repos) =>
      repos.billing.providerCustomerId(scope),
    );

    if (customerId === null) {
      throw new AppError('not_found', 'This workspace has no billing customer yet', 404);
    }

    return this.options.provider.createPortalSession({
      providerCustomerId: customerId,
      returnUrl: `${this.options.appUrl}/billing`,
    });
  }

  /**
   * The downgrade pre-check, as its own endpoint.
   *
   * The UI calls it before showing a confirm dialog, so the customer learns
   * what they would have to delete before they commit rather than after.
   */
  async planChangePreview(scope: WorkspaceScope, input: { planCode: string }) {
    const plan = planByCode(input.planCode);
    if (plan === null) throw new AppError('not_found', 'No such plan', 404);

    return this.options.unitOfWork(async (repos) => {
      const [subscription, usage] = await Promise.all([
        repos.billing.currentSubscription(scope),
        repos.billing.currentUsageByFeature(scope),
      ]);

      const precheck = precheckDowngrade({ targetPlanCode: input.planCode, currentUsage: usage });

      return {
        from: subscription?.planCode ?? null,
        to: input.planCode,
        blocked: precheck.blocked,
        conflicts: precheck.conflicts,
      };
    });
  }

  async changePlan(scope: WorkspaceScope, input: { planCode: string; interval: Interval }) {
    const result = await changePlan(
      {
        workspaceId: scope.workspaceId as string,
        toPlanCode: input.planCode,
        toInterval: input.interval,
        isSelfServe: (code) => planByCode(code)?.isPublic === true,
      },
      this.options.planChangePort(scope),
      this.options.provider,
    );

    if (!result.ok) {
      if (result.failure === 'plan_downgrade_blocked') {
        // 422 with the specific offending features, per docs/05. "You cannot
        // downgrade" with no explanation is a support ticket, and the customer
        // usually can once they know what to delete.
        throw new AppError(
          'plan_downgrade_blocked',
          result.message ?? 'Current usage exceeds the target plan',
          422,
          conflictDetails(result.conflicts ?? []),
        );
      }

      const { code, status } = planChangeError(result.failure);
      throw new AppError(code, result.message ?? 'The plan could not be changed', status);
    }

    return {
      direction: result.direction,
      appliesAt: result.appliesAt,
      effectiveAt: result.effectiveAt ?? null,
    };
  }

  async cancel(scope: WorkspaceScope, input: { immediately: boolean }) {
    const result = await cancelSubscription(
      { workspaceId: scope.workspaceId as string, immediately: input.immediately },
      this.options.planChangePort(scope),
      this.options.provider,
    );

    if (!result.ok) {
      throw result.failure === 'no_subscription'
        ? new AppError('not_found', 'This workspace has no subscription', 404)
        : new AppError(
            'provider_unavailable',
            result.message ?? 'The subscription could not be cancelled',
            502,
          );
    }

    return { endsAt: result.endsAt ?? null };
  }

  /**
   * I9b's "Reactivate": undo a cancellation that has not happened yet.
   *
   * **Nothing here writes subscription state.** It tells Stripe to clear the
   * scheduled cancellation and stops. `customer.subscription.updated` then
   * arrives carrying the authoritative `cancel_at_period_end`, and the
   * webhook path writes it — exactly as `cancelSubscription` in
   * `@relayd/billing` does, and for the same reason: a local guess is a
   * second source of truth for a flag Stripe owns, and the two disagree the
   * first time a call fails after the write.
   *
   * The browser knows this and polls; `billingApi.reactivate` invalidates the
   * overview rather than trusting the response.
   */
  async reactivate(scope: WorkspaceScope): Promise<{ ok: true }> {
    const resume = this.options.provider.resumeSubscription;
    if (resume === undefined) {
      throw new AppError(
        'service_unavailable',
        'Reactivating a subscription is not available on this deployment yet',
        503,
      );
    }

    const subscription = await this.options.unitOfWork((repos) =>
      repos.billing.currentSubscription(scope),
    );

    if (subscription === null) {
      throw new AppError('not_found', 'This workspace has no subscription', 404);
    }

    if (!subscription.cancelAtPeriodEnd) {
      // Not an error the customer caused, and not something to retry. 409
      // rather than 200: the button they pressed said "reactivate", and
      // answering ok to a no-op teaches them it did something.
      throw new AppError('conflict', 'This subscription is not scheduled to cancel', 409);
    }

    try {
      await resume.call(this.options.provider, {
        providerSubscriptionId: subscription.providerSubscriptionId,
      });
    } catch {
      throw new AppError(
        'provider_unavailable',
        'The payment provider could not reactivate the subscription',
        502,
      );
    }

    await this.options.planChangePort(scope).recordEvent({
      workspaceId: scope.workspaceId as string,
      eventType: 'subscription.reactivated',
      detail: { planCode: subscription.planCode },
    });

    return { ok: true };
  }

  /**
   * I1b's "Retry now": ask Stripe to charge the past-due invoice again.
   *
   * The invoice is chosen server-side from what we mirror of Stripe rather
   * than named by the client. A client that could name an invoice could ask
   * us to charge a different workspace's, and the workspace scope on the
   * read is the only thing standing between those two requests.
   *
   * Like `reactivate`, this writes nothing: `invoice.paid` or
   * `invoice.payment_failed` follows, and the dunning ladder moves on that.
   */
  async retryPayment(scope: WorkspaceScope): Promise<{ ok: true }> {
    const pay = this.options.provider.payInvoice;
    if (pay === undefined) {
      throw new AppError(
        'service_unavailable',
        'Retrying a payment is not available on this deployment yet',
        503,
      );
    }

    const invoice = await this.options.unitOfWork(async (repos) => {
      const invoices = await repos.billing.listInvoices(scope, { limit: INVOICE_PAGE });
      return invoices.find((row) => UNPAID_STATUSES.has(row.status)) ?? null;
    });

    if (invoice === null) {
      throw new AppError('not_found', 'There is no unpaid invoice to retry', 404);
    }

    try {
      await pay.call(this.options.provider, { providerInvoiceId: invoice.id });
    } catch {
      // 502, not 402. The card may well have been declined again, but we
      // will not know that until the webhook: all this call reports is
      // whether Stripe accepted the instruction.
      throw new AppError(
        'provider_unavailable',
        'The payment provider could not retry the payment',
        502,
      );
    }

    return { ok: true };
  }

  /** I8's form, as it stands. Null fields render as empty inputs, not as "—". */
  async details(scope: WorkspaceScope): Promise<BillingDetails> {
    return this.options.unitOfWork(async (repos) => {
      const [stored, ownerEmail] = await Promise.all([
        repos.billing.billingDetails(scope),
        repos.billing.billingEmail(scope),
      ]);

      // The owner's address is the fallback for where receipts go, which is
      // the same answer `startCheckout` uses. A workspace that has never
      // opened this form still has a sensible one.
      return stored ?? { email: ownerEmail ?? '', company: '', address: '', taxId: '' };
    });
  }

  /**
   * I8's "Save details".
   *
   * Stored locally and audited. It is **not** pushed to Stripe here, because
   * `BillingProviderAdapter` has no `updateCustomer` and adding one is an
   * owner-reviewed change to `packages/billing` — raised in this batch's
   * report. Until it exists, an invoice Stripe issues carries the address
   * Stripe holds, which is the one taken at checkout. That divergence is
   * real and is the reason this is flagged rather than quietly shipped.
   */
  async updateDetails(scope: WorkspaceScope, input: BillingDetails): Promise<BillingDetails> {
    return this.options.unitOfWork(async (repos) => {
      const before = await repos.billing.billingDetails(scope);

      const after = await repos.billing.saveBillingDetails(scope, {
        ...input,
        newBillingCustomerId: this.options.newId(),
      });

      await this.options.audit?.record(scope, {
        action: 'billing.details_updated',
        resourceId: scope.workspaceId as string,
        // The address and the company. The tax id is recorded as present or
        // absent rather than by value: an audit log is read by more people
        // than the billing page is, and a VAT number identifies a business.
        before: before === null ? null : redactDetails(before),
        after: redactDetails(after),
      });

      return after;
    });
  }

  /**
   * I9's "Export everything".
   *
   * Enqueued, never assembled here: a workspace's contacts, campaigns,
   * events and invoices are gigabytes, and a request that streamed them
   * would hold an API worker for the length of the export.
   *
   * Idempotence is the queue's, not this method's. Asking twice is what a
   * customer does when the first email has not arrived, and the `io` worker
   * dedupes on the workspace and the open request.
   */
  async requestExport(
    scope: WorkspaceScope,
    input: { requestedBy: string },
  ): Promise<{ ok: true }> {
    const queue = this.options.exports;
    if (queue === undefined) {
      throw new AppError(
        'service_unavailable',
        'Exports are not available on this deployment yet',
        503,
      );
    }

    await queue.enqueue({ workspaceId: scope.workspaceId as string, requestedBy: input.requestedBy });

    await this.options.audit?.record(scope, {
      action: 'billing.export_requested',
      resourceId: scope.workspaceId as string,
    });

    return { ok: true };
  }

  async invoices(scope: WorkspaceScope, input: { limit?: number; before?: Date }) {
    const limit = Math.min(INVOICE_PAGE, Math.max(1, Math.trunc(input.limit ?? INVOICE_PAGE)));

    return this.options.unitOfWork((repos) =>
      repos.billing.listInvoices(scope, {
        limit,
        ...(input.before === undefined ? {} : { before: input.before }),
      }),
    );
  }

  async usage(scope: WorkspaceScope) {
    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.billing.usageForPeriod(scope);

      return rows.map((row) => ({
        featureKey: row.featureKey,
        used: row.used,
        included: row.included,
        overage: overageFor(row.used, row.included),
        // Null included is unlimited, and a percentage of unlimited is not a
        // number. The UI renders a count rather than a bar for these.
        percentUsed:
          row.included === null || row.included === 0
            ? null
            : Math.min(100, Math.round((row.used / row.included) * 100)),
        periodEnd: row.periodEnd,
      }));
    });
  }
}

/** Status for a denial, so a route need not know the codes. */
export function statusForEntitlementDenial(decision: Decision): number {
  return decision.allowed ? 200 : statusForDenial(decision.code);
}

/**
 * Failures out of `@relayd/billing` mapped onto the API's own error codes.
 *
 * The billing package has its own vocabulary because it does not know about
 * HTTP. Translating here rather than widening `ERROR_CODES` keeps the API
 * envelope in docs/03 the only list a consumer has to read.
 */
export function checkoutError(failure: string | undefined): { code: ErrorCode; status: number } {
  if (failure === 'already_subscribed') return { code: 'conflict', status: 409 };
  if (failure === 'plan_not_self_serve') return { code: 'insufficient_permission', status: 403 };
  if (failure === 'no_price' || failure === 'unknown_plan') {
    return { code: 'not_found', status: 404 };
  }
  // The provider could not be reached. 502 rather than 500: it is not our
  // fault and it is worth retrying.
  return { code: 'provider_unavailable', status: 502 };
}

export function planChangeError(failure: string | undefined): { code: ErrorCode; status: number } {
  if (failure === 'plan_not_self_serve') return { code: 'insufficient_permission', status: 403 };
  if (failure === 'unknown_plan' || failure === 'no_subscription' || failure === 'no_price') {
    return { code: 'not_found', status: 404 };
  }
  return { code: 'provider_unavailable', status: 502 };
}

/**
 * The blocked-downgrade conflicts, in the envelope's `details` shape.
 *
 * `path` is the feature key so the UI can highlight the right meter, and the
 * message carries both numbers because "over the limit" without them is an
 * instruction the customer cannot follow.
 */
export function conflictDetails(
  conflicts: readonly { feature: string; current: number; targetLimit: number }[],
): ErrorDetail[] {
  return conflicts.map((conflict) => ({
    path: conflict.feature,
    message: `${group(conflict.current)} in use, ${group(conflict.targetLimit)} allowed on that plan`,
  }));
}

/**
 * Digit grouping, pinned to one locale.
 *
 * The server has no user locale to read, so an unpinned `toLocaleString`
 * formats according to whatever locale the container happens to boot with —
 * which makes the same number read differently depending on where it ran.
 * The pre-check endpoint returns the raw numbers so the UI can format them
 * properly for the person looking at them; this string is the fallback.
 */
function group(value: number): string {
  return value.toLocaleString('en-US');
}
