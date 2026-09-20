import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Badge, Button, ErrorState, Icon, Skeleton } from '@relayd/ui';
import { ApiError } from '../api/client.js';
import { audienceApi, audienceKeys } from '../api/audience.js';
import { campaignKeys, campaignsApi } from '../api/campaigns.js';
import {
  PROVIDER_INFO,
  providerApi,
  providerKeys,
  type Connection,
  type ProviderInfo,
} from '../api/providers.js';
import { useAuth } from '../auth/AuthProvider.js';

/**
 * The first-run checklist: connect a provider, verify a sender, import an
 * audience, send a test (design/B Auth & onboarding.dc.html B6b at
 * /get-started; design/C Dashboard.dc.html C3 for the compact card the
 * dashboard shows until all four are done).
 *
 * There is no onboarding endpoint and there should not be one: every step
 * is a question the existing collection endpoints already answer, and a
 * server-side `onboarding_state` column would be a second copy of the truth
 * that can disagree with it. So the four steps are *derived* — connect a
 * provider from GET /providers, verify a sender from GET /senders, import
 * contacts from GET /audience/imports, send a test from GET /campaigns —
 * and they cannot go stale, because the thing they are derived from is the
 * thing the step is about.
 *
 * `complete` stays separate from `steps`, as the stub's contract had it: a
 * consumer decides whether to show anything from `complete`, and an empty
 * `steps` means "not known yet", never "done". `loading` says which.
 */

export type OnboardingStatus = 'done' | 'pending' | 'todo' | 'locked';

export interface OnboardingStep {
  key: string;
  /** 1–4, the number the incomplete marks show. */
  step: number;
  /** The step's name: the original contract's field, kept. */
  label: string;
  done: boolean;
  /** Where the step's button goes. */
  href: string;
  status: OnboardingStatus;
  /** "Done", "Pending DNS", "Not started", "Locked". */
  statusLabel: string;
  /** B6b's sentence. */
  detail: string;
  /** C3's shorter one. */
  detailShort: string;
  /** B6b's button. */
  action: string;
  /** C3's button. */
  actionShort: string;
  /** Why the button is disabled, when it is. */
  tip?: string;
}

export interface OnboardingProgress {
  steps: OnboardingStep[];
  complete: boolean;
  completed: number;
  total: number;
  /** True until the first answer is known. Nothing should be decided on it. */
  loading: boolean;
  /** The first of the four reads that failed, if any. */
  error: unknown;
  /** Retries all four. */
  retry: () => void;
}

const STATUS_LABEL: Record<OnboardingStatus, string> = {
  done: 'Done',
  pending: 'Pending DNS',
  todo: 'Not started',
  locked: 'Locked',
};

/**
 * "Amazon SES · eu-west-1 · production" — what the step calls a connection.
 *
 * The frames write the brand and the connection's own label together, which
 * is two fields here: `providerType` names the brand and `name` is whatever
 * the customer called this connection. Both are shown, because "eu-west-1 ·
 * production" alone does not say which provider is about to send.
 */
function connectionName(connection: Connection): string {
  // Typed as possibly absent on purpose: `providerType` is whatever the API
  // sent, and a provider this build has never heard of must not take the
  // page down. Then the connection's own name stands alone.
  const info: ProviderInfo | undefined = PROVIDER_INFO[connection.providerType];
  return info === undefined ? connection.name : `${info.label} · ${connection.name}`;
}

