import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  billingApi,
  type DowngradeConflict,
  type Interval,
  type PlanSummary,
  type UsageRow,
} from '../../api/billing.js';
import { ApiError } from '../../api/client.js';
import { Badge, Button, Cell, EmptyState, LoadError, Loading, Page, Table, formatDate } from '../../components/ui.js';

/**
 * Billing (docs/05).
 *
 * Three things here are not cosmetic.
 *
 * **The success page never trusts the redirect.** Stripe sends the browser
 * back as soon as payment succeeds, and the webhook that creates the
 * subscription row may not have arrived. `/billing/success` polls until it
 * has, falls back to a server-side session lookup after ten seconds, and
 * gives up with something useful to read rather than a spinner. The customer
 * has just been charged; leaving them staring at a loader is the worst
 * available outcome.
 *
 * **A downgrade is pre-checked before it is offered.** The dialog asks the
 * server what would break and lists it. "You cannot downgrade" with no
 * explanation is a support ticket, and the customer usually can once they
 * know they need to delete four hundred contacts first.
 *
 * **Unlimited is not a full bar.** A feature with no limit renders a count
 * and no meter, because a progress bar at 0% reads as "you have nothing" and
 * one at 100% reads as "you are out".
 */

export function BillingPage() {
  const query = useQuery({ queryKey: ['billing'], queryFn: () => billingApi.overview() });
  const portal = useMutation({
    mutationFn: () => billingApi.portal(),
    onSuccess: (session) => {
      window.location.assign(session.url);
    },
  });

  if (query.isPending) return <Loading label="Loading billing…" />;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;

  const { subscription, state, usage, paymentMethod } = query.data;

  return (
    <Page
      title="Billing"
      description="Your plan, what you have used this period, and your invoices."
      action={
        subscription === null ? (
          <Link to="/billing/plans">
            <Button>Choose a plan</Button>
          </Link>
        ) : (
          <div className="flex gap-2">
            <Link to="/billing/plans">
              <Button variant="secondary">Change plan</Button>
            </Link>
            <Button onClick={() => portal.mutate()} disabled={portal.isPending}>
              {portal.isPending ? 'Opening…' : 'Manage payment'}
            </Button>
          </div>
        )
      }
    >
      <StateBanner state={state} />

      {subscription === null ? (
        <EmptyState title="No active subscription">
          <p>
            Choose a plan to start sending. Nothing is sent and nothing is charged until you do.
          </p>
        </EmptyState>
      ) : (
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">{subscription.planName}</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Billed</dt>
              <dd className="text-slate-900">
                {subscription.interval === 'month' ? 'Monthly' : 'Yearly'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Current period ends</dt>
              <dd className="text-slate-900">{formatDate(subscription.currentPeriodEnd)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Payment method</dt>
              <dd className="text-slate-900">
                {paymentMethod?.last4 === null || paymentMethod === null
                  ? 'None on file'
                  : `${paymentMethod.brand ?? 'Card'} ending ${paymentMethod.last4}`}
              </dd>
            </div>
          </dl>

          {subscription.scheduledPlanCode !== null && (
            <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
              Changing to <strong>{subscription.scheduledPlanCode}</strong> on{' '}
              {formatDate(subscription.scheduledChangeAt)}. Until then nothing changes — you keep
              what you have paid for.
            </p>
          )}

          {subscription.cancelAtPeriodEnd && (
            <p className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
              Your subscription ends on {formatDate(subscription.currentPeriodEnd)}. Campaigns run
              and scheduled sends fire until then.
            </p>
          )}
        </section>
      )}

      <UsageMeters usage={usage} />

      <div className="flex gap-3">
        <Link to="/billing/invoices" className="text-sm text-slate-700 underline">
          Invoices
        </Link>
        {subscription !== null && (
          <Link to="/billing/subscription/cancel" className="text-sm text-slate-600 underline">
            Cancel subscription
          </Link>
        )}
      </div>
    </Page>
  );
}

/**
 * The dunning banner.
 *
 * Says what has happened and what to do about it, in that order. A banner
 * that says "payment failed" and nothing else makes the customer go looking
 * for the page they are already on.
 */
function StateBanner({
  state,
}: {
  state: { pastDue: boolean; subscriptionSuspended: boolean; workspaceSuspended: boolean };
}) {
  if (state.workspaceSuspended) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        This workspace is suspended. Contact support — this is not something a payment fixes.
      </div>
    );
  }

  if (state.subscriptionSuspended) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p className="font-medium">Your subscription is suspended for non-payment.</p>
        <p className="mt-1">
          Nothing has been deleted. Update your card and sending resumes, including anything
          scheduled while you were behind.
        </p>
      </div>
    );
  }

  if (state.pastDue) {
    return (
      <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">Your last payment did not go through.</p>
        <p className="mt-1">
          Everything still works for now. Update your card to avoid sending being paused.
        </p>
      </div>
    );
  }

  // Nothing to say. A banner that appears when everything is fine teaches
  // people to ignore banners.
  return null;
}

