import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, ErrorState, Field, Icon, PageHeader, Skeleton } from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import { billingApi, billingKeys } from '../../api/billing.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  BackToBilling,
  ClockGlyph,
  useSafeToast,
  OWNER_ONLY_TITLE,
  Panel,
  READ_ONLY_TITLE,
  formatDate,
  formatDayMonth,
  planInclusions,
} from './parts.js';

/**
 * I9a / I9b — /billing/cancel-subscription.
 *
 * The frame's own promise is the subtitle: "No offers, no extra steps: one
 * confirmation below." So there is no retention flow here, no discount
 * modal, and no second dialog. What there is instead is the full
 * consequence, in two columns — what the customer keeps until the period
 * ends, and what changes the day after — plus an export, because the honest
 * version of "your data is deleted on the 31st" is a button that gets it
 * out first.
 *
 * Cancelling is at period end. There is no "cancel immediately" here: the
 * frames do not offer one, and ending a paid period early with no refund is
 * not a thing to hide behind a radio button.
 */

/** Data is kept this long after the subscription ends, then deleted. */
const RETENTION_DAYS = 30;

function addDays(iso: string | null, days: number): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + days * 86_400_000).toISOString();
}

export function CancelSubscriptionPage() {
  const { current, can, user } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';
  const readOnly = useReadOnly();
  const canWrite = can('billing:write');
  const { toast } = useSafeToast();
  const queryClient = useQueryClient();

  const [reason, setReason] = useState('');
  const [cancelled, setCancelled] = useState<{ endsAt: string | null } | null>(null);

  const overview = useQuery({
    queryKey: billingKeys.overview(workspaceId),
    queryFn: () => billingApi.overview(),
  });
  const plans = useQuery({
    queryKey: billingKeys.plans(workspaceId),
    queryFn: () => billingApi.plans(),
  });

  const cancel = useMutation({
    mutationFn: () =>
      billingApi.cancel({ immediately: false, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(workspaceId) });
      setCancelled(result);
    },
    onError: (error) => {
      toast({
        tone: 'danger',
        title: 'The subscription was not cancelled',
        description: error instanceof ApiError ? error.message : 'Try again in a moment.',
      });
    },
  });

  const exportAll = useMutation({
    mutationFn: () => billingApi.exportEverything(),
    onSuccess: () => {
      toast({
        tone: 'success',
        title: 'Export started',
        description:
          user === null ? 'We will email the link when it is ready.' : `We will email ${user.email} when it is ready.`,
      });
    },
    onError: (error) => {
      toast({
        tone: 'danger',
        title: 'The export did not start',
        description: error instanceof ApiError ? error.message : 'Try again in a moment.',
      });
    },
  });

  const reactivate = useMutation({
    mutationFn: () => billingApi.reactivate(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(workspaceId) });
      setCancelled(null);
      toast({ tone: 'success', title: 'Subscription reactivated' });
    },
    onError: (error) => {
      toast({
        tone: 'danger',
        title: 'We could not reactivate it',
        description: error instanceof ApiError ? error.message : 'Try again in a moment.',
      });
    },
  });

  if (overview.isPending) {
    return (
      <div className="mx-auto max-w-190" role="status" aria-live="polite" aria-label="Loading">
        <div className="mb-5 flex flex-col gap-2">
          <Skeleton width={70} />
          <Skeleton width={320} height={28} radius={6} />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((index) => (
            <div key={index} className="flex flex-col gap-2.5 rounded-card border border-border bg-surface px-5 py-5">
              <Skeleton width={180} />
              <Skeleton />
              <Skeleton />
              <Skeleton width="70%" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (overview.isError) {
    return (
      <div className="mx-auto max-w-190">
        <PageHeader back={<BackToBilling />} title="Cancel subscription" />
        <ErrorState
          title="We couldn't load your subscription"
          description="Nothing has been cancelled. Send support the request ID if it keeps happening."
          requestId={overview.error instanceof ApiError ? overview.error.requestId : undefined}
          onRetry={() => void overview.refetch()}
          retryLabel="Retry"
        />
      </div>
    );
  }

  const subscription = overview.data.subscription;

  if (subscription === null) {
    return (
      <div className="mx-auto max-w-190">
        <PageHeader back={<BackToBilling />} title="Nothing to cancel" description="This workspace is not on a paid plan." />
        <Link to="/billing/plans" className="no-underline">
          <Button>See plans</Button>
        </Link>
      </div>
    );
  }

  const endsAt = cancelled?.endsAt ?? subscription.currentPeriodEnd;
  const deleteAt = addDays(endsAt, RETENTION_DAYS);
  const plan = plans.data?.find((row) => row.code === subscription.planCode);
  const seats = plan?.limits['workspace.seats'] ?? null;

  /* -------------------------------------------------------------- I9b */

  if (cancelled !== null || subscription.cancelAtPeriodEnd) {
    return (
      <div className="mx-auto max-w-190">
        <div className="mb-3 text-ui">
          <BackToBilling />
        </div>

        <Panel pad="p-7">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 flex-none place-items-center rounded-10 bg-success-soft text-success-text">
              <Icon name="check" size={20} strokeWidth={2.25} />
            </span>
            <div className="min-w-0">
              <h1 className="m-0 text-section font-semibold leading-heading">Subscription cancelled</h1>
              <div className="text-ui text-text-2">
                {subscription.planName} stays active until {formatDate(endsAt)}. No further charges.
                {user === null ? '' : ` Confirmation sent to ${user.email}.`}
              </div>
            </div>
          </div>

          <dl className="m-0 mt-4 flex flex-col gap-2 rounded-control border border-border px-4 py-3.5 text-ui">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-text-2">Status</dt>
              <dd className="m-0">
                <Badge tone="neutral">Cancels {formatDate(endsAt)}</Badge>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-text-2">Read-only from</dt>
              <dd className="m-0 text-right">{formatDate(endsAt)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-text-2">Data deleted</dt>
              <dd className="m-0 text-right">{formatDate(deleteAt)} · export until then</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-text-2">Recorded in audit log</dt>
              <dd className="m-0 text-right font-mono text-caption">
                subscription.cancelled{user === null ? '' : ` · ${user.name}`}
              </dd>
            </div>
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => exportAll.mutate()} pending={exportAll.isPending}>
              Export everything
            </Button>
            <Button
              variant="secondary"
              onClick={() => reactivate.mutate()}
              pending={reactivate.isPending}
              disabled={!canWrite || readOnly}
              title={readOnly ? READ_ONLY_TITLE : canWrite ? undefined : OWNER_ONLY_TITLE}
            >
              Reactivate {subscription.planName}
            </Button>
            <span className="flex-1" />
            <Link to="/billing" className="no-underline">
              <Button>Back to billing</Button>
            </Link>
          </div>
        </Panel>
      </div>
    );
  }

  /* -------------------------------------------------------------- I9a */

  const inclusions = planInclusions(plan);
  const writeTitle = readOnly ? READ_ONLY_TITLE : canWrite ? undefined : OWNER_ONLY_TITLE;
  const writeBlocked = readOnly || !canWrite;

  return (
    <div className="mx-auto max-w-190">
      <PageHeader
        back={<BackToBilling />}
        title={`Cancel the ${subscription.planName} subscription?`}
        description="Here is exactly what happens. No offers, no extra steps: one confirmation below."
      />

      <div className="mb-4 grid gap-4 md:grid-cols-2">
        <Panel>
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid h-5.5 w-5.5 flex-none place-items-center rounded-full bg-success-soft text-success-text">
              <Icon name="check" size={13} strokeWidth={2.5} />
            </span>
            You keep until {formatDate(endsAt)}
          </div>
          <ul className="mt-3 mb-0 flex list-disc flex-col gap-1.5 pl-5 text-ui text-text-2">
            <li>Full {subscription.planName} plan: sending, scheduling, API and webhooks</li>
            <li>Every scheduled campaign runs as planned</li>
            <li>
              {seats === null ? 'Every seat' : `All ${seats} seats`} and every team member&apos;s access
            </li>
            <li>No further charges; the {formatDayMonth(endsAt)} invoice is not issued</li>
          </ul>
        </Panel>

        <Panel>
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid h-5.5 w-5.5 flex-none place-items-center rounded-full bg-neutral-soft text-text-2">
              <ClockGlyph size={13} />
            </span>
            From {formatDate(endsAt)}
          </div>
          <ul className="mt-3 mb-0 flex list-disc flex-col gap-1.5 pl-5 text-ui text-text-2">
            <li>Workspace becomes read-only: no sending, imports or API writes</li>
            <li>Contacts, suppressions, templates and reports stay visible for {RETENTION_DAYS} days</li>
            <li>
              Exports work for {RETENTION_DAYS} days, then data is deleted on {formatDayMonth(deleteAt)}
            </li>
            <li>Provider connections are removed; your provider accounts are untouched</li>
          </ul>
          {inclusions === '' ? null : <div className="sr-only">{inclusions}</div>}
        </Panel>
      </div>

      <Panel className="mb-4" pad="px-5 py-4.5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Take your data with you</div>
            <div className="text-pretty text-ui text-text-2">
              Contacts with consent records, suppressions, campaign reports and the audit log, as CSV.
              Ready in a few minutes; link emailed to {user?.email ?? 'your address'}.
            </div>
          </div>
          {/* BACKEND PENDING: POST /billing/export */}
          <Button variant="secondary" onClick={() => exportAll.mutate()} pending={exportAll.isPending}>
            Export everything
          </Button>
        </div>
      </Panel>

      <Panel className="mb-5" pad="px-5 py-4.5">
        <Field
          label={
            <>
              Why are you cancelling?{' '}
              <span className="font-normal text-text-2">· optional, one line</span>
            </>
          }
          placeholder="Helps us improve. Skip if you like."
          value={reason}
          maxLength={200}
          disabled={writeBlocked}
          title={writeTitle}
          onChange={(event) => setReason(event.target.value)}
          className="max-w-130"
        />
      </Panel>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <span className="text-caption text-text-2">
          You can reactivate any time before {formatDayMonth(deleteAt)} and pick up where you left off.
        </span>
        <span className="flex flex-wrap gap-2">
          <Link to="/billing" className="no-underline">
            <Button variant="secondary" size="lg">
              Keep {subscription.planName}
            </Button>
          </Link>
          <Button
            variant="danger"
            size="lg"
            onClick={() => cancel.mutate()}
            pending={cancel.isPending}
            disabled={writeBlocked}
            title={writeTitle}
          >
            Cancel subscription
          </Button>
        </span>
      </div>
    </div>
  );
}
