import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorState, Icon, Modal, PageHeader, Skeleton, fmtCount } from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import {
  billingApi,
  billingKeys,
  type Interval,
  type PlanChangePreview,
  type PlanSummary,
} from '../../api/billing.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  BackToBilling,
  useSafeToast,
  OWNER_ONLY_TITLE,
  READ_ONLY_TITLE,
  featureLabel,
  formatDate,
  formatDayMonth,
  formatMoney,
  formatWholeMoney,
  retentionLabel,
} from './parts.js';

/**
 * I2 — /billing/plans, with I3 as its blocked-downgrade dialog.
 *
 * Nothing on this page compares a plan code to a string. The server sends
 * the plan objects and their ranks; "is this an upgrade" is `rank >` and
 * nothing else, which is also the only comparison that stays correct the
 * first time a promotion moves a price (`relayd/no-plan-literals`, and the
 * catalogue's own note about rank).
 *
 * A downgrade is pre-checked before it is scheduled. "You cannot downgrade"
 * with no explanation is a support ticket; the customer usually can, once
 * they know they need to archive four hundred contacts first. That list is
 * I3, and it links to the page that fixes each row.
 */

interface ComparisonRow {
  key: string;
  label: string;
  /** A string renders as itself, a boolean as a tick or a dash, null as a dash. */
  value: (plan: PlanSummary) => string | boolean | null;
}

/** Reads a catalogue limit, falling back to the plan's own comparison map. */
function limit(plan: PlanSummary, key: string, format: (value: number) => string): string | null {
  const value = plan.limits[key];
  if (value === null) return 'Unlimited';
  if (value !== undefined) return format(value);

  const extra = plan.comparison?.[key];
  if (typeof extra === 'string') return extra;
  return plan.custom === true ? 'Custom' : null;
}

function extra(plan: PlanSummary, key: string): string | boolean | null {
  return plan.comparison?.[key] ?? (plan.custom === true ? 'Custom' : null);
}

/** The twelve rows I2 compares, in the frame's order. */
const COMPARISON: readonly ComparisonRow[] = [
  { key: 'emails', label: 'Emails / month', value: (plan) => limit(plan, 'emails.sent', fmtCount) },
  {
    key: 'overage',
    label: 'Overage per 1,000',
    value: (plan) =>
      plan.overagePer1000 === undefined || plan.overagePer1000 === null
        ? (extra(plan, 'overage') ?? null)
        : formatMoney(plan.overagePer1000, plan.price?.currency ?? 'usd'),
  },
  { key: 'contacts', label: 'Contacts', value: (plan) => limit(plan, 'contacts.stored', fmtCount) },
  {
    key: 'retention',
    label: 'Analytics retention',
    value: (plan) => limit(plan, 'analytics.retention_days', (days) => retentionLabel(days)),
  },
  { key: 'seats', label: 'Seats', value: (plan) => limit(plan, 'workspace.seats', (n) => String(n)) },
  {
    key: 'connections',
    label: 'Provider connections',
    value: (plan) => extra(plan, 'providers.connections'),
  },
  {
    key: 'pools',
    label: 'Sending pools',
    value: (plan) => plan.flags['campaigns.sending_pools'] ?? extra(plan, 'campaigns.sending_pools'),
  },
  {
    key: 'api',
    label: 'API keys and webhooks',
    value: (plan) => plan.flags['api.access'] ?? extra(plan, 'api.access'),
  },
  {
    key: 'complaints',
    label: 'Per-campaign complaint thresholds',
    value: (plan) => extra(plan, 'complaint.thresholds'),
  },
  {
    key: 'audit',
    label: 'Audit log export · SIEM webhook',
    value: (plan) => extra(plan, 'audit.export'),
  },
  { key: 'sso', label: 'SSO (SAML) and SCIM', value: (plan) => extra(plan, 'sso') },
  { key: 'support', label: 'Support', value: (plan) => extra(plan, 'support') },
];