/**
 * Usage meters.
 *
 * Unlimited features show a count and no bar. Overage is shown as its own
 * number rather than folded into the percentage, because the two answer
 * different questions: how full is it, and how much extra will I be billed.
 */
function UsageMeters({ usage }: { usage: UsageRow[] }) {
  if (usage.length === 0) return null;

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-900">This period</h2>

      {usage.map((row) => (
        <div key={row.featureKey} className="space-y-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-slate-700">{featureLabel(row.featureKey)}</span>
            <span className="text-slate-900">
              {row.used.toLocaleString()}
              {row.included === null ? ' used' : ` of ${row.included.toLocaleString()}`}
            </span>
          </div>

          {row.percentUsed !== null && (
            <div
              role="progressbar"
              aria-valuenow={row.percentUsed}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={featureLabel(row.featureKey)}
              className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
            >
              <div
                className={row.percentUsed >= 100 ? 'h-full bg-amber-500' : 'h-full bg-slate-900'}
                style={{ width: `${row.percentUsed}%` }}
              />
            </div>
          )}

          {row.overage > 0 && (
            <p className="text-xs text-amber-800">
              {row.overage.toLocaleString()} over your allowance this period.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

export function PlansPage() {
  const plans = useQuery({ queryKey: ['billing', 'plans'], queryFn: () => billingApi.plans() });
  const current = useQuery({ queryKey: ['billing'], queryFn: () => billingApi.overview() });
  const [interval, setInterval] = useState<Interval>('month');

  if (plans.isPending) return <Loading label="Loading plans…" />;
  if (plans.isError) return <LoadError error={plans.error} onRetry={() => void plans.refetch()} />;

  const currentPlan = current.data?.subscription?.planCode ?? null;
  const hasSubscription = current.data?.subscription != null;

  return (
    <Page
      title="Plans"
      description="Upgrades apply immediately and are prorated. Downgrades take effect at the end of your current period."
      action={
        <div className="flex gap-1 rounded-md border border-slate-300 p-1 text-sm">
          {(['month', 'year'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={interval === value}
              onClick={() => setInterval(value)}
              className={
                interval === value
                  ? 'rounded px-2 py-1 bg-slate-900 text-white'
                  : 'rounded px-2 py-1 text-slate-700'
              }
            >
              {value === 'month' ? 'Monthly' : 'Yearly'}
            </button>
          ))}
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.data.map((plan) => (
          <PlanCard
            key={plan.code}
            plan={plan}
            interval={interval}
            isCurrent={plan.code === currentPlan}
            hasSubscription={hasSubscription}
          />
        ))}
      </div>
    </Page>
  );
}

function PlanCard({
  plan,
  interval,
  isCurrent,
  hasSubscription,
}: {
  plan: PlanSummary;
  interval: Interval;
  isCurrent: boolean;
  hasSubscription: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  const checkout = useMutation({
    mutationFn: () => billingApi.checkout({ planCode: plan.code, interval }),
    onSuccess: (session) => {
      window.location.assign(session.url);
    },
  });

  return (
    <div className="flex flex-col rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-900">{plan.name}</h2>
      {plan.description !== undefined && (
        <p className="mt-1 text-sm text-slate-600">{plan.description}</p>
      )}

      <dl className="mt-4 flex-1 space-y-1 text-sm">
        {Object.entries(plan.limits).map(([feature, limit]) => (
          <div key={feature} className="flex justify-between gap-2">
            <dt className="text-slate-500">{featureLabel(feature)}</dt>
            <dd className="text-slate-900">
              {limit === null ? 'Unlimited' : limit.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-4">
        {isCurrent ? (
          <Badge tone="good">Current plan</Badge>
        ) : hasSubscription ? (
          <>
            <Button onClick={() => setConfirming(true)}>Switch to {plan.name}</Button>
            {confirming && (
              <PlanChangeDialog
                planCode={plan.code}
                planName={plan.name}
                interval={interval}
                onClose={() => setConfirming(false)}
              />
            )}
          </>
        ) : (
          <Button onClick={() => checkout.mutate()} disabled={checkout.isPending}>
            {checkout.isPending ? 'Opening checkout…' : `Choose ${plan.name}`}
          </Button>
        )}

        {checkout.isError && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {checkout.error instanceof ApiError
              ? checkout.error.message
              : 'Checkout could not be started.'}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The plan-change dialog, with the downgrade pre-check in front of it.
 *
 * The check runs before the confirm button appears, so a customer whose
 * usage blocks the change is told what to delete rather than shown a button
 * that will 422.
 */
function PlanChangeDialog({
  planCode,
  planName,
  interval,
  onClose,
}: {
  planCode: string;
  planName: string;
  interval: Interval;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const preview = useQuery({
    queryKey: ['billing', 'preview', planCode],
    queryFn: () => billingApi.planChangePreview(planCode),
  });

  const change = useMutation({
    mutationFn: () => billingApi.changePlan({ planCode, interval }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['billing'] });
      void navigate('/billing');
    },
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Switch to ${planName}`}
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">Switch to {planName}</h2>

        {preview.isPending && <Loading label="Checking your usage…" />}
        {preview.isError && <LoadError error={preview.error} />}

        {preview.data?.blocked === true && (
          <DowngradeBlocked conflicts={preview.data.conflicts} planName={planName} />
        )}

        {preview.data?.blocked === false && (
          <p className="text-sm text-slate-700">
            An upgrade applies immediately and is prorated. A downgrade takes effect at the end of
            your current period, and nothing changes before then.
          </p>
        )}

        {change.isError && (
          <ChangeError error={change.error} />
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => change.mutate()}
            disabled={preview.data?.blocked !== false || change.isPending}
          >
            {change.isPending ? 'Switching…' : 'Confirm'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DowngradeBlocked({
  conflicts,
  planName,
}: {
  conflicts: DowngradeConflict[];
  planName: string;
}) {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">
        You are above what {planName} includes.
      </p>
      <ul className="space-y-1 text-sm text-amber-900">
        {conflicts.map((conflict) => (
          <li key={conflict.feature}>
            {featureLabel(conflict.feature)}: {conflict.current.toLocaleString()} in use,{' '}
            {conflict.targetLimit.toLocaleString()} allowed
          </li>
        ))}
      </ul>
      <p className="text-xs text-amber-800">
        Remove the difference and this change becomes available. Nothing is deleted for you.
      </p>
    </div>
  );
}

/** The server's 422 detail, rendered as the list it is. */
function ChangeError({ error }: { error: unknown }) {
  const apiError = error instanceof ApiError ? error : null;

  return (
    <div role="alert" className="space-y-1 rounded-md border border-red-200 bg-red-50 p-3">
      <p className="text-sm text-red-900">{apiError?.message ?? 'The plan could not be changed.'}</p>
      {(apiError?.details ?? []).map((detail) => (
        <p key={detail.path} className="text-xs text-red-800">
          {featureLabel(detail.path)}: {detail.message}
        </p>
      ))}
    </div>
  );
}

/**
 * The page Stripe redirects to.
 *
 * It polls, because the redirect proves a payment and not a subscription row.
 * After ten seconds the server switches it to a session lookup, and after a
 * minute it stops and says something a person can act on — the alternative is
 * a spinner in front of somebody who has just been charged.
 */
export function CheckoutSuccessPage() {
  const [params] = useSearchParams();
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['billing', 'checkout-status', elapsed],
    queryFn: () => billingApi.checkoutStatus(Date.now() - startedAt.current),
    // Re-runs while `elapsed` ticks below; no refetchInterval, so a slow
    // response cannot stack requests on top of each other.
    staleTime: 0,
  });

  const action = status.data?.action ?? 'poll';
  const done = status.data?.ready === true;

  useEffect(() => {
    if (done || action === 'give_up') return undefined;

    const timer = window.setTimeout(() => {
      setElapsed(Date.now() - startedAt.current);
    }, 1_000);

    return () => window.clearTimeout(timer);
  }, [done, action, elapsed]);

  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: ['billing'] });
  }, [done, queryClient]);

  if (done) {
    return (
      <Page title="You are all set" description="Your subscription is active.">
        <p className="text-sm text-slate-700">
          Your plan is <strong>{status.data?.planCode}</strong>.
        </p>
        <Link to="/billing" className="text-sm text-slate-700 underline">
          Back to billing
        </Link>
      </Page>
    );
  }

  if (action === 'give_up') {
    return (
      <Page title="Still processing" description="Your payment went through.">
        <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            Your payment succeeded, and we are still waiting for our payment provider to confirm
            it. Nothing is lost and you will not be charged twice.
          </p>
          <p className="text-sm text-amber-900">
            Reload this page in a minute, or contact support with this reference:{' '}
            <code className="font-mono">{params.get('session_id') ?? 'unknown'}</code>
          </p>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Finishing up" description="Confirming your subscription.">
      <p role="status" className="text-sm text-slate-600">
        {action === 'fallback'
          ? 'Taking a little longer than usual. Still working — your payment has gone through.'
          : 'One moment…'}
      </p>
    </Page>
  );
}

export function CheckoutCancelPage() {
  return (
    <Page title="Checkout cancelled" description="Nothing has been charged.">
      <p className="text-sm text-slate-700">
        You closed the checkout before finishing. Nothing was charged and your workspace is
        unchanged.
      </p>
      <Link to="/billing/plans" className="text-sm text-slate-700 underline">
        Back to plans
      </Link>
    </Page>
  );
}

export function InvoicesPage() {
  const query = useQuery({ queryKey: ['billing', 'invoices'], queryFn: () => billingApi.invoices() });

  if (query.isPending) return <Loading label="Loading invoices…" />;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;

  if (query.data.length === 0) {
    return (
      <Page title="Invoices">
        <EmptyState title="No invoices yet">
          <p>Your first invoice appears after your first billing period.</p>
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page title="Invoices" description="Issued by our payment provider.">
      <Table columns={['Invoice', 'Period', 'Status', 'Total', '']}>
        {query.data.map((invoice) => (
          <tr key={invoice.id} className="border-t border-slate-100">
            <Cell>{invoice.number ?? invoice.id}</Cell>
            <Cell muted>
              {formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}
            </Cell>
            <Cell>
              <Badge tone={invoiceTone(invoice.status)}>{invoice.status}</Badge>
            </Cell>
            <Cell>{formatMoney(invoice.total, invoice.currency)}</Cell>
            <Cell>
              {invoice.hostedInvoiceUrl !== null && (
                <a
                  href={invoice.hostedInvoiceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm text-slate-700 underline"
                >
                  View
                </a>
              )}
            </Cell>
          </tr>
        ))}
      </Table>
    </Page>
  );
}

export function CancelSubscriptionPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [immediately, setImmediately] = useState(false);

  const overview = useQuery({ queryKey: ['billing'], queryFn: () => billingApi.overview() });

  const cancel = useMutation({
    mutationFn: () => billingApi.cancel({ immediately }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['billing'] });
      void navigate('/billing');
    },
  });

  const endsAt = overview.data?.subscription?.currentPeriodEnd ?? null;

  return (
    <Page title="Cancel subscription" description="You keep what you have paid for.">
      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="radio"
            name="when"
            checked={!immediately}
            onChange={() => setImmediately(false)}
            className="mt-1"
          />
          <span>
            <span className="font-medium text-slate-900">At the end of this period</span>
            <span className="block text-slate-600">
              Everything keeps working until {formatDate(endsAt)}. Campaigns run, scheduled sends
              fire, and you can undo this at any point before then.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="radio"
            name="when"
            checked={immediately}
            onChange={() => setImmediately(true)}
            className="mt-1"
          />
          <span>
            <span className="font-medium text-slate-900">Immediately</span>
            <span className="block text-slate-600">
              Sending stops now. The rest of this period is not refunded, and undoing it means
              subscribing again.
            </span>
          </span>
        </label>

        {cancel.isError && <LoadError error={cancel.error} />}

        <div className="flex gap-2">
          <Button variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel subscription'}
          </Button>
          <Link to="/billing">
            <Button variant="secondary">Keep my plan</Button>
          </Link>
        </div>
      </div>
    </Page>
  );
}

/**
 * A feature key as a person would say it.
 *
 * Falls back to the key rather than to an empty string: an unlabelled meter
 * is worse than one labelled `campaigns.per_month`, and the fallback is how
 * a feature added to the catalogue and not to this map is noticed.
 */
export function featureLabel(key: string): string {
  const labels: Record<string, string> = {
    'emails.sent': 'Emails sent',
    'contacts.stored': 'Contacts',
    'campaigns.per_month': 'Campaigns this month',
    'campaigns.sending_pools': 'Sending pools',
    'campaigns.ab_testing': 'A/B testing',
    'tracking.custom_domains': 'Custom tracking domains',
    'api.access': 'API access',
    'api.webhooks': 'Outbound webhooks',
    'workspace.seats': 'Team seats',
    'analytics.retention_days': 'Analytics retention (days)',
    'support.priority': 'Priority support',
  };

  return labels[key] ?? key;
}

/** Minor units to a readable amount. Stripe gives cents; nobody reads cents. */
export function formatMoney(minorUnits: number, currency: string): string {
  const amount = minorUnits / 100;

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    // An unknown currency code from a Stripe account configured for one we do
    // not recognise. Better a bare number than a crash on the billing page.
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function invoiceTone(status: string): 'neutral' | 'good' | 'warn' | 'bad' {
  if (status === 'paid') return 'good';
  if (status === 'open') return 'warn';
  if (status === 'uncollectible') return 'bad';
  return 'neutral';
}

/** Exported for the meter tests. */
export const billingInternals = { invoiceTone };
