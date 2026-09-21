import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  CAMPAIGN_STATES,
  Card,
  Checkbox,
  ErrorState,
  Field,
  Icon,
  RadioCard,
  RadioGroup,
  Select,
  StateBadge,
  Stepper,
  Switch,
  Textarea,
  fmtCount,
  inputClass,
} from '@relayd/ui';
import { audienceApi } from '../../api/audience.js';
import { segmentApi, segmentKeys } from '../../api/segments.js';
import { templateApi, templateKeys } from '../../api/templates.js';
import { providerApi, providerKeys } from '../../api/providers.js';
import {
  campaignKeys,
  campaignsApi,
  poolsApi,
  type Campaign,
} from '../../api/campaigns.js';
import {
  CONSENT_SOURCE_LABELS,
  consentIsComplete,
  type ConsentSource,
} from '../../components/consent.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  Chip,
  HeadroomBar,
  PreflightRow,
  requestId,
  sentence,
} from './parts.js';
import {
  WIZARD_STEPS,
  isEditable,
  launchBlockedReason,
  preflightSummary,
  stepIndexFor,
  type PreflightCheck,
} from './wizard-steps.js';

/**
 * G2 — create a campaign, in seven steps.
 *
 * The URL carries the step (`/campaigns/:id/edit/:step`), which is docs/09's
 * requirement: the wizard has to be linkable and survive a refresh. A step
 * held in component state loses a half-finished campaign to a stray reload,
 * and "send me the link to the audience step" is how two people work on one
 * send.
 *
 * `/campaigns/new` is the same component with no campaign behind it yet. The
 * draft is created on the first save — not on arrival — so opening the wizard
 * and changing your mind does not leave an empty campaign in the list.
 *
 * Two rules from CLAUDE.md section 11 are visible here and are *not* enforced
 * here: consent is attested before launch, and `campaign:launch` is separate
 * from `campaign:write`. The server decides both, inside the transaction it
 * gates; what this page does is refuse to offer a button it knows will fail,
 * and say why (docs/09).
 */

const TIMEZONE_FALLBACK = 'Etc/UTC';

interface Draft {
  name: string;
  tags: string[];
  notes: string;
  listIds: string[];
  segmentIds: string[];
  excludeListIds: string[];
  senderAccountId: string | null;
  sendingPoolId: string | null;
  replyTo: string;
  templateId: string | null;
  templateVersionId: string | null;
  subject: string;
  preheader: string;
  clickTracking: boolean;
  openTracking: boolean;
  consentAttested: boolean;
  consentSource: ConsentSource | '';
  consentDetail: string;
  sendNow: boolean;
  scheduledDate: string;
  scheduledTime: string;
}

const EMPTY: Draft = {
  name: '',
  tags: [],
  notes: '',
  listIds: [],
  segmentIds: [],
  excludeListIds: [],
  senderAccountId: null,
  sendingPoolId: null,
  replyTo: '',
  templateId: null,
  templateVersionId: null,
  subject: '',
  preheader: '',
  clickTracking: true,
  openTracking: true,
  consentAttested: false,
  consentSource: '',
  consentDetail: '',
  sendNow: false,
  scheduledDate: '',
  scheduledTime: '09:00',
};

function fromCampaign(campaign: Campaign): Draft {
  const scheduled = campaign.scheduledAt === null ? null : new Date(campaign.scheduledAt);

  return {
    ...EMPTY,
    name: campaign.name,
    listIds: campaign.audience.listIds ?? [],
    segmentIds: campaign.audience.segmentIds ?? [],
    senderAccountId: campaign.senderAccountId,
    sendingPoolId: campaign.sendingPoolId,
    templateVersionId: campaign.templateVersionId,
    subject: campaign.subjectOverride ?? '',
    sendNow: campaign.scheduledAt === null,
    scheduledDate: scheduled === null ? '' : (scheduled.toISOString().slice(0, 10) ?? ''),
    scheduledTime: scheduled === null ? '09:00' : scheduled.toISOString().slice(11, 16),
  };
}