export function PlansPage() {
  const navigate = useNavigate();
  const { toast } = useSafeToast();
  const queryClient = useQueryClient();
  const { current, can } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';
  const readOnly = useReadOnly();
  const canWrite = can('billing:write');

  const [interval, setInterval] = useState<Interval>('month');
  const [blocked, setBlocked] = useState<{ plan: PlanSummary; preview: PlanChangePreview } | null>(
    null,
  );

  const plans = useQuery({
    queryKey: billingKeys.plans(workspaceId),
    queryFn: () => billingApi.plans(),
  });
  const overview = useQuery({
    queryKey: billingKeys.overview(workspaceId),
    queryFn: () => billingApi.overview(),
  });

  /**
   * What each plan would cost or schedule, asked of the server.
   *
   * I2 prints the consequence under every button — "Charged $200.00 today
   * for 20 Sep – 30 Sep", "Nothing changes until 1 Oct" — and the only place
   * those numbers exist is the pre-check endpoint. One query per plan, all
   * cached under the plan-change key the confirm flow reads back.
   */
  const previews = useQueries({
    queries: (plans.data ?? [])
      .filter((plan) => plan.custom !== true)
      .map((plan) => ({
        queryKey: billingKeys.planChange(workspaceId, plan.code),
        queryFn: () => billingApi.planChangePreview(plan.code),
      })),
  });

  const previewFor = (code: string): PlanChangePreview | undefined => {
    const index = (plans.data ?? []).filter((plan) => plan.custom !== true).findIndex((plan) => plan.code === code);
    return index === -1 ? undefined : previews[index]?.data;
  };

  const schedule = useMutation({
    mutationFn: (plan: PlanSummary) => billingApi.changePlan({ planCode: plan.code, interval }),
    onSuccess: (result, plan) => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(workspaceId) });
      toast({
        tone: 'success',
        title: `${plan.name} scheduled`,
        description:
          result.effectiveAt === null
            ? 'Nothing changes until the period ends.'
            : `Takes effect ${formatDate(result.effectiveAt)}. Nothing changes until then.`,
      });
    },
    onError: (error) => {
      toast({
        tone: 'danger',
        title: 'That change did not go through',
        description: error instanceof ApiError ? error.message : 'Try again in a moment.',
      });
    },
  });

  const [checking, setChecking] = useState<string | null>(null);

  const choose = async (plan: PlanSummary, direction: 'up' | 'down') => {
    if (direction === 'up') {
      navigate('/billing/checkout', { state: { planCode: plan.code, interval } });
      return;
    }

    setChecking(plan.code);
    try {
      const preview = await queryClient.fetchQuery({
        queryKey: billingKeys.planChange(workspaceId, plan.code),
        queryFn: () => billingApi.planChangePreview(plan.code),
      });

      if (preview.blocked) setBlocked({ plan, preview });
      else schedule.mutate(plan);
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'We could not check that downgrade',
        description: error instanceof ApiError ? error.message : 'Try again in a moment.',
      });
    } finally {
      setChecking(null);
    }
  };

  const header = (
    <PageHeader
      back={<BackToBilling />}
      title="Plans"
      description="Upgrades apply now and are prorated to 1 Oct. Downgrades are scheduled for 1 Oct so you keep what you paid for."
      actions={
        <span className="inline-flex items-center gap-1 rounded-10 border border-border bg-surface p-1">
          {(
            [
              { value: 'month' as const, label: 'Monthly' },
              { value: 'year' as const, label: 'Annual · 2 months free' },
            ] satisfies { value: Interval; label: string }[]
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={interval === option.value}
              onClick={() => setInterval(option.value)}
              className={[
                'h-7.5 cursor-pointer rounded-[7px] border-0 px-3 text-caption font-medium',
                interval === option.value ? 'bg-brand-soft text-brand' : 'bg-transparent text-text-2',
              ].join(' ')}
            >
              {option.label}
            </button>
          ))}
        </span>
      }
    />
  );

  if (plans.isPending) {
    return (
      <>
        {header}
        <div role="status" aria-live="polite" aria-label="Loading plans" className="rounded-card border border-border bg-surface p-5">
          <div className="grid gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="flex flex-col gap-3">
                <Skeleton width={90} />
                <Skeleton width={120} height={28} radius={6} />
                <Skeleton height={34} radius={8} />
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-col gap-3">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <Skeleton key={index} height={16} />
            ))}
          </div>
        </div>
      </>
    );
  }

  if (plans.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="We couldn't load plans"
          description="Your subscription and payment method are unaffected. Send support the request ID if it keeps happening."
          requestId={plans.error instanceof ApiError ? plans.error.requestId : undefined}
          onRetry={() => void plans.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  const ordered = [...plans.data].sort((a, b) => a.rank - b.rank);
  const currentCode = overview.data?.subscription?.planCode ?? null;
  const currentRank = ordered.find((plan) => plan.code === currentCode)?.rank ?? null;
  const columns = `220px repeat(${ordered.length}, minmax(160px, 1fr))`;
  const disabledTitle = readOnly ? READ_ONLY_TITLE : canWrite ? undefined : OWNER_ONLY_TITLE;

  return (
    <>
      {header}

      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <div style={{ minWidth: 240 + ordered.length * 170 }}>
          <div className="grid" style={{ gridTemplateColumns: columns }}>
            <div className="px-4.5 py-5" />
            {ordered.map((plan) => {
              const isCurrent = plan.code === currentCode;
              const direction =
                currentRank === null || plan.rank > currentRank
                  ? 'up'
                  : plan.rank < currentRank
                    ? 'down'
                    : 'same';

              return (
                <div
                  key={plan.code}
                  className={`flex flex-col gap-2 px-4.5 py-5 ${isCurrent ? 'bg-brand-soft' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-card font-semibold">{plan.name}</span>
                    {isCurrent ? (
                      <span className="inline-flex h-5 items-center rounded-badge bg-brand px-1.75 text-label font-medium text-on-brand">
                        Current
                      </span>
                    ) : null}
                  </div>

                  <PlanPrice plan={plan} interval={interval} />

                  <PlanAction
                    plan={plan}
                    direction={direction}
                    interval={interval}
                    currentPeriodEnd={overview.data?.subscription?.currentPeriodEnd ?? null}
                    preview={previewFor(plan.code)}
                    canWrite={canWrite}
                    readOnly={readOnly}
                    disabledTitle={disabledTitle}
                    pending={checking === plan.code || (schedule.isPending && schedule.variables?.code === plan.code)}
                    onChoose={() => void choose(plan, direction === 'down' ? 'down' : 'up')}
                  />
                </div>
              );
            })}
          </div>

          {COMPARISON.map((row) => (
            <div
              key={row.key}
              className="grid border-t border-border text-ui"
              style={{ gridTemplateColumns: columns }}
            >
              <div className="flex items-center px-4.5 py-2.75 text-text-2">{row.label}</div>
              {ordered.map((plan) => (
                <div
                  key={plan.code}
                  className={`flex items-center px-4.5 py-2.75 font-medium ${plan.code === currentCode ? 'bg-brand-soft' : ''}`}
                >
                  <CellValue value={row.value(plan)} />
                </div>
              ))}
            </div>
          ))}

          <div className="flex items-start gap-2.5 border-t border-border px-4.5 py-3.5 text-caption text-text-2">
            <Icon name="info" size={14} strokeWidth={2} className="mt-0.5 flex-none" />
            <span className="text-pretty">
              <span className="font-semibold text-text">Retention applies forward.</span> Analytics
              already archived under a shorter window are not restored on upgrade. Downgrading
              archives reports older than the new window on the day the downgrade takes effect; you
              can export them before then.
            </span>
          </div>
        </div>
      </div>

      <DowngradeBlocked
        blocked={blocked}
        onClose={() => setBlocked(null)}
        fits={ordered
          .filter((plan) => blocked !== null && plan.rank > blocked.plan.rank && plan.custom !== true)
          .map((plan) => plan.name)}
      />
    </>
  );
}

function PlanPrice({ plan, interval }: { plan: PlanSummary; interval: Interval }) {
  const price = plan.price;
  const amount = price === undefined ? null : interval === 'year' ? price.year : price.month;

  if (price === undefined || amount === null) {
    return (
      <>
        <div className="flex items-baseline gap-1">
          <span className="text-[28px] leading-heading font-semibold tracking-heading">Custom</span>
        </div>
        <div className="h-4.5 text-caption text-text-2">Annual contract</div>
      </>
    );
  }

  return (
    <>
      <div className="flex items-baseline gap-1">
        <span className="text-[28px] leading-heading font-semibold tracking-heading">
          {formatWholeMoney(amount, price.currency)}
        </span>
        <span className="text-ui text-text-2">/ month</span>
      </div>
      <div className="h-4.5 text-caption text-text-2">
        {interval === 'year' ? 'billed yearly' : 'billed monthly'}
      </div>
    </>
  );
}

function PlanAction({
  plan,
  direction,
  interval,
  currentPeriodEnd,
  preview,
  canWrite,
  readOnly,
  disabledTitle,
  pending,
  onChoose,
}: {
  plan: PlanSummary;
  direction: 'up' | 'down' | 'same';
  interval: Interval;
  currentPeriodEnd: string | null;
  preview: PlanChangePreview | undefined;
  canWrite: boolean;
  readOnly: boolean;
  disabledTitle: string | undefined;
  pending: boolean;
  onChoose: () => void;
}) {
  if (plan.custom === true) {
    return (
      <>
        <a
          href="mailto:sales@relayd.io"
          className="flex h-[34px] w-full items-center justify-center rounded-control border border-border bg-surface text-ui font-medium text-text no-underline"
        >
          Talk to sales
        </a>
        <div className="text-label text-text-2">&nbsp;</div>
      </>
    );
  }

  if (direction === 'same') {
    return (
      <>
        <Button disabled block title="This is the plan you are on">
          Current plan
        </Button>
        <div className="text-label text-text-2">
          {currentPeriodEnd === null ? '' : `Renews ${formatDate(currentPeriodEnd)}`}
        </div>
      </>
    );
  }

  const blockedByRole = !canWrite || readOnly;
  const effectiveAt = preview?.effectiveAt ?? currentPeriodEnd;
  const effective = effectiveAt === null ? 'the period end' : formatDayMonth(effectiveAt);
  const proration = preview?.proration ?? null;

  return (
    <>
      <Button
        block
        variant={direction === 'up' ? 'primary' : 'secondary'}
        onClick={onChoose}
        pending={pending}
        disabled={blockedByRole}
        title={blockedByRole ? disabledTitle : undefined}
      >
        {direction === 'up' ? 'Upgrade now — prorated' : `Schedule downgrade for ${effective}`}
      </Button>
      <div className="text-label text-text-2">
        {direction === 'down'
          ? `Nothing changes until ${effective}`
          : proration === null
            ? interval === 'year'
              ? 'Charged today, prorated to the renewal'
              : 'Charged today for the rest of this period'
            : `Charged ${formatMoney(proration.dueToday, proration.currency)} today for ${proration.periodLabel}`}
      </div>
    </>
  );
}

function CellValue({ value }: { value: string | boolean | null }) {
  if (value === true) {
    return (
      <span className="text-success-text">
        <Icon name="check" size={16} strokeWidth={2.25} />
      </span>
    );
  }
  if (value === false || value === null) return <span className="text-text-3">—</span>;
  return <span>{value}</span>;
}

/* ------------------------------------------------------------------ I3 */

function DowngradeBlocked({
  blocked,
  onClose,
  fits,
}: {
  blocked: { plan: PlanSummary; preview: PlanChangePreview } | null;
  onClose: () => void;
  fits: string[];
}) {
  const { current } = useAuth();
  const workspaceName = current?.workspaceName ?? 'This workspace';

  if (blocked === null) return null;

  const { plan, preview } = blocked;
  const count = preview.conflicts.length;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 flex-none place-items-center rounded-control bg-warning-soft text-warning-text">
            <Icon name="alert" size={18} strokeWidth={2} />
          </span>
          Can&apos;t schedule the downgrade to {plan.name} yet
        </span>
      }
      description={`${workspaceName} is over ${count === 1 ? 'one' : count} ${plan.name} limit${count === 1 ? '' : 's'}. Bring each one under the limit, then schedule the downgrade for ${preview.effectiveAt === null || preview.effectiveAt === undefined ? 'the end of the period' : formatDate(preview.effectiveAt)}. Nothing is changed or charged now.`}
      footer={
        <span className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-caption text-text-2">
            {fits.length === 0 ? '' : `${fits.join(' and ')} fit your current usage.`}
          </span>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button disabled title="Bring each item under the limit first">
              Schedule downgrade
            </Button>
          </span>
        </span>
      }
    >
      <div className="overflow-x-auto rounded-control border border-border">
        <table className="w-full border-collapse text-ui">
          <thead className="bg-tint text-caption font-medium text-text-2">
            <tr>
              <th scope="col" className="px-3.5 py-2 text-left font-medium">
                Over the limit
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Current
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                {plan.name} limit
              </th>
              <th scope="col" className="px-3.5 py-2 text-right font-medium">
                Fix
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.conflicts.map((conflict) => (
              <tr key={conflict.feature} className="border-t border-border">
                <td className="px-3.5 py-2">
                  <div className="font-medium">{featureLabel(conflict.feature)}</div>
                  {conflict.hint === undefined ? null : (
                    <div className="text-caption text-text-2">{conflict.hint}</div>
                  )}
                </td>
                <td className="px-2 py-2 text-right font-medium text-danger-text tabular-nums">
                  {fmtCount(conflict.current)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtCount(conflict.targetLimit)}</td>
                <td className="px-3.5 py-2 text-right">
                  {conflict.fixHref === undefined ? (
                    <span className="text-caption text-text-3">—</span>
                  ) : (
                    <a href={conflict.fixHref} className="text-caption font-medium text-brand no-underline">
                      {conflict.fixLabel ?? 'Fix'} →
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