/**
 * "19 Sep", the form B6b's detail lines use.
 *
 * Spelled from a list, not `toLocaleDateString`: a current ICU writes
 * September as "Sept", and the frames use three letters for every month.
 */
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function day(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCDate()} ${MONTH[date.getUTCMonth()] ?? ''}`;
}

export function useOnboardingProgress(): OnboardingProgress {
  // Provider keys are workspace-scoped functions (docs/09: every key starts
  // with the workspace id, so switching workspaces cannot show stale data).
  const { currentWorkspaceId } = useAuth();
  const workspaceId = currentWorkspaceId ?? 'none';

  const connections = useQuery({
    queryKey: providerKeys.connections(workspaceId),
    queryFn: providerApi.list,
  });
  const senders = useQuery({
    queryKey: providerKeys.senders(workspaceId),
    queryFn: () => providerApi.listSenders(),
  });
  const imports = useQuery({ queryKey: audienceKeys.imports, queryFn: audienceApi.listImports });
  const campaigns = useQuery({
    queryKey: [...campaignKeys.all, { search: '', state: '' }],
    queryFn: () => campaignsApi.list(),
  });

  const loading =
    connections.isPending || senders.isPending || imports.isPending || campaigns.isPending;

  // A failed read is not "not started". Without this the four steps would
  // all read "Not started" for a workspace that has done all four, and the
  // page would be telling a confident lie.
  const failure = [connections, senders, imports, campaigns].find((query) => query.isError)?.error;

  const connection = (connections.data ?? []).find((row) => row.status === 'active') ?? connections.data?.[0];
  const senderRows = senders.data ?? [];
  const activeSender = senderRows.find((row) => row.status === 'active');
  const importRows = (imports.data ?? []).filter((row) => row.status === 'completed');
  const launched = (campaigns.data?.items ?? []).filter((row) => row.launchedAt !== null);

  const providerDone = connection !== undefined && connection.status === 'active';
  const senderDone = activeSender !== undefined;
  const senderPending = !senderDone && senderRows.length > 0;
  const contactsDone = importRows.length > 0;
  const testDone = launched.length > 0;

  const steps: OnboardingStep[] = [
    {
      key: 'provider',
      step: 1,
      label: 'Connect a provider',
      done: providerDone,
      href: '/providers',
      status: providerDone ? 'done' : 'todo',
      statusLabel: STATUS_LABEL[providerDone ? 'done' : 'todo'],
      detail:
        connection === undefined
          ? 'Relayd never sends through its own servers. Connect Amazon SES, SendGrid, Mailgun, Brevo or your own SMTP.'
          : `${connectionName(connection)} connected ${day(connection.createdAt)}. ${
              connection.hasWebhookSecret ? 'Webhook is receiving events.' : 'No inbound webhook yet.'
            }`,
      detailShort:
        connection === undefined
          ? 'SES, SendGrid, Mailgun, Brevo or SMTP'
          : `${connectionName(connection)} connected`,
      action: providerDone ? 'View connection' : 'Connect a provider',
      actionShort: providerDone ? 'View' : 'Connect',
    },
    {
      key: 'sender',
      step: 2,
      label: 'Verify a sender',
      done: senderDone,
      href: '/senders',
      status: senderDone ? 'done' : senderPending ? 'pending' : 'todo',
      statusLabel: STATUS_LABEL[senderDone ? 'done' : senderPending ? 'pending' : 'todo'],
      detail: senderDone
        ? `${activeSender.fromEmail} is verified and sending.`
        : senderPending
          ? `${senderRows[0]?.fromEmail ?? 'Your sender'} · waiting for DKIM and DMARC records at your DNS host.`
          : 'Verify the address your campaigns come from. SPF, DKIM and DMARC are checked at your DNS host.',
      detailShort: senderDone
        ? `${activeSender.fromEmail} verified`
        : senderPending
          ? `${senderRows[0]?.fromEmail ?? 'Your sender'} · waiting for DKIM records`
          : 'SPF, DKIM and DMARC at your DNS host',
      action: senderDone ? 'View sender' : senderPending ? 'Check DNS' : 'Add a sender',
      actionShort: senderDone ? 'View' : senderPending ? 'Check DNS' : 'Add',
    },
    {
      key: 'contacts',
      step: 3,
      label: 'Import contacts',
      done: contactsDone,
      href: '/audience/imports',
      status: contactsDone ? 'done' : 'todo',
      statusLabel: STATUS_LABEL[contactsDone ? 'done' : 'todo'],
      detail: contactsDone
        ? `${importRows.length} import${importRows.length === 1 ? '' : 's'} completed. Add more whenever you need to.`
        : 'CSV or XLSX up to 50 MB. You will map columns and confirm consent before anything is saved.',
      detailShort: contactsDone ? 'Audience imported' : 'CSV or XLSX, up to 50 MB',
      action: contactsDone ? 'View imports' : 'Import contacts',
      actionShort: contactsDone ? 'View' : 'Import',
    },
    {
      key: 'test',
      step: 4,
      label: 'Send a test',
      done: testDone,
      href: '/senders',
      status: testDone ? 'done' : senderDone ? 'todo' : 'locked',
      statusLabel: STATUS_LABEL[testDone ? 'done' : senderDone ? 'todo' : 'locked'],
      detail: testDone
        ? 'You have sent through your provider. Everything is connected.'
        : 'Available once a sender is verified. Sends one email to you through your provider.',
      detailShort: testDone ? 'Sent through your provider' : 'Available once a sender is verified',
      action: 'Send test',
      actionShort: 'Send test',
      ...(testDone || senderDone ? {} : { tip: 'Verify a sender first' }),
    },
  ];

  const completed = steps.filter((step) => step.done).length;

  return {
    steps,
    complete: failure === undefined && !loading && completed === steps.length,
    completed,
    total: steps.length,
    loading,
    error: failure,
    retry: () => {
      void connections.refetch();
      void senders.refetch();
      void imports.refetch();
      void campaigns.refetch();
    },
  };
}

/** The numbered or ticked circle at the left of a row. */
function Mark({ step, compact }: { step: OnboardingStep; compact: boolean }) {
  const size = compact ? 'h-6 w-6 text-caption' : 'h-8 w-8 text-ui';

  if (step.done) {
    return (
      <span className={`grid flex-none place-items-center rounded-full bg-success text-white ${size}`}>
        <Icon name="check" size={compact ? 13 : 16} strokeWidth={2.5} />
      </span>
    );
  }

  const pending = step.status === 'pending';
  const tone = pending
    ? 'border-warning bg-warning-soft text-warning-text'
    : compact
      ? 'border-border bg-neutral-soft text-text-2'
      : `border-border bg-surface ${step.status === 'locked' ? 'text-text-3' : 'text-text-2'}`;

  return (
    <span className={`grid flex-none place-items-center rounded-full border font-semibold ${size} ${tone}`}>
      {step.step}
    </span>
  );
}

function rowBadge(step: OnboardingStep) {
  if (step.status === 'done') return <Badge tone="success">{step.statusLabel}</Badge>;
  if (step.status === 'pending')
    return (
      <Badge tone="warning" pulse>
        {step.statusLabel}
      </Badge>
    );
  if (step.status === 'locked')
    return (
      <Badge tone="neutral" dot="bot">
        {step.statusLabel}
      </Badge>
    );
  return <Badge tone="neutral">{step.statusLabel}</Badge>;
}

function StepRow({
  step,
  compact,
  onGo,
}: {
  step: OnboardingStep;
  compact: boolean;
  onGo: (href: string) => void;
}) {
  const locked = step.status === 'locked';
  // B6b puts the brand button on the step you are meant to do next; C3 only
  // on the "not started" one, leaving "pending" on the quiet button.
  const primary = compact ? step.status === 'todo' : step.status === 'todo' || step.status === 'pending';

  return (
    <div
      className={
        compact
          ? 'flex items-center gap-3 border-t border-border px-4.5 py-3'
          : // The frame's single row at full width. There is no mobile frame
            // for B6b, so at a phone's width the row wraps and the button
            // takes the second line, right-aligned, rather than squeezing a
            // four-word heading into two lines beside it.
            'flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border px-4 py-4 sm:px-5 sm:py-4.5'
      }
    >
      <Mark step={step} compact={compact} />

      <div className={compact ? 'min-w-0 flex-1' : 'min-w-0 flex-1 basis-[220px]'}>
        {compact ? (
          <div className="text-ui font-medium">{step.label}</div>
        ) : (
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-body font-semibold">{step.label}</span>
            {rowBadge(step)}
          </div>
        )}
        <div className={`text-text-2 text-pretty ${compact ? 'text-caption' : 'mt-0.5 text-ui'}`}>
          {compact ? step.detailShort : step.detail}
        </div>
      </div>

      <Button
        variant={primary ? 'primary' : 'secondary'}
        disabled={locked}
        title={step.tip ?? (compact ? step.actionShort : step.action)}
        className={compact ? 'h-[30px] px-2.5 text-caption' : 'ml-auto'}
        onClick={() => onGo(step.href)}
      >
        {compact ? step.actionShort : step.action}
      </Button>
    </div>
  );
}

export interface OnboardingChecklistProps {
  /** C3's dashboard card. Omitted, it is B6b's full-width card. */
  compact?: boolean | undefined;
  /** B6b's last row: when the new-account cap lifts. Hidden without it. */
  capLiftsOn?: string | undefined;
}

/**
 * The checklist card.
 *
 * The compact form renders nothing once every step is done — which is what
 * "This checklist stays here until all four steps are done" means on the
 * consuming side — and nothing while the answer is still loading, so a
 * dashboard does not flash a checklist at a workspace that finished
 * onboarding months ago.
 *
 * The full form (B6b) is the page, so it always draws something: a skeleton
 * of the four rows while the reads are in flight, K4d's error card if one of
 * them fails, and the finished list when all four are done.
 */
export function OnboardingChecklist({ compact = false, capLiftsOn }: OnboardingChecklistProps) {
  const { steps, complete, completed, total, loading, error, retry } = useOnboardingProgress();
  const navigate = useNavigate();

  // The dashboard's card is an aside: while the answer is unknown, or once
  // it is "nothing left to do", it shows nothing at all. B6b is a whole page
  // about these four steps, so it owes the reader a skeleton, an error and
  // the finished list instead of a blank screen.
  if (compact && (loading || complete)) return null;

  if (!compact && loading) {
    return (
      <div className="overflow-hidden rounded-card border border-border bg-surface">
        {steps.map((step) => (
          <div key={step.key} className="flex items-center gap-4 border-b border-border px-4 py-4 sm:px-5 sm:py-4.5">
            <Skeleton width={32} height={32} radius={16} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton width={160} height={14} />
              <Skeleton width={320} height={13} />
            </div>
            <Skeleton width={110} height={34} radius={8} />
          </div>
        ))}
      </div>
    );
  }

  if (!compact && error !== undefined) {
    return (
      <ErrorState
        size="table"
        title="We couldn't check your setup"
        description="Nothing is wrong with your workspace — we just could not read its providers, senders, imports and campaigns. Try again, and send support the request ID if it keeps happening."
        requestId={error instanceof ApiError ? error.requestId : undefined}
        onRetry={retry}
        retryLabel="Retry"
      />
    );
  }

  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      {compact ? (
        <>
          <div className="flex items-center justify-between px-4.5 pb-2.5 pt-3.5">
            <span className="font-semibold">Get set up</span>
            <span className="text-caption text-text-2">
              {completed} of {total} complete
            </span>
          </div>
          <div className="mx-4.5 mb-3 h-1 overflow-hidden rounded-2 bg-neutral-soft">
            <div className="h-full rounded-2 bg-brand" style={{ width: `${percent}%` }} />
          </div>
        </>
      ) : null}

      {steps.map((step) => (
        <StepRow key={step.key} step={step} compact={compact} onGo={(href) => navigate(href)} />
      ))}

      {compact ? (
        <div className="border-t border-border px-4.5 py-3 text-caption text-text-2">
          This checklist stays here until all four steps are done.
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 text-ui text-text-2 sm:px-5">
          <span>
            {capLiftsOn === undefined
              ? 'New accounts are capped at 500 sends a day for their first 7 days.'
              : `The 500/day new-account cap lifts automatically on ${capLiftsOn}.`}
          </span>
          <Link to="/dashboard" className="font-medium text-brand no-underline hover:text-brand-hover">
            Skip for now — go to dashboard →
          </Link>
        </div>
      )}
    </div>
  );
}
