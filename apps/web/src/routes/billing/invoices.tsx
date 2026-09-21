import { useQuery } from '@tanstack/react-query';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  StateBadge,
  TableSkeleton,
  type Column,
} from '@relayd/ui';
import { Link } from 'react-router';
import { ApiError } from '../../api/client.js';
import { billingApi, billingKeys, type InvoiceRow } from '../../api/billing.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { BackToBilling, formatDate, formatMoney } from './parts.js';
import { INVOICE_STATES } from './invoice-states.js';

/**
 * I7 / I7e / I7f — /billing/invoices.
 *
 * A receipt archive, and receipts are the one part of billing a customer
 * looks at years later: the description says how long they are kept and what
 * is on them, so nobody has to ask support.
 *
 * The empty state is the trial workspace's (I7e) and the error state is I7f
 * — the request ID is the whole point of the latter, because it is what lets
 * support join this screen to a trace.
 */
export function InvoicesPage() {
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';

  const invoices = useQuery({
    queryKey: billingKeys.invoices(workspaceId),
    queryFn: () => billingApi.invoices({ limit: 50 }),
  });
  const overview = useQuery({
    queryKey: billingKeys.overview(workspaceId),
    queryFn: () => billingApi.overview(),
  });

  const rows = invoices.data ?? [];
  const currency = rows[0]?.currency ?? 'usd';
  const billingEmail = overview.data?.billingDetails?.email ?? null;

  const columns: readonly Column<InvoiceRow>[] = [
    {
      key: 'number',
      header: 'Invoice',
      width: '180px',
      mono: true,
      cell: (row) => row.number ?? row.id,
    },
    {
      key: 'date',
      header: 'Date',
      width: '140px',
      cell: (row) => <span className="text-text-2">{formatDate(row.createdAt)}</span>,
    },
    {
      key: 'period',
      header: 'Period · plan',
      cell: (row) => (
        <span className="text-text-2">
          {row.periodLabel ??
            (row.periodStart === null ? '—' : `${formatDate(row.periodStart)} – ${formatDate(row.periodEnd)}`)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '150px',
      cell: (row) => <StateBadge states={INVOICE_STATES} state={row.status} />,
    },
    {
      key: 'amount',
      header: 'Amount',
      width: '120px',
      align: 'right',
      cell: (row) => <span className="font-medium">{formatMoney(row.total, row.currency)}</span>,
    },
    {
      key: 'payment',
      header: 'Payment',
      width: '130px',
      cell: (row) => <span className="text-caption text-text-2">{row.paymentLabel ?? '—'}</span>,
    },
    {
      key: 'pdf',
      header: '',
      width: '100px',
      align: 'right',
      cell: (row) =>
        row.pdfUrl === null ? (
          <span className="text-caption text-text-3">—</span>
        ) : (
          <a
            href={row.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.25 text-caption font-medium text-brand no-underline"
          >
            <Icon name="imports" size={13} strokeWidth={2} className="rotate-180" />
            PDF
          </a>
        ),
    },
  ];

  /**
   * I7e and I7f drop the second sentence and the download, and they are
   * right to: there is nothing to say about PDFs that do not exist, and an
   * export button over an empty or failed list is a button that cannot work.
   */
  const header = (empty: boolean) => (
    <PageHeader
      back={<BackToBilling />}
      title="Invoices"
      description={
        empty
          ? 'Issued on the 1st of each month.'
          : 'Issued on the 1st of each month. PDFs include your VAT ID and are kept for 10 years.'
      }
      actions={
        empty ? undefined : (
          // BACKEND PENDING: there is no GET /billing/invoices.csv route.
          <Button variant="secondary">Download all (CSV)</Button>
        )
      }
    />
  );

  if (invoices.isPending) {
    return (
      <>
        {header(false)}
        <TableSkeleton rows={6} tabs={false} label="Loading invoices" />
      </>
    );
  }

  if (invoices.isError) {
    return (
      <>
        {header(true)}
        <ErrorState
          title="We couldn't load invoices"
          description="Your subscription and payment method are unaffected. Send support the request ID if it keeps happening."
          requestId={invoices.error instanceof ApiError ? invoices.error.requestId : undefined}
          actions={
            <a href="mailto:support@relayd.io" className="no-underline">
              <Button variant="secondary">Contact support</Button>
            </a>
          }
          onRetry={() => void invoices.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        {header(true)}
        <EmptyState
          icon="billing"
          title="No invoices yet"
          description={
            billingEmail === null
              ? 'Your first invoice appears here when you pick a plan; we email a copy each month.'
              : `You are on the free trial. Your first invoice appears here when you pick a plan; we email a copy to ${billingEmail} each month.`
          }
          action={
            <Link to="/billing/plans" className="no-underline">
              <Button>See plans</Button>
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      {header(false)}
      <DataTable
        label="Invoices"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        footer={
          <span className="text-caption text-text-2">
            {rows.length} invoice{rows.length === 1 ? '' : 's'} · totals in {currency.toUpperCase()} ·
            taxes shown on the PDF
          </span>
        }
      />
    </>
  );
}
