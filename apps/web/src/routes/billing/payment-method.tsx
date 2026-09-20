import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, ErrorState, Field, PageHeader, Skeleton, Textarea } from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import { billingApi, billingKeys, type BillingDetails } from '../../api/billing.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  BackToBilling,
  useSafeToast,
  CardBrand,
  OWNER_ONLY_TITLE,
  Panel,
  READ_ONLY_TITLE,
  formatDate,
  formatExpiry,
} from './parts.js';

/**
 * I8 — /billing/payment-method.
 *
 * Relayd never stores a card number, and this page must not look as though
 * it does: there is no card form here, only what is on file and a button
 * that hands the customer to Stripe's hosted portal. Everything editable on
 * this screen is an invoice detail, which is ours to keep.
 *
 * BACKEND PENDING: PATCH /billing/details. The billing address, company name
 * and tax ID are drawn on I8 and have no endpoint yet; the form works
 * against the preview backend and reports the failure honestly against the
 * real one.
 */

/**
 * The schema is local rather than from `@relayd/validation`: there is no
 * billing-details endpoint yet, so there is no shared schema to import. It
 * moves there with the endpoint.
 */
const detailsSchema = z.object({
  email: z.string().min(1, 'A billing email is required').email('That does not look like an email address'),
  company: z.string().max(200, 'Keep the company name under 200 characters'),
  address: z.string().max(500, 'Keep the address under 500 characters'),
  taxId: z.string().max(60, 'Keep the tax ID under 60 characters'),
});

type DetailsForm = z.infer<typeof detailsSchema>;

export function PaymentMethodPage() {
  const { current, can } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';
  const readOnly = useReadOnly();
  const canWrite = can('billing:write');
  const { toast } = useSafeToast();
  const queryClient = useQueryClient();

  const overview = useQuery({
    queryKey: billingKeys.overview(workspaceId),
    queryFn: () => billingApi.overview(),
  });

  const portal = useMutation({
    mutationFn: () => billingApi.portal(),
    onSuccess: (session) => {
      window.location.assign(session.url);
    },
    onError: (error) => {
      toast({
        tone: 'danger',
        title: 'We could not open the Stripe portal',
        description: error instanceof ApiError ? error.message : 'Try again in a moment.',
      });
    },
  });

  const save = useMutation({
    mutationFn: (input: BillingDetails) => billingApi.saveDetails(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(workspaceId) });
      toast({ tone: 'success', title: 'Billing details saved' });
    },
    onError: (error) => {
      toast({
        tone: 'danger',
        title: 'Those details were not saved',
        description: error instanceof ApiError ? error.message : 'Try again in a moment.',
      });
    },
  });

  const details = overview.data?.billingDetails ?? null;

  const form = useForm<DetailsForm>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { email: '', company: '', address: '', taxId: '' },
  });
  const { reset } = form;

  useEffect(() => {
    if (details !== null) reset(details);
  }, [details, reset]);

  const header = (
    <PageHeader
      back={<BackToBilling />}
      title="Payment method"
      description="Relayd never stores card numbers. Cards are managed by our payment provider, Stripe, in its hosted portal."
    />
  );

  if (overview.isPending) {
    return (
      <div className="max-w-220">
        {header}
        <div role="status" aria-live="polite" aria-label="Loading payment method" className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((index) => (
            <div key={index} className="flex flex-col gap-3 rounded-card border border-border bg-surface px-5 py-5">
              <Skeleton width={110} />
              <Skeleton height={38} radius={8} />
              <Skeleton width="70%" />
              <Skeleton width={160} height={34} radius={8} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (overview.isError) {
    return (
      <div className="max-w-220">
        {header}
        <ErrorState
          title="We couldn't load your payment method"
          description="Nothing has changed and nothing has been charged. Send support the request ID if it keeps happening."
          requestId={overview.error instanceof ApiError ? overview.error.requestId : undefined}
          onRetry={() => void overview.refetch()}
          retryLabel="Retry"
        />
      </div>
    );
  }

  const method = overview.data.paymentMethod;
  const planName = overview.data.subscription?.planName ?? 'your plan';
  const writeTitle = readOnly ? READ_ONLY_TITLE : canWrite ? undefined : OWNER_ONLY_TITLE;
  const writeBlocked = readOnly || !canWrite;

  return (
    <div className="max-w-220">
      {header}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <div className="text-ui text-text-2">Card on file</div>

          {method === null || method.last4 === null ? (
            <div className="mt-3 text-ui text-text-2">
              No card on file. Add one in the Stripe portal and it appears here.
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-3.5">
              <CardBrand brand={method.brand} size="lg" />
              <span className="min-w-0">
                <span className="block text-body font-medium">•••• •••• •••• {method.last4}</span>
                <span className="block text-caption text-text-2">
                  Expires {formatExpiry(method.expMonth, method.expYear)}
                  {method.holder === undefined || method.holder === null ? '' : ` · ${method.holder}`}
                  {method.addedAt === undefined || method.addedAt === null
                    ? ''
                    : ` · added ${formatDate(method.addedAt)}`}
                </span>
              </span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3.5 text-caption text-text-2">
            {method?.isDefault === true ? <Badge tone="success">Default</Badge> : null}
            <span>Charged on the 1st of each month for the {planName} plan.</span>
          </div>

          <div className="mt-4">
            <Button
              onClick={() => portal.mutate()}
              pending={portal.isPending}
              disabled={writeBlocked}
              title={writeTitle}
            >
              Update in Stripe portal ↗
            </Button>
            <div className="mt-2 text-caption text-text-2">
              Opens a secure page hosted by Stripe. You&apos;ll come back here when you&apos;re done.
            </div>
          </div>
        </Panel>

        <Panel>
          <form
            className="flex flex-col gap-3.5"
            onSubmit={(event) => {
              void form.handleSubmit((values) => save.mutate(values))(event);
            }}
          >
            <div className="font-semibold">Billing details</div>

            <Field
              label="Billing email"
              autoComplete="email"
              disabled={writeBlocked}
              title={writeTitle}
              error={form.formState.errors.email?.message}
              {...form.register('email')}
            />

            <Field
              label="Company name on invoices"
              disabled={writeBlocked}
              title={writeTitle}
              error={form.formState.errors.company?.message}
              {...form.register('company')}
            />

            <Textarea
              label="Address"
              rows={2}
              disabled={writeBlocked}
              title={writeTitle}
              error={form.formState.errors.address?.message}
              {...form.register('address')}
            />

            <Field
              label="Tax ID"
              // The value is mono at 12, as I8 draws it; the label is not.
              // `className` lands on the wrapper, which both would inherit.
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
              disabled={writeBlocked}
              title={writeTitle}
              error={form.formState.errors.taxId?.message}
              {...form.register('taxId')}
            />

            <div className="flex justify-end">
              {/* BACKEND PENDING: PATCH /billing/details */}
              <Button
                type="submit"
                variant="secondary"
                pending={save.isPending}
                disabled={writeBlocked}
                title={writeTitle}
              >
                Save details
              </Button>
            </div>
          </form>
        </Panel>
      </div>
    </div>
  );
}