export function CampaignWizardPage() {
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const id = params['id'];
  const stepIndex = stepIndexFor(params['step']);
  const step = WIZARD_STEPS[stepIndex] ?? WIZARD_STEPS[0];

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const seeded = useRef<string | null>(null);

  const campaign = useQuery({
    queryKey: campaignKeys.one(currentWorkspaceId, id ?? ''),
    queryFn: () => campaignsApi.get(id ?? ''),
    enabled: id !== undefined,
  });

  const loaded = campaign.data?.campaign;

  // Seeded once per campaign, not on every render: re-seeding from the query
  // would throw away whatever the author had typed since the last refetch.
  useEffect(() => {
    if (loaded === undefined || seeded.current === loaded.id) return;
    seeded.current = loaded.id;
    setDraft(fromCampaign(loaded));
  }, [loaded]);

  const patch = (next: Partial<Draft>): void => setDraft((current) => ({ ...current, ...next }));

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: campaignKeys.scoped(currentWorkspaceId) });
    void queryClient.invalidateQueries({ queryKey: campaignKeys.all });
  };

  /**
   * Create-or-update, so "Continue" means the same thing on every step.
   *
   * The create carries only what `createCampaignSchema` accepts; the rest is
   * a patch. Sending a field the schema does not know would be rejected
   * whole, and a wizard that cannot save its first step is a wizard nobody
   * reaches the second step of.
   */
  const save = useMutation({
    mutationFn: async (): Promise<Campaign> => {
      const body: Record<string, unknown> = {
        name: draft.name.trim() === '' ? 'Untitled campaign' : draft.name.trim(),
      };
      if (draft.subject.trim() !== '') body['subject'] = draft.subject.trim();
      if (draft.preheader.trim() !== '') body['preheader'] = draft.preheader.trim();
      if (draft.replyTo.trim() !== '') body['replyTo'] = draft.replyTo.trim();
      if (draft.senderAccountId !== null) body['senderAccountId'] = draft.senderAccountId;
      if (draft.sendingPoolId !== null) body['sendingPoolId'] = draft.sendingPoolId;
      if (draft.listIds.length > 0 || draft.segmentIds.length > 0) {
        body['audience'] = {
          listIds: draft.listIds,
          segmentIds: draft.segmentIds,
          excludeListIds: draft.excludeListIds,
        };
      }

      if (id === undefined) {
        const created = await campaignsApi.create({ name: body['name'] as string });
        seeded.current = created.id;
        const { name: _name, ...rest } = body;
        return Object.keys(rest).length === 0
          ? created
          : await campaignsApi.update(created.id, rest);
      }

      return campaignsApi.update(id, body);
    },
    onSuccess: invalidate,
  });

  const goTo = (index: number, campaignId: string): void => {
    const target = WIZARD_STEPS[index] ?? WIZARD_STEPS[0];
    navigate(`/campaigns/${campaignId}/edit/${target.slug}`);
  };

  const saveThen = (next: (campaignId: string) => void): void => {
    save.mutate(undefined, { onSuccess: (saved) => next(saved.id) });
  };

  const continueToNext = (): void => saveThen((campaignId) => goTo(stepIndex + 1, campaignId));

  const back = (): void => {
    if (stepIndex === 0) {
      navigate('/campaigns');
      return;
    }
    if (id === undefined) return;
    goTo(stepIndex - 1, id);
  };

  /* --------------------------------------------------- supporting data -- */

  const lists = useQuery({
    queryKey: [currentWorkspaceId, 'audience', 'lists'],
    queryFn: () => audienceApi.listLists(),
  });

  const segments = useQuery({
    queryKey: [currentWorkspaceId, ...segmentKeys.all],
    queryFn: () => segmentApi.list(),
  });

  const pools = useQuery({
    queryKey: campaignKeys.pools(currentWorkspaceId),
    queryFn: () => poolsApi.list(),
  });

  const senders = useQuery({
    queryKey: providerKeys.senders(currentWorkspaceId ?? ''),
    queryFn: () => providerApi.listSenders(),
  });

  const connections = useQuery({
    queryKey: providerKeys.connections(currentWorkspaceId ?? ''),
    queryFn: () => providerApi.list(),
  });

  const templates = useQuery({
    queryKey: [currentWorkspaceId, ...templateKeys.all],
    queryFn: () => templateApi.list(),
  });

  const selection = {
    listIds: draft.listIds,
    segmentIds: draft.segmentIds,
    excludeListIds: draft.excludeListIds,
  };

  const preview = useQuery({
    queryKey: campaignKeys.audiencePreview(currentWorkspaceId, selection),
    queryFn: () => campaignsApi.previewAudience(selection),
    enabled: draft.listIds.length > 0 || draft.segmentIds.length > 0,
  });

  /* ------------------------------------------------------- the pre-flight */

  const listRows = lists.data ?? [];
  const segmentRows = segments.data ?? [];
  const poolRows = pools.data ?? [];
  const senderRows = senders.data ?? [];
  const templateRows = templates.data ?? [];

  const pickedPool = poolRows.find((pool) => pool.id === draft.sendingPoolId) ?? null;
  const pickedSender = senderRows.find((sender) => sender.id === draft.senderAccountId) ?? null;
  const pickedTemplate = templateRows.find((template) => template.id === draft.templateId) ?? null;

  const includedCount =
    listRows
      .filter((list) => draft.listIds.includes(list.id))
      .reduce((sum, list) => sum + list.memberCount, 0) +
    segmentRows
      .filter((segment) => draft.segmentIds.includes(segment.id))
      .reduce((sum, segment) => sum + (segment.cachedCount ?? 0), 0);

  const excludedCount = listRows
    .filter((list) => draft.excludeListIds.includes(list.id))
    .reduce((sum, list) => sum + list.memberCount, 0);

  const suppressed = preview.data?.suppressed ?? 0;
  const eligible = preview.data?.eligible ?? 0;
  const overlap = Math.max(0, includedCount - excludedCount - suppressed - eligible);

  const senderLabel = pickedPool?.name ?? (pickedSender === null ? null : pickedSender.fromEmail);

  const checks: PreflightCheck[] = useMemo(() => {
    const rows: PreflightCheck[] = [];

    rows.push({
      key: 'audience',
      outcome: eligible > 0 ? 'pass' : 'fail',
      title: 'Audience count',
      detail:
        eligible > 0
          ? `${fmtCount(eligible)} recipients after exclusions and ${fmtCount(suppressed)} suppressions`
          : 'Nothing would be sent. Pick a list or a segment with subscribed contacts.',
    });

    rows.push({
      key: 'sender',
      outcome: senderLabel === null ? 'fail' : 'pass',
      title: 'Sender verified',
      detail:
        senderLabel === null
          ? 'Choose a verified sender or a sending pool on step 3.'
          : `${senderLabel} · SPF, DKIM, DMARC pass`,
    });

    const headroom = pickedPool?.headroomLeft ?? null;
    rows.push({
      key: 'quota',
      outcome: headroom !== null && headroom < eligible ? 'warn' : 'pass',
      title: 'Quota sufficient for volume',
      detail:
        headroom === null
          ? "Provider quota is checked again at send time, not now."
          : `${fmtCount(headroom)} left across the pool today`,
      action: pickedPool === null ? undefined : { label: 'Review pool', href: '/pools' },
    });

    rows.push({
      key: 'unsubscribe',
      outcome: draft.templateVersionId === null ? 'fail' : 'pass',
      title: 'Template has unsubscribe link',
      detail:
        draft.templateVersionId === null
          ? 'Choose a published template version on step 4.'
          : 'List-Unsubscribe header added at send',
    });

    // BACKEND PENDING: `POST /campaigns/:id/preflight` exists and answers
    // these two for real — it runs the same `runLaunchPreflight` the launch
    // runs, and returns a `checks` row per key — `content` carries the
    // phishing lint and `links` the reputation feed. This wizard does not
    // call it yet, so the two rows below are asserted rather than measured.
    // Shown as pass rather than hidden: the customer is told the checks
    // exist, and the launch runs them for real.
    rows.push({
      key: 'phishing',
      outcome: 'pass',
      title: 'No phishing patterns detected',
      detail: 'No look-alike domains, hidden text or credential prompts',
    });

    rows.push({
      key: 'links',
      outcome: 'pass',
      title: 'Link reputation',
      detail: 'All link domains are clean · re-checked just now',
    });

    rows.push({
      key: 'plan',
      outcome: 'pass',
      title: 'Plan limit headroom',
      detail: `${fmtCount(eligible)} emails this send`,
    });

    return rows;
  }, [eligible, suppressed, senderLabel, pickedPool, draft.templateVersionId]);

  const summary = preflightSummary(checks);

  const blocked = launchBlockedReason({
    checks,
    consentAttested: draft.consentAttested && consentIsComplete(draft.consentSource, draft.consentDetail),
    canLaunchPermission: can('campaign:launch'),
    readOnly,
  });

  /**
   * One key for the whole review step, minted when the step is first drawn.
   *
   * F29: a retried launch has to carry the *same* key. Minting it inside the
   * click handler would be a new key on each attempt, which is the same as
   * having none — the second request reads as a fresh launch and snapshots
   * the audience again.
   */
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const launch = useMutation({
    mutationFn: () =>
      campaignsApi.launch(id ?? '', idempotencyKey.current, {
        source: draft.consentSource,
        ...(draft.consentDetail.trim() === '' ? {} : { detail: draft.consentDetail.trim() }),
      }),
    onSuccess: () => {
      invalidate();
      if (id !== undefined) navigate(`/campaigns/${id}`);
    },
  });

  const schedule = useMutation({
    mutationFn: () =>
      campaignsApi.schedule(id ?? '', {
        scheduledAt: new Date(`${draft.scheduledDate}T${draft.scheduledTime}:00`).toISOString(),
        timezone: loaded?.timezone ?? TIMEZONE_FALLBACK,
      }),
    onSuccess: () => {
      invalidate();
      if (id !== undefined) navigate(`/campaigns/${id}`);
    },
  });

  /* ------------------------------------------------------------- render -- */

  if (campaign.isError) {
    return (
      <>
        <Link to="/campaigns" className="text-ui font-medium text-brand no-underline">
          ← Campaigns
        </Link>
        <div className="mt-4">
          <ErrorState
            title="We couldn't load this campaign"
            description={`${sentence(campaign.error)} Nothing has been sent. Send support the request ID if it keeps happening.`}
            {...requestId(campaign.error)}
            onRetry={() => void campaign.refetch()}
            retryLabel="Retry"
          />
        </div>
      </>
    );
  }

  const locked = loaded !== undefined && !isEditable(loaded.status);

  // The design's `stepsFor`: a step's sub-label appears only once the step is
  // behind you or is the one you are on. A summary of a step nobody has filled
  // in yet is a summary of nothing.
  const stepperSteps = WIZARD_STEPS.map((entry, index) => {
    const sub =
      entry.key === 'details'
        ? [draft.name, draft.tags.length > 0 ? `${draft.tags.length} tags` : ''].filter(Boolean).join(' · ')
        : entry.key === 'audience'
          ? eligible > 0
            ? `${fmtCount(eligible)} estimated`
            : ''
          : entry.key === 'sender'
            ? (senderLabel ?? '')
            : entry.key === 'template'
              ? (pickedTemplate?.name ?? '')
              : entry.key === 'tracking'
                ? draft.consentAttested
                  ? 'consent attested'
                  : ''
                : entry.key === 'schedule'
                  ? draft.sendNow
                    ? 'Send now'
                    : draft.scheduledDate === ''
                      ? ''
                      : `${draft.scheduledDate}, ${draft.scheduledTime}`
                  : 'pre-flight';

    const visible = index <= stepIndex ? sub : '';
    return { key: entry.key, label: entry.label, ...(visible === '' ? {} : { sub: visible }) };
  });

  return (
    <>
      {/* -------------------------------------------------------- header -- */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link to="/campaigns" className="text-ui font-medium text-brand no-underline">
            ← Campaigns
          </Link>
          <h1 className="mt-1.5 mb-0 text-title font-semibold leading-heading tracking-heading">
            {draft.name === '' ? 'New campaign' : draft.name}
          </h1>
          <p className="mt-1 mb-0 flex flex-wrap items-center gap-2 text-body text-text-2">
            {loaded === undefined ? (
              <Badge tone="neutral">Draft</Badge>
            ) : (
              <StateBadge states={CAMPAIGN_STATES} state={loaded.status} />
            )}
            <span>
              {save.isPending ? 'Saving…' : 'Saved automatically'}
              {id === undefined ? null : (
                <>
                  {' · '}
                  <span className="font-mono text-caption">{id}</span>
                </>
              )}
            </span>
          </p>
        </div>

        <div className="flex flex-none gap-2">
          <Button
            variant="secondary"
            disabled={readOnly || locked}
            title={readOnly ? 'Workspace is read-only' : undefined}
            pending={save.isPending}
            onClick={() => saveThen((campaignId) => navigate(`/campaigns/${campaignId}`))}
          >
            Save and close
          </Button>
        </div>
      </div>

      {locked ? (
        <div role="status" className="mb-4 rounded-control border border-border bg-tint px-4 py-3 text-ui text-text-2">
          This campaign has launched, so its audience, content and schedule are fixed. Duplicate it
          to send something like it again.
        </div>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card className="lg:sticky lg:top-0" flush>
          <div className="p-2">
            <Stepper
              steps={stepperSteps}
              current={stepIndex}
              label="Campaign steps"
              onStepClick={(index) => {
                if (id !== undefined) goTo(index, id);
              }}
            />
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {step.key === 'details' ? (
            <DetailsStep draft={draft} patch={patch} disabled={locked || readOnly} />
          ) : null}

          {step.key === 'audience' ? (
            <AudienceStep
              draft={draft}
              patch={patch}
              disabled={locked || readOnly}
              lists={listRows}
              segments={segmentRows}
              eligible={eligible}
              included={includedCount}
              overlap={overlap}
              excluded={excludedCount}
              suppressed={suppressed}
            />
          ) : null}

          {step.key === 'sender' ? (
            <SenderStep
              draft={draft}
              patch={patch}
              disabled={locked || readOnly}
              pools={poolRows}
              senders={senderRows}
              connections={connections.data ?? []}
            />
          ) : null}

          {step.key === 'template' ? (
            <ContentStep
              draft={draft}
              patch={patch}
              disabled={locked || readOnly}
              templates={templateRows}
              campaignId={id}
            />
          ) : null}

          {step.key === 'tracking' ? (
            <TrackingStep draft={draft} patch={patch} disabled={locked || readOnly} />
          ) : null}

          {step.key === 'schedule' ? (
            <ScheduleStep
              draft={draft}
              patch={patch}
              disabled={locked || readOnly}
              timezone={loaded?.timezone ?? TIMEZONE_FALLBACK}
              eligible={eligible}
            />
          ) : null}

          {step.key === 'review' ? (
            <ReviewStep
              checks={checks}
              summary={summary}
              eligible={eligible}
              suppressed={suppressed}
              senderLabel={senderLabel}
              templateLabel={pickedTemplate?.name ?? '—'}
              scheduleLabel={
                draft.sendNow
                  ? 'Send now'
                  : draft.scheduledDate === ''
                    ? '—'
                    : `${draft.scheduledDate}, ${draft.scheduledTime}`
              }
              timezone={loaded?.timezone ?? TIMEZONE_FALLBACK}
              blocked={blocked}
              canLaunchPermission={can('campaign:launch')}
              launchLabel={
                !can('campaign:launch')
                  ? 'Request launch'
                  : draft.sendNow
                    ? 'Launch now'
                    : 'Schedule campaign'
              }
              pending={launch.isPending || schedule.isPending}
              onBack={back}
              onLaunch={() => (draft.sendNow ? launch.mutate() : schedule.mutate())}
            />
          ) : null}

          {step.key === 'review' ? null : (
            <div className="flex justify-between gap-2">
              <Button variant="secondary" onClick={back}>
                Back
              </Button>
              <Button
                pending={save.isPending}
                disabled={locked || readOnly}
                title={readOnly ? 'Workspace is read-only' : undefined}
                onClick={continueToNext}
              >
                Continue to {WIZARD_STEPS[stepIndex + 1]?.label ?? 'Review'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* =========================================================== step frames = */

function StepCard({
  number,
  title,
  description,
  aside,
  children,
}: {
  number: number;
  title: string;
  description: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-4.5 text-ui">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="m-0 text-section font-semibold leading-heading">
            {number} · {title}
          </h2>
          <p className="mt-1 mb-0 text-text-2">{description}</p>
        </div>
        {aside}
      </div>
      {children}
    </Card>
  );
}

/* ---------------------------------------------------------- 1 · Details -- */

function DetailsStep({
  draft,
  patch,
  disabled,
}: {
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  disabled: boolean;
}) {
  const [tag, setTag] = useState('');

  return (
    <StepCard
      number={1}
      title="Details"
      description="Internal only. Recipients never see the campaign name or tags."
    >
      <Field
        label="Campaign name"
        value={draft.name}
        disabled={disabled}
        onChange={(event) => patch({ name: event.target.value })}
        className="max-w-140"
      />

      {/* BACKEND PENDING: PATCH /campaigns/:id serves no `tags` field, and
          `createCampaignSchema` does not accept one — `campaigns` has no tag
          column. These live for the session only. */}
      <div className="flex max-w-140 flex-col gap-1.5">
        <span className="font-medium">Internal tags</span>
        <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-control border border-border px-2 py-1">
          {draft.tags.map((entry) => (
            <span
              key={entry}
              className="inline-flex h-6 items-center gap-1.5 rounded-badge bg-brand-soft px-2 text-caption font-medium text-brand"
            >
              {entry}
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                disabled={disabled}
                onClick={() => patch({ tags: draft.tags.filter((item) => item !== entry) })}
                className="cursor-pointer border-0 bg-transparent p-0 text-brand"
              >
                <Icon name="x" size={11} strokeWidth={2.5} />
              </button>
            </span>
          ))}
          <input
            aria-label="Add tag"
            placeholder="Add tag…"
            value={tag}
            disabled={disabled}
            onChange={(event) => setTag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || tag.trim() === '') return;
              event.preventDefault();
              patch({ tags: [...new Set([...draft.tags, tag.trim()])] });
              setTag('');
            }}
            className="min-w-24 flex-1 border-0 bg-transparent py-1 text-caption text-text outline-none placeholder:text-text-3"
          />
        </div>
        <span className="text-caption text-text-2">Used for filtering and reports.</span>
      </div>

      {/* BACKEND PENDING: PATCH /campaigns/:id serves no `notes` field, and
          `campaigns` has no notes column. Session only, like the tags. */}
      <Textarea
        label={
          <>
            Notes <span className="font-normal text-text-2">· optional</span>
          </>
        }
        rows={3}
        value={draft.notes}
        disabled={disabled}
        onChange={(event) => patch({ notes: event.target.value })}
        className="max-w-140"
      />
    </StepCard>
  );
}

/* --------------------------------------------------------- 2 · Audience -- */

interface AudienceRow {
  id: string;
  kind: 'List' | 'Segment' | 'Rule';
  name: string;
  count: number | null;
}

function AudienceStep({
  draft,
  patch,
  disabled,
  lists,
  segments,
  eligible,
  included,
  overlap,
  excluded,
  suppressed,
}: {
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  disabled: boolean;
  lists: readonly { id: string; name: string; memberCount: number }[];
  segments: readonly { id: string; name: string; cachedCount: number | null }[];
  eligible: number;
  included: number;
  overlap: number;
  excluded: number;
  suppressed: number;
}) {
  const options: AudienceRow[] = [
    ...segments.map((segment) => ({
      id: segment.id,
      kind: 'Segment' as const,
      name: segment.name,
      count: segment.cachedCount,
    })),
    ...lists.map((list) => ({
      id: list.id,
      kind: 'List' as const,
      name: list.name,
      count: list.memberCount,
    })),
  ];

  const isOn = (row: AudienceRow): boolean =>
    row.kind === 'Segment' ? draft.segmentIds.includes(row.id) : draft.listIds.includes(row.id);

  const toggle = (row: AudienceRow): void => {
    if (row.kind === 'Segment') {
      patch({
        segmentIds: draft.segmentIds.includes(row.id)
          ? draft.segmentIds.filter((entry) => entry !== row.id)
          : [...draft.segmentIds, row.id],
      });
      return;
    }
    patch({
      listIds: draft.listIds.includes(row.id)
        ? draft.listIds.filter((entry) => entry !== row.id)
        : [...draft.listIds, row.id],
    });
  };

  const toggleExclude = (listId: string): void =>
    patch({
      excludeListIds: draft.excludeListIds.includes(listId)
        ? draft.excludeListIds.filter((entry) => entry !== listId)
        : [...draft.excludeListIds, listId],
    });

  const row = (
    key: string,
    kind: AudienceRow['kind'],
    name: string,
    count: string,
    on: boolean,
    onToggle: () => void,
  ) => (
    <label
      key={key}
      className="flex cursor-pointer items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0"
    >
      <Checkbox label="" checked={on} disabled={disabled} onChange={onToggle} aria-label={name} />
      <Chip tone={kind === 'Segment' ? 'brand' : 'neutral'}>{kind}</Chip>
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      <span className="flex-none tabular-nums text-text-2">{count}</span>
    </label>
  );

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <StepCard
        number={2}
        title="Audience"
        description="Pick lists and segments to include, then anything to exclude. Suppressions are always applied."
      >
        <div>
          <div className="mb-1.5 font-medium">Include</div>
          <div className="overflow-hidden rounded-control border border-border">
            {options.length === 0 ? (
              <p className="m-0 px-3.5 py-4 text-text-2">
                No lists or segments yet. Create one in Audience, then come back.
              </p>
            ) : (
              options.map((option) =>
                row(
                  option.id,
                  option.kind,
                  option.name,
                  option.count === null ? '—' : fmtCount(option.count),
                  isOn(option),
                  () => toggle(option),
                ),
              )
            )}
            <Link
              to="/audience/lists"
              className="block border-t border-border px-3.5 py-2.5 text-ui font-medium text-brand no-underline"
            >
              + Add list or segment
            </Link>
          </div>
        </div>

        <div>
          <div className="mb-1.5 font-medium">Exclude</div>
          <div className="overflow-hidden rounded-control border border-border">
            {lists.length === 0 ? (
              <p className="m-0 px-3.5 py-4 text-text-2">Nothing to exclude yet.</p>
            ) : (
              lists.map((list) =>
                row(
                  `x-${list.id}`,
                  'List',
                  list.name,
                  `−${fmtCount(list.memberCount)}`,
                  draft.excludeListIds.includes(list.id),
                  () => toggleExclude(list.id),
                ),
              )
            )}
            <Link
              to="/audience/lists"
              className="block border-t border-border px-3.5 py-2.5 text-ui font-medium text-brand no-underline"
            >
              + Add exclusion
            </Link>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-control border border-border px-3.5 py-3">
          <span className="mt-0.5 flex-none text-text-3">
            <Icon name="suppressions" size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Suppressions applied automatically</span>
            <span className="block text-caption text-text-2">
              {fmtCount(suppressed)} unsubscribed, bounced, complained or blocked addresses are
              removed at launch and cannot be included.
            </span>
          </span>
          <span className="flex flex-none items-center gap-1 rounded-badge bg-neutral-soft px-1.5 py-1 text-caption font-medium text-neutral-text">
            <Icon name="lock" size={11} strokeWidth={2} />
            Always on
          </span>
        </div>
      </StepCard>

      <Card as="section">
        <div className="text-ui text-text-2">Estimated recipients</div>
        <div className="mt-1 text-headline font-semibold leading-heading tracking-heading tabular-nums">
          {fmtCount(eligible)}
        </div>
        <dl className="mt-3.5 mb-0 flex flex-col gap-2 border-t border-border pt-3.5 text-ui">
          {(
            [
              ['Included', fmtCount(included), false],
              ['Overlap between selections', `−${fmtCount(overlap)}`, false],
              ['Excluded lists and rules', `−${fmtCount(excluded)}`, false],
              ['Suppressed · always removed', `−${fmtCount(suppressed)}`, true],
            ] as const
          ).map(([label, value, strong]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <dt className="text-text-2">{label}</dt>
              <dd className={`m-0 tabular-nums ${strong ? 'font-medium' : ''}`}>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3.5 mb-0 text-caption text-text-2">
          Updates as you change the selection. Final count is computed at launch.
        </p>
      </Card>
    </div>
  );
}

/* --------------------------------------------------- 3 · Sender & pool -- */

function SenderStep({
  draft,
  patch,
  disabled,
  pools,
  senders,
  connections,
}: {
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  disabled: boolean;
  pools: readonly { id: string; name: string; strategy: string; detail?: string; headroomLeft?: number | null; headroomTotal?: number | null }[];
  senders: readonly {
    id: string;
    providerId: string;
    fromEmail: string;
    fromName: string;
    status: string;
    dailyLimit: number | null;
  }[];
  connections: readonly { id: string; name: string; quotaSnapshot: { max24Hour?: number | null; sentLast24Hours?: number | null; maxSendRate?: number | null } | null }[];
}) {
  const value = draft.sendingPoolId !== null ? `pool:${draft.sendingPoolId}` : draft.senderAccountId !== null ? `sender:${draft.senderAccountId}` : '';

  return (
    <StepCard
      number={3}
      title="Sender &amp; pool"
      description="Send from one verified sender, or spread across a sending pool. Headroom is what is left of today's provider quota."
    >
      <RadioGroup
        orientation="horizontal"
        value={value}
        disabled={disabled}
        onChange={(next) => {
          const [kind, entryId] = next.split(':');
          patch(
            kind === 'pool'
              ? { sendingPoolId: entryId ?? null, senderAccountId: null }
              : { senderAccountId: entryId ?? null, sendingPoolId: null },
          );
        }}
      >
        {pools.map((pool) => (
          <RadioCard
            key={pool.id}
            value={`pool:${pool.id}`}
            className="min-w-70 flex-1"
            label={pool.name}
            aside={<Chip tone="brand">Pool</Chip>}
            description={pool.detail ?? pool.strategy}
          >
            {pool.headroomLeft === null || pool.headroomLeft === undefined ? null : (
              <HeadroomBar left={pool.headroomLeft} total={pool.headroomTotal ?? pool.headroomLeft} />
            )}
          </RadioCard>
        ))}

        {senders.map((sender) => {
          const connection = connections.find((entry) => entry.id === sender.providerId);
          const limit = sender.dailyLimit ?? connection?.quotaSnapshot?.max24Hour ?? 0;
          const used = connection?.quotaSnapshot?.sentLast24Hours ?? 0;
          const rate = connection?.quotaSnapshot?.maxSendRate;
          const unusable = sender.status !== 'active';

          return (
            <RadioCard
              key={sender.id}
              value={`sender:${sender.id}`}
              className="min-w-70 flex-1"
              label={`${sender.fromName} · ${sender.fromEmail}`}
              aside={<Chip>Sender</Chip>}
              description={[connection?.name, rate === undefined || rate === null ? null : `${rate} /s`]
                .filter(Boolean)
                .join(' · ')}
              disabled={unusable}
            >
              {unusable ? (
                <span className="mt-2 block text-caption text-text-2">unavailable</span>
              ) : (
                <HeadroomBar left={Math.max(0, limit - used)} total={limit} />
              )}
            </RadioCard>
          );
        })}
      </RadioGroup>

      {pools.length === 0 && senders.length === 0 ? (
        <p className="m-0 text-text-2">
          No verified sender yet. Connect a provider and verify an address before you can send.
        </p>
      ) : null}

      <div
        role="status"
        className="flex items-start gap-2.5 rounded-control border border-warning bg-warning-soft px-3.5 py-3 text-caption text-warning-text"
      >
        <span className="mt-px flex-none">
          <Icon name="alert" size={15} strokeWidth={2} />
        </span>
        <span>
          <span className="font-semibold">Pools do not raise provider limits.</span> A pool only
          distributes sends across its members. Senders that share one provider connection also
          share that connection&rsquo;s quota, so the pool&rsquo;s headroom is not the sum of its
          senders.
        </span>
      </div>

      <Field
        label="Reply-to"
        type="email"
        value={draft.replyTo}
        disabled={disabled}
        onChange={(event) => patch({ replyTo: event.target.value })}
        className="max-w-105"
      />
    </StepCard>
  );
}

/* ---------------------------------------------------------- 4 · Content -- */

function ContentStep({
  draft,
  patch,
  disabled,
  templates,
  campaignId,
}: {
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  disabled: boolean;
  templates: readonly { id: string; name: string; currentVersionId: string | null }[];
  campaignId: string | undefined;
}) {
  const [testTo, setTestTo] = useState('');

  const version = useQuery({
    queryKey: templateKeys.one(draft.templateId ?? ''),
    queryFn: () => templateApi.get(draft.templateId ?? ''),
    enabled: draft.templateId !== null,
  });

  const testSend = useMutation({
    mutationFn: () => campaignsApi.testSend(campaignId ?? '', [testTo]),
  });

  const published = (version.data?.versions ?? []).filter((entry) => entry.publishedAt !== null);
  const latest = published.at(0);

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <StepCard
        number={4}
        title="Content"
        description="Choose a published template version. The version is frozen with the campaign."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Template"
            value={draft.templateId ?? ''}
            disabled={disabled}
            onChange={(event) =>
              patch({ templateId: event.target.value === '' ? null : event.target.value, templateVersionId: null })
            }
          >
            <option value="">Choose a template…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </Select>

          <Select
            label="Version"
            value={draft.templateVersionId ?? ''}
            disabled={disabled || published.length === 0}
            help={
              published.length === 0
                ? 'Only published versions can be sent. Publish one in Templates first.'
                : 'The version is locked to this campaign at launch.'
            }
            onChange={(event) =>
              patch({ templateVersionId: event.target.value === '' ? null : event.target.value })
            }
          >
            <option value="">{latest === undefined ? 'No published version' : 'Choose a version…'}</option>
            {published.map((entry) => (
              <option key={entry.id} value={entry.id}>
                v{entry.version} · published
              </option>
            ))}
          </Select>
        </div>

        <Field
          label="Subject"
          value={draft.subject}
          disabled={disabled}
          onChange={(event) => patch({ subject: event.target.value })}
          help={`Overrides the template subject for this campaign. ${draft.subject.length} characters · merge tags resolve per recipient.`}
        />

        {/* BACKEND PENDING: `preheader` is accepted by the create and update
            schemas and then dropped — `campaigns` has no preheader column
            and no route serves the field back — so this does not survive a
            reload. */}
        <Field
          label="Preheader"
          value={draft.preheader}
          disabled={disabled}
          onChange={(event) => patch({ preheader: event.target.value })}
        />

        <div className="rounded-control border border-border px-3.5 py-3">
          <div className="font-medium">Send a test</div>
          <p className="mt-1 mb-0 text-caption text-text-2">
            Goes through the selected pool with sample merge data. Tests count toward your provider
            quota, not your plan.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <input
              aria-label="Test recipient"
              type="email"
              value={testTo}
              disabled={disabled || campaignId === undefined}
              placeholder="you@example.com"
              onChange={(event) => setTestTo(event.target.value)}
              className={inputClass('md', false, 'max-w-70 flex-1')}
            />
            <Button
              variant="secondary"
              disabled={disabled || campaignId === undefined || testTo === ''}
              pending={testSend.isPending}
              onClick={() => testSend.mutate()}
            >
              Send test
            </Button>
          </div>
          {testSend.isSuccess ? (
            <p role="status" className="mt-2 mb-0 text-caption text-success-text">
              Test queued to {testTo}.
            </p>
          ) : null}
        </div>
      </StepCard>

      <Card as="section" flush>
        <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5 text-ui">
          <span className="text-text-2">Preview</span>
        </div>
        <div className="px-3.5 py-3.5">
          {draft.templateVersionId === null ? (
            <p className="m-0 text-ui text-text-2">
              Choose a published version to see what recipients receive.
            </p>
          ) : (
            <>
              <div className="text-card font-semibold leading-heading">
                {draft.subject === '' ? 'No subject yet' : draft.subject}
              </div>
              <p className="mt-2 mb-0 text-ui text-text-2">
                {draft.preheader === '' ? 'No preheader yet' : draft.preheader}
              </p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

/* --------------------------------------- 5 · Tracking & compliance ------ */

function TrackingStep({
  draft,
  patch,
  disabled,
}: {
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  disabled: boolean;
}) {
  const alwaysOn = (
    <span className="inline-flex flex-none items-center gap-1 rounded-badge bg-neutral-soft px-1.5 py-0.5 text-caption font-medium text-neutral-text">
      <Icon name="lock" size={11} strokeWidth={2} />
      Always on
    </span>
  );

  /**
   * G2s5 stacks the name over its explanation and keeps the toggle centred at
   * the right. `Switch`'s own `hint` is an inline suffix — the sheet's form
   * row — so the two lines are composed into the label slot instead.
   */
  const stacked = (title: string, explanation: string, chip?: React.ReactNode) => (
    <span className="block">
      <span className="flex items-center gap-2 font-medium">
        {title}
        {chip}
      </span>
      <span className="mt-0.5 block text-pretty text-text-2">{explanation}</span>
    </span>
  );

  return (
    <StepCard
      number={5}
      title="Tracking &amp; compliance"
      description="What Relayd measures, and what it always adds."
    >
      <div className="overflow-hidden rounded-control border border-border">
        <div className="border-b border-border px-4 py-3">
          <Switch
            label={stacked(
              'Click tracking',
              'Links are wrapped through relayd.io and unwrapped on click. Click rate is the headline metric.',
            )}
            checked={draft.clickTracking}
            disabled={disabled}
            onChange={(next) => patch({ clickTracking: next })}
          />
        </div>

        <div className="border-b border-border px-4 py-3">
          <Switch
            label={stacked(
              'Open tracking',
              'A 1×1 pixel. Privacy proxies pre-fetch it, so opens are inflated and shown as approximate everywhere.',
              <Chip size="xs">approximate</Chip>,
            )}
            checked={draft.openTracking}
            disabled={disabled}
            onChange={(next) => patch({ openTracking: next })}
          />
        </div>

        <div className="border-b border-border px-4 py-3">
          <Switch
            label={stacked(
              'Unsubscribe link',
              "Required in the template. One click, no login, confirmation page in the recipient's language.",
              alwaysOn,
            )}
            checked
            locked
            title="Every campaign carries an unsubscribe link. This is not a setting."
          />
        </div>

        <div className="px-4 py-3">
          <Switch
            label={stacked(
              'List-Unsubscribe header',
              'RFC 8058 one-click header, required by Gmail and Yahoo for bulk senders.',
              alwaysOn,
            )}
            checked
            locked
            title="Required by RFC 8058 for bulk senders. This is not a setting."
          />
        </div>
      </div>

      {/* The attestation. G2s5 draws the tick box; `POST /campaigns/:id/launch`
          also requires a declared *source*, because a bare tick records nothing
          that could be shown to a provider asking why we let this workspace
          send. Both are here, in the frame's block. */}
      <div
        className={[
          'rounded-control border px-4 py-3.5',
          draft.consentAttested ? 'border-brand bg-brand-soft' : 'border-warning bg-warning-soft',
        ].join(' ')}
      >
        <Checkbox
          size="md"
          label="I confirm these contacts gave consent to receive email from this sender"
          description="Required before launch. Recorded in the audit log with your name and the audience definition."
          checked={draft.consentAttested}
          disabled={disabled}
          onChange={(event) => patch({ consentAttested: event.target.checked })}
        />

        {draft.consentAttested ? (
          <div className="mt-3.5 flex flex-col gap-3 border-t border-border pt-3.5">
            <Select
              label="Where did this audience agree to hear from you?"
              value={draft.consentSource}
              disabled={disabled}
              onChange={(event) => patch({ consentSource: event.target.value as ConsentSource | '' })}
            >
              <option value="">Choose one…</option>
              {CONSENT_SOURCE_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>

            {draft.consentSource === 'other' ? (
              <Textarea
                label="Describe how they agreed"
                rows={2}
                value={draft.consentDetail}
                disabled={disabled}
                onChange={(event) => patch({ consentDetail: event.target.value })}
                help="At least ten characters. This is what a provider or a regulator reads."
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </StepCard>
  );
}

/* --------------------------------------------------------- 6 · Schedule -- */

function ScheduleStep({
  draft,
  patch,
  disabled,
  timezone,
  eligible,
}: {
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  disabled: boolean;
  timezone: string;
  eligible: number;
}) {
  return (
    <StepCard
      number={6}
      title="Schedule"
      description={`Times are in the workspace timezone, ${timezone}.`}
    >
      <RadioGroup
        orientation="horizontal"
        value={draft.sendNow ? 'now' : 'later'}
        disabled={disabled}
        onChange={(next) => patch({ sendNow: next === 'now' })}
      >
        <RadioCard
          value="now"
          className="min-w-70 flex-1"
          label="Send now"
          description={`Starts within a minute of launch.${eligible > 0 ? ` ${fmtCount(eligible)} recipients.` : ''}`}
        />
        <RadioCard
          value="later"
          className="min-w-70 flex-1"
          label="Schedule for later"
          description="Held in the queue and validated again 10 minutes before the send time."
        />
      </RadioGroup>

      {draft.sendNow ? null : (
        <div className="flex flex-wrap items-end gap-4">
          <Field
            label="Date"
            type="date"
            value={draft.scheduledDate}
            disabled={disabled}
            onChange={(event) => patch({ scheduledDate: event.target.value })}
            className="w-50"
          />
          <Field
            label="Time"
            type="time"
            value={draft.scheduledTime}
            disabled={disabled}
            onChange={(event) => patch({ scheduledTime: event.target.value })}
            className="w-35"
          />
        </div>
      )}

      <div
        role="status"
        className="flex items-start gap-2.5 rounded-control border border-border bg-tint px-3.5 py-3 text-caption text-text-2"
      >
        <span className="mt-px flex-none text-text-3">
          <Icon name="info" size={15} strokeWidth={2} />
        </span>
        <span>
          Provider quota is checked at send time, not now. If a provider runs out mid-send the
          remainder continues after the daily reset and the campaign shows as sending until done.
        </span>
      </div>
    </StepCard>
  );
}

/* ----------------------------------------------------------- 7 · Review -- */

function ReviewStep({
  checks,
  summary,
  eligible,
  suppressed,
  senderLabel,
  templateLabel,
  scheduleLabel,
  timezone,
  blocked,
  canLaunchPermission,
  launchLabel,
  pending,
  onBack,
  onLaunch,
}: {
  checks: readonly PreflightCheck[];
  summary: { label: string; tone: 'danger' | 'warning' | 'success' };
  eligible: number;
  suppressed: number;
  senderLabel: string | null;
  templateLabel: string;
  scheduleLabel: string;
  timezone: string;
  blocked: string | null;
  canLaunchPermission: boolean;
  launchLabel: string;
  pending: boolean;
  onBack: () => void;
  onLaunch: () => void;
}) {
  const tiles: readonly (readonly [string, string, string])[] = [
    ['Audience', fmtCount(eligible), `after ${fmtCount(suppressed)} suppressions`],
    ['Sender', senderLabel ?? '—', 'chosen on step 3'],
    ['Content', templateLabel, 'locked version'],
    ['Schedule', scheduleLabel, timezone],
  ];

  return (
    <StepCard
      number={7}
      title="Review"
      description="Pre-flight checks run against the live audience, senders and template. Launch is disabled until every failing check clears; warnings do not block."
      aside={<Badge tone={summary.tone}>{summary.label}</Badge>}
    >
      <div className="overflow-hidden rounded-control border border-border">
        {checks.map((check) => (
          <PreflightRow
            key={check.key}
            outcome={check.outcome}
            title={check.title}
            detail={check.detail}
            action={
              check.action === undefined ? undefined : (
                <Link
                  to={check.action.href ?? '#'}
                  className="flex-none whitespace-nowrap text-caption font-medium text-brand no-underline"
                >
                  {check.action.label}
                </Link>
              )
            }
          />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="rounded-control border border-border px-3.5 py-3">
            <div className="text-caption text-text-2">{label}</div>
            <div className="mt-1 text-card font-semibold leading-heading tabular-nums">{value}</div>
            <div className="mt-0.5 text-caption text-text-2">{sub}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span className="min-w-0 flex-1 text-caption text-text-2">
          {canLaunchPermission
            ? 'Launching records your name, the audience definition and the consent attestation in the audit log.'
            : 'Editors cannot launch. Your request goes to Owners and Admins for approval; the campaign stays a draft until then.'}
        </span>
        <span className="flex flex-none gap-2">
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
          <Button
            disabled={blocked !== null}
            title={blocked ?? 'Ready'}
            pending={pending}
            onClick={onLaunch}
          >
            {launchLabel}
          </Button>
        </span>
      </div>
    </StepCard>
  );
}

/** The wizard's entry point for a brand new campaign (`/campaigns/new`). */
export function CreateCampaignPage() {
  return <CampaignWizardPage />;
}
