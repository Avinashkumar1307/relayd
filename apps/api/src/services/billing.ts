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
}

export type BillingUnitOfWork = <T>(fn: (repos: BillingRepositories) => Promise<T>) => Promise<T>;

export interface BillingServiceOptions {
  unitOfWork: BillingUnitOfWork;
  provider: BillingProviderAdapter;
  checkoutPort: (scope: WorkspaceScope) => CheckoutPort;
  planChangePort: (scope: WorkspaceScope) => PlanChangePort;
  /** Supplied so the billing customer id is known before the row is written (R18). */
  newId: () => string;
  appUrl: string;
}

const INVOICE_PAGE = 24;

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
      const [subscription, state, usage, paymentMethod] = await Promise.all([
        repos.billing.currentSubscription(scope),
        repos.billing.readBillingState(scope),
        repos.billing.usageForPeriod(scope),
        repos.billing.defaultPaymentMethod(scope),
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
