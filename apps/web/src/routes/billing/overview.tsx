import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Icon,
  PageHeader,
  Skeleton,
  StateBadge,
  fmtCount,
} from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import {
  billingApi,
  billingKeys,
  type BillingOverview,
  type InvoiceRow,
  type PlanSummary,
} from '../../api/billing.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  CardBrand,
  InfoNote,
  OWNER_ONLY_TITLE,
  Panel,
  READ_ONLY_TITLE,
  UsageMeter,
  formatDate,
  formatDayMonth,
  formatExpiry,
  formatMoney,
  formatPeriod,
  formatRetrySchedule,
  formatWholeMoney,
  planInclusions,
} from './parts.js';
import { INVOICE_STATES } from './invoice-states.js';

/**
 * I1a / I1b / I1m — /billing.
 *
 * Three cards say where the money stands, one card says what has been used,
 * one lists the last three invoices. The frame's own promise is in the
 * description — "Only the Owner can change these" — and this page keeps it:
 * `billing:read` renders everything, and every control that moves money is
 * disabled for anyone but the owner with the reason in its tooltip.
 *
 * I1b is the same page with a payment behind. The past-due card is not a
 * banner: it names the invoice, the amount, the days, the declines, the
 * retry dates and the date sending stops, because a customer who is told
 * only "payment failed" goes looking for the page they are already on.
 */
export function BillingPage() {
  const { current, can } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';
  const workspaceName = current?.workspaceName ?? 'this workspace';
  const readOnly = useReadOnly();
  const canWrite = can('billing:write');

  const overview = useQuery({
    queryKey: billingKeys.overview(workspaceId),
    queryFn: () => billingApi.overview(),
  });
  const plans = useQuery({
    queryKey: billingKeys.plans(workspaceId),
    queryFn: () => billingApi.plans(),
  });
  const invoices = useQuery({
    queryKey: billingKeys.invoices(workspaceId),
    queryFn: () => billingApi.invoices({ limit: 3 }),
  });

  const header = (
    <PageHeader
      title="Billing"
      description={`Plan, usage and payment for ${workspaceName}. Only the Owner can change these.`}
      actions={
        <>
          <Link to="/billing/invoices" className="no-underline">
            <Button variant="secondary">Invoices</Button>
          </Link>
          <Link to="/billing/plans" className="no-underline">
            <Button>Manage plan</Button>
          </Link>
        </>
      }
    />
  );

  if (overview.isPending) {
    return (
      <>
        {header}
        <BillingSkeleton />
      </>
    );
  }

  if (overview.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="We couldn't load billing"
          description="Your subscription and payment method are unaffected. Send support the request ID if it keeps happening."
          requestId={overview.error instanceof ApiError ? overview.error.requestId : undefined}
          onRetry={() => void overview.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  const data = overview.data;
  const plan = plans.data?.find((row) => row.code === data.subscription?.planCode);

  return (
    <>
      {header}

      <DunningCard overview={data} canWrite={canWrite} readOnly={readOnly} workspaceId={workspaceId} />

      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <CurrentPlanCard overview={data} plan={plan} canWrite={canWrite} readOnly={readOnly} />
        <NextInvoiceCard overview={data} />
        <PaymentMethodCard overview={data} />
      </div>

      <UsageCard overview={data} />

      <RecentInvoices
        rows={(invoices.data ?? []).slice(0, 3)}
        pending={invoices.isPending}
        failed={invoices.isError}
      />
    </>
  );
}

/* ---------------------------------------------------------------- cards */

function CurrentPlanCard({
  overview,
  plan,
  canWrite,
  readOnly,
}: {
  overview: BillingOverview;
  plan: PlanSummary | undefined;
  canWrite: boolean;
  readOnly: boolean;
}) {
  const subscription = overview.subscription;

  if (subscription === null) {
    return (
      <Panel>
        <div className="text-ui text-text-2">Current plan</div>
        <div className="mt-2 text-[28px] leading-heading font-semibold tracking-heading">No plan</div>
        <div className="mt-1.5 text-ui text-text-2">
          Nothing is sent and nothing is charged until you choose one.
        </div>
        <div className="mt-4">
          <Link to="/billing/plans" className="no-underline">
            <Button>Choose a plan</Button>
          </Link>
        </div>
      </Panel>
    );
  }

  const price = plan?.price;
  const amount =
    price === undefined || price.month === null
      ? null
      : `${formatWholeMoney(subscription.interval === 'year' ? (price.year ?? price.month) : price.month, price.currency)} / ${subscription.interval === 'year' ? 'month, billed yearly' : 'month'}`;

  const dunning = overview.dunning ?? null;
  const pastDue = overview.state.pastDue || overview.state.subscriptionSuspended;

  const inclusions = planInclusions(plan);
  const billed = subscription.interval === 'year' ? 'Billed yearly' : 'Billed monthly';
  const summary = [
    billed,
    `renews ${formatDate(subscription.currentPeriodEnd)}`,
    ...(inclusions === '' ? [] : [inclusions]),
  ].join(' · ');

  const disabledTitle = readOnly ? READ_ONLY_TITLE : canWrite ? undefined : OWNER_ONLY_TITLE;

  return (
    <Panel>
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui text-text-2">Current plan</span>
        {overview.state.workspaceSuspended ? (
          <Badge tone="danger">Suspended</Badge>
        ) : pastDue ? (
          <Badge tone="warning">
            Past due · {dunning === null ? 'unpaid' : `${dunning.daysPastDue} days`}
          </Badge>
        ) : subscription.cancelAtPeriodEnd ? (
          <Badge tone="neutral">Cancels {formatDate(subscription.currentPeriodEnd)}</Badge>
        ) : (
          <Badge tone="success">Active</Badge>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-2.5">
        <span className="text-[28px] leading-heading font-semibold tracking-heading">
          {subscription.planName}
        </span>
        {amount === null ? null : <span className="text-card text-text-2">{amount}</span>}
      </div>

      <div className="mt-1.5 text-ui text-text-2">{summary}</div>

      {subscription.scheduledPlanCode === null ? null : (
        <div className="mt-3 rounded-control bg-tint px-3 py-2 text-ui text-text-2">
          Changing to <span className="font-medium text-text">{subscription.scheduledPlanCode}</span> on{' '}
          {formatDate(subscription.scheduledChangeAt)}. Until then nothing changes — you keep what you
          paid for.
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link to="/billing/plans" className="no-underline">
          <span className="inline-flex h-8 items-center rounded-control border border-border bg-surface px-2.5 text-caption font-medium text-text">
            Change plan
          </span>
        </Link>
        {canWrite && !readOnly ? (
          <Link to="/billing/cancel-subscription" className="no-underline">
            <span className="inline-flex h-8 items-center rounded-control border border-border bg-surface px-2.5 text-caption font-medium text-text-2">
              Cancel subscription
            </span>
          </Link>
        ) : (
          <span
            title={disabledTitle}
            aria-disabled="true"
            className="inline-flex h-8 cursor-not-allowed items-center rounded-control border border-transparent bg-neutral-soft px-2.5 text-caption font-medium text-text-3"
          >
            Cancel subscription
          </span>
        )}
      </div>
    </Panel>
  );
}

function NextInvoiceCard({ overview }: { overview: BillingOverview }) {
  const next = overview.nextInvoice ?? null;
  const subscription = overview.subscription;

  if (next === null) {
    return (
      <Panel>
        <div className="text-ui text-text-2">Next invoice · estimate</div>
        <div className="mt-2 text-[28px] leading-heading font-semibold tracking-heading tabular-nums">
          —
        </div>
        <div className="mt-1.5 text-ui text-text-2">
          {/* BACKEND PENDING: GET /billing (no invoice estimate on the payload). */}
          {subscription === null
            ? 'There is nothing to bill yet.'
            : `The estimate appears once the period has run. Renews ${formatDate(subscription.currentPeriodEnd)}.`}
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="text-ui text-text-2">Next invoice · estimate</div>
      <div className="mt-2 text-[28px] leading-heading font-semibold tracking-heading tabular-nums">
        {formatMoney(next.total, next.currency)}
      </div>
      <div className="mt-1.5 text-ui text-text-2">
        On {formatDate(next.at)} · {subscription?.planName ?? 'Plan'}{' '}
        {formatMoney(next.planAmount, next.currency)} · overage{' '}
        {formatMoney(next.overageAmount, next.currency)} so far
      </div>

      {next.overagePer1000 === null || next.includedEmails === null ? null : (
        <div className="mt-3.5 flex justify-between gap-2 border-t border-border pt-3 text-caption text-text-2">
          <span>If you pass {fmtCount(next.includedEmails)} emails</span>
          <span className="text-right text-text">
            {formatMoney(next.overagePer1000, next.currency)} per 1,000 extra
          </span>
        </div>
      )}
    </Panel>
  );
}

function PaymentMethodCard({ overview }: { overview: BillingOverview }) {
  const method = overview.paymentMethod;
  const details = overview.billingDetails ?? null;
  const declined = method?.declinedOn ?? [];

  return (
    <Panel>
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui text-text-2">Payment method</span>
        <Link to="/billing/payment-method" className="text-caption font-medium text-brand no-underline">
          Update
        </Link>
      </div>

      {method === null || method.last4 === null ? (
        <div className="mt-2.5 text-ui text-text-2">No card on file.</div>
      ) : (
        <div className="mt-2.5 flex items-center gap-3">
          <CardBrand brand={method.brand} />
          <span className="min-w-0">
            <span className="block font-mono text-ui font-medium">•••• •••• •••• {method.last4}</span>
            {declined.length > 0 ? (
              <span className="block text-caption font-medium text-danger-text">
                Declined {declined.map((day) => formatDayMonth(day)).join(' and ')}
              </span>
            ) : (
              <span className="block text-caption text-text-2">
                Expires {formatExpiry(method.expMonth, method.expYear)}
                {method.isDefault === true ? ' · default' : ''}
              </span>
            )}
          </span>
        </div>
      )}

      {details === null ? null : (
        <div className="mt-3.5 border-t border-border pt-3 text-caption text-text-2">
          Receipts to {details.email}
          {details.taxId === '' ? '' : ` · VAT ${details.taxId}`}
        </div>
      )}
    </Panel>
  );
}

function UsageCard({ overview }: { overview: BillingOverview }) {
  const subscription = overview.subscription;
  const next = overview.nextInvoice ?? null;

  const noteFor = (featureKey: string): string => {
    if (featureKey === 'emails.sent') {
      return next === null || next.overagePer1000 === null
        ? 'Counted when your provider accepts them'
        : `Overage ${formatMoney(next.overagePer1000, next.currency)} / 1,000 after the limit`;
    }
    if (featureKey === 'workspace.seats') {
      const row = overview.usage.find((item) => item.featureKey === featureKey);
      const free = row === undefined || row.included === null ? null : row.included - row.used;
      return free === null ? 'Invite from Team' : `${free} free`;
    }
    return 'Adding more is blocked at the limit';
  };

  return (
    <Panel className="mb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">Usage this period</span>
        <span className="text-caption text-text-2">
          {subscription === null
            ? 'No period yet'
            : `${formatPeriod(subscription.currentPeriodStart, new Date().toISOString())} · resets ${formatDayMonth(subscription.currentPeriodEnd)}`}
        </span>
      </div>

      <div className="mt-4 grid gap-6 sm:grid-cols-3">
        {overview.usage.map((row) => (
          <UsageMeter key={row.featureKey} row={row} note={noteFor(row.featureKey)} />
        ))}
      </div>

      <InfoNote>
        Emails count when your provider accepts them.{' '}
        {overview.deliveryUncertain === undefined || overview.deliveryUncertain === 0
          ? null
          : `${fmtCount(overview.deliveryUncertain)} delivery-uncertain sends this period are not counted. `}
        Test sends are free. Going over the email limit bills overage; going over contacts or seats
        blocks adding more until you upgrade.
      </InfoNote>
    </Panel>
  );
}

/* ------------------------------------------------------------- dunning */

function DunningCard({
  overview,
  canWrite,
  readOnly,
  workspaceId,
}: {
  overview: BillingOverview;
  canWrite: boolean;
  readOnly: boolean;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => billingApi.retryPayment(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(workspaceId) });
    },
  });

  if (overview.state.workspaceSuspended) {
    return (
      <div
        role="alert"
        className="mb-4 rounded-card border border-danger bg-danger-soft px-4.5 py-3.5 text-ui"
      >
        <div className="font-semibold">This workspace is suspended</div>
        <div className="text-text-2">
          Contact support — this is not something a payment fixes. Nothing has been deleted.
        </div>
      </div>
    );
  }

  const dunning = overview.dunning ?? null;
  if (!overview.state.pastDue && !overview.state.subscriptionSuspended) return null;

  const disabledTitle = readOnly ? READ_ONLY_TITLE : canWrite ? undefined : OWNER_ONLY_TITLE;

  return (
    <div
      role="alert"
      className="mb-4 flex flex-col gap-3.5 rounded-card border border-warning bg-warning-soft px-4.5 py-3.5 sm:flex-row sm:items-center"
    >
      <Icon name="alert" size={18} strokeWidth={2} className="hidden flex-none text-warning-text sm:block" />

      <div className="min-w-0 flex-1 text-ui">
        <div className="font-semibold">
          {dunning === null
            ? 'Your last payment did not go through'
            : `Invoice ${dunning.invoiceNumber} · ${dunning.currency.toUpperCase()} ${(dunning.amount / 100).toFixed(2)} is ${dunning.daysPastDue} days past due`}
        </div>
        <div className="text-pretty text-text-2">
          {dunning === null ? (
            'Everything still works for now. Update your card to avoid sending being paused. Nothing is deleted.'
          ) : (
            <>
              Your card ending {overview.paymentMethod?.last4 ?? '••••'} was declined on{' '}
              {dunning.declinedOn.map((day) => formatDayMonth(day)).join(' and again on ')}. We retry on{' '}
              {formatRetrySchedule(dunning.retryOn)}. Sending continues until{' '}
              {formatDayMonth(dunning.sendingBlockedAt)}; after that new launches are blocked and
              scheduled campaigns are held. Nothing is deleted.
            </>
          )}
        </div>
      </div>

      <div className="flex flex-none flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => retry.mutate()}
          pending={retry.isPending}
          disabled={!canWrite || readOnly}
          title={disabledTitle}
        >
          {retry.isPending ? 'Retrying…' : 'Retry now'}
        </Button>
        <Link to="/billing/payment-method" className="no-underline">
          <Button>Update payment method</Button>
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ recent invoices */

function RecentInvoices({
  rows,
  pending,
  failed,
}: {
  rows: InvoiceRow[];
  pending: boolean;
  failed: boolean;
}) {
  return (
    <Card flush>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4.5 py-3.5">
        <span className="font-semibold">Recent invoices</span>
        <Link to="/billing/invoices" className="text-ui font-medium text-brand no-underline">
          All invoices
        </Link>
      </div>

      {pending ? (
        <div className="flex flex-col gap-3 px-4.5 py-4">
          <Skeleton height={16} />
          <Skeleton height={16} />
          <Skeleton height={16} />
        </div>
      ) : failed ? (
        <div className="px-4.5 py-6 text-center text-ui text-text-2">
          We couldn&apos;t load invoices. Your subscription and payment method are unaffected.
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4.5 py-6 text-center text-ui text-text-2">
          No invoices yet. Your first invoice appears here when you pick a plan.
        </div>
      ) : (
        rows.map((invoice) => (
          <div
            key={invoice.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border px-4.5 py-2.5 text-ui last:border-b-0 md:grid-cols-[170px_minmax(0,1fr)_140px_120px_110px]"
          >
            <span className="truncate font-mono text-caption">{invoice.number ?? invoice.id}</span>

            <span className="hidden truncate text-text-2 md:block">
              {invoice.periodLabel ?? formatDate(invoice.createdAt)}
            </span>

            <span className="col-start-1 text-caption text-text-2 md:hidden">
              {formatDate(invoice.createdAt)}
            </span>

            <span className="col-start-2 row-start-1 row-end-3 flex items-center justify-end gap-3 md:col-auto md:row-auto md:justify-start">
              <StateBadge states={INVOICE_STATES} state={invoice.status} />
              <span className="font-medium tabular-nums md:hidden">
                {formatMoney(invoice.total, invoice.currency)}
              </span>
            </span>

            <span className="hidden text-right font-medium tabular-nums md:block">
              {formatMoney(invoice.total, invoice.currency)}
            </span>

            <span className="hidden text-right md:block">
              {invoice.pdfUrl === null ? (
                <span className="text-caption text-text-3">—</span>
              ) : (
                <a
                  href={invoice.pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-caption font-medium text-brand no-underline"
                >
                  PDF
                </a>
              )}
            </span>
          </div>
        ))
      )}
    </Card>
  );
}

/* ------------------------------------------------------------- loading */

function BillingSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading billing">
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex flex-col gap-3 rounded-card border border-border bg-surface px-5 py-5">
            <Skeleton width={120} />
            <Skeleton width={160} height={28} radius={6} />
            <Skeleton width="80%" />
          </div>
        ))}
      </div>

      <div className="mb-4 rounded-card border border-border bg-surface px-5 py-5">
        <Skeleton width={160} />
        <div className="mt-4 grid gap-6 sm:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton />
              <Skeleton height={8} radius={4} />
              <Skeleton width="60%" />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-card border border-border bg-surface px-5 py-5">
        <Skeleton width={140} />
        <div className="mt-4 flex flex-col gap-3">
          <Skeleton height={16} />
          <Skeleton height={16} />
          <Skeleton height={16} />
        </div>
      </div>
    </div>
  );
}
