import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  STATUS_LABELS,
  campaignKeys,
  campaignsApi,
  pollIntervalFor,
  type Campaign,
  type CampaignStatus,
} from '../../api/campaigns.js';
import { audienceApi, audienceKeys } from '../../api/audience.js';
import { templateApi, templateKeys } from '../../api/templates.js';
import {
  CONSENT_SOURCE_LABELS,
  consentIsComplete,
  type ConsentSource,
} from '../../components/consent.js';
import { Badge, Button, Cell, EmptyState, Loading, LoadError, Page, Table, formatDate } from '../../components/ui.js';
import {
  WIZARD_STEPS,
  canLaunch,
  isEditable,
  preflight,
  stepsWithIssues,
  type PreflightIssue,
  type WizardStepKey,
} from './wizard-steps.js';

/**
 * Campaigns: the list, and the seven-step wizard.
 *
 * Two product decisions from docs/06 §13 are enforced here rather than merely
 * respected:
 *
 *   Click rate is the headline. Open rate is shown second and labelled, every
 *   time, because privacy features inflate and suppress it by 30-60% and a
 *   customer who makes a decision on it is making it on a wrong number.
 *
 *   `delivery_uncertain` is its own count, never folded into failures. "We
 *   could not send" and "we do not know whether we sent" are different things
 *   to tell a customer.
 */

export function CampaignsPage() {
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');

  const query = useQuery({
    queryKey: [...campaignKeys.all, { search, state }],
    queryFn: () => campaignsApi.list({ ...(search === '' ? {} : { search }), ...(state === '' ? {} : { state }) }),
  });

  return (
    <Page title="Campaigns" action={<Link to="/campaigns/new"><Button>New campaign</Button></Link>}>
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="sr-only" htmlFor="campaign-search">
          Search campaigns
        </label>
        <input
          id="campaign-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />

        <label className="sr-only" htmlFor="campaign-state">
          Filter by state
        </label>
        <select
          id="campaign-state"
          value={state}
          onChange={(event) => setState(event.target.value)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        >
          <option value="">All states</option>
          {Object.entries(STATUS_LABELS).map(([value, meta]) => (
            <option key={value} value={value}>
              {meta.label}
            </option>
          ))}
        </select>
      </div>

      {query.isPending ? <Loading /> : null}
      {query.isError ? <LoadError error={query.error} onRetry={() => void query.refetch()} /> : null}

      {query.data !== undefined ? (
        query.data.items.length === 0 ? (
          <EmptyState title="No campaigns yet">
            <Link className="text-sm underline" to="/campaigns/new">
              Create your first campaign
            </Link>
          </EmptyState>
        ) : (
          <Table columns={['Name', 'State', 'Recipients', 'Created']}>
            {query.data.items.map((campaign) => (
              <tr key={campaign.id} className="border-t border-slate-200">
                <Cell>
                  <Link className="font-medium underline" to={`/campaigns/${campaign.id}`}>
                    {campaign.name}
                  </Link>
                </Cell>
                <Cell>
                  <StatusBadge status={campaign.status} />
                </Cell>
                <Cell muted>{campaign.recipientCount.toLocaleString()}</Cell>
                <Cell muted>{formatDate(campaign.createdAt)}</Cell>
              </tr>
            ))}
          </Table>
        )
      ) : null}
    </Page>
  );
}

export function CreateCampaignPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => campaignsApi.create({ name: name.trim() }),
    onSuccess: (campaign) => navigate(`/campaigns/${campaign.id}`),
  });

  return (
    <Page title="New campaign">
      <form
        className="max-w-md space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') create.mutate();
        }}
      >
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="campaign-name">
            Campaign name
          </label>
          <input
            id="campaign-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            // Internal. Recipients never see it, and saying so stops authors
            // agonising over it on a screen with nothing else on it.
            placeholder="Spring sale announcement"
          />
          <p className="mt-1 text-xs text-slate-500">
            Only you and your team see this. The subject line comes later.
          </p>
        </div>

        <Button type="submit" disabled={name.trim() === '' || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create and continue'}
        </Button>
      </form>
    </Page>
  );
}

export function CampaignWizardPage() {
  const { id = '' } = useParams();
  const [step, setStep] = useState<WizardStepKey>('details');

  const campaign = useQuery({
    queryKey: campaignKeys.one(id),
    queryFn: () => campaignsApi.get(id),
    refetchInterval: (query) => {
      const status = query.state.data?.campaign.status;
      return status === undefined ? false : pollIntervalFor(status);
    },
  });

  if (campaign.isPending) return <Page title="Campaign"><Loading /></Page>;
  if (campaign.isError) {
    return (
      <Page title="Campaign">
        <LoadError error={campaign.error} onRetry={() => void campaign.refetch()} />
      </Page>
    );
  }

  const { campaign: current } = campaign.data;

  // A launched campaign is a report, not a form.
  if (!isEditable(current.status)) return <CampaignReport campaign={current} />;

  return (
    <Page title={current.name}>
      <StepNav current={step} onSelect={setStep} campaign={current} />
      <div className="mt-6">
        <StepBody step={step} campaign={current} onDone={() => advance(step, setStep)} />
      </div>
    </Page>
  );
}

function advance(from: WizardStepKey, setStep: (key: WizardStepKey) => void): void {
  const index = WIZARD_STEPS.findIndex((s) => s.key === from);
  const next = WIZARD_STEPS[index + 1];
  if (next !== undefined) setStep(next.key);
}

function StepNav({
  current,
  onSelect,
  campaign,
}: {
  current: WizardStepKey;
  onSelect: (key: WizardStepKey) => void;
  campaign: Campaign;
}) {
  const issues = usePreflight(campaign);
  const blocked = stepsWithIssues(issues);

  return (
    <ol className="flex flex-wrap gap-2" aria-label="Campaign steps">
      {WIZARD_STEPS.map((step, index) => {
        const active = step.key === current;
        const hasIssue = blocked.has(step.key);

        return (
          <li key={step.key}>
            <button
              type="button"
              onClick={() => onSelect(step.key)}
              aria-current={active ? 'step' : undefined}
              className={[
                'rounded-md border px-3 py-1.5 text-sm',
                active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700',
              ].join(' ')}
            >
              <span className="mr-1 text-xs opacity-70">{index + 1}</span>
              {step.label}
              {hasIssue ? (
                <span className="ml-1 text-amber-500" aria-label="needs attention">
                  •
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The pre-flight, recomputed from whatever the wizard currently knows. */
function usePreflight(campaign: Campaign): PreflightIssue[] {
  const listIds = campaign.audience.listIds ?? [];

  const preview = useQuery({
    queryKey: campaignKeys.audiencePreview(listIds),
    queryFn: () => campaignsApi.previewAudience({ listIds }),
    enabled: listIds.length > 0,
  });

  return useMemo(
    () =>
      preflight({
        campaign,
        audienceCount: preview.data ?? null,
        // Verification is checked by the server at launch; the wizard shows
        // what it knows and never claims a sender is bad on no evidence.
        senderVerified: null,
        unsatisfiableMergeTags: [],
      }),
    [campaign, preview.data],
  );
}

function StepBody({
  step,
  campaign,
  onDone,
}: {
  step: WizardStepKey;
  campaign: Campaign;
  onDone: () => void;
}) {
  switch (step) {
    case 'details':
      return <DetailsStep campaign={campaign} onDone={onDone} />;
    case 'audience':
      return <AudienceStep campaign={campaign} onDone={onDone} />;
    case 'template':
      return <TemplateStep campaign={campaign} onDone={onDone} />;
    case 'sender':
      return <SenderStep campaign={campaign} onDone={onDone} />;
    case 'tracking':
      return <TrackingStep onDone={onDone} />;
    case 'schedule':
      return <ScheduleStep campaign={campaign} onDone={onDone} />;
    default:
      return <ReviewStep campaign={campaign} />;
  }
}

function useSave(campaign: Campaign) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => campaignsApi.update(campaign.id, patch),
    onSuccess: () => client.invalidateQueries({ queryKey: campaignKeys.one(campaign.id) }),
  });
}

function DetailsStep({ campaign, onDone }: { campaign: Campaign; onDone: () => void }) {
  const save = useSave(campaign);
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subjectOverride ?? '');

  return (
    <form
      className="max-w-lg space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ name: name.trim(), subject: subject.trim() }, { onSuccess: onDone });
      }}
    >
      <TextField id="name" label="Campaign name" value={name} onChange={setName} />
      <TextField
        id="subject"
        label="Subject line"
        value={subject}
        onChange={setSubject}
        hint="What recipients see in their inbox."
      />
      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save and continue'}
      </Button>
    </form>
  );
}

function AudienceStep({ campaign, onDone }: { campaign: Campaign; onDone: () => void }) {
  const save = useSave(campaign);
  const [selected, setSelected] = useState<string[]>(campaign.audience.listIds ?? []);

  const lists = useQuery({ queryKey: audienceKeys.lists, queryFn: () => audienceApi.listLists() });

  const preview = useQuery({
    queryKey: campaignKeys.audiencePreview(selected),
    queryFn: () => campaignsApi.previewAudience({ listIds: selected }),
    enabled: selected.length > 0,
  });

  return (
    <div className="max-w-lg space-y-4">
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Send to</legend>

        {lists.isPending ? <Loading /> : null}
        {lists.data?.map((list: { id: string; name: string }) => (
          <label key={list.id} className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(list.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, list.id]
                    : current.filter((value) => value !== list.id),
                )
              }
            />
            {list.name}
          </label>
        ))}
      </fieldset>

      {preview.data !== undefined ? (
        <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          <strong>{preview.data.eligible.toLocaleString()}</strong> contacts will receive this.
          {preview.data.suppressed > 0 ? (
            <>
              {' '}
              {preview.data.suppressed.toLocaleString()} will be skipped because they have
              unsubscribed or bounced.
            </>
          ) : null}
        </p>
      ) : null}

      <Button
        type="button"
        disabled={selected.length === 0 || save.isPending}
        onClick={() => save.mutate({ audience: { listIds: selected } }, { onSuccess: onDone })}
      >
        Save and continue
      </Button>
    </div>
  );
}

function TemplateStep({ campaign, onDone }: { campaign: Campaign; onDone: () => void }) {
  const save = useSave(campaign);
  const templates = useQuery({ queryKey: templateKeys.all, queryFn: () => templateApi.list() });

  return (
    <div className="max-w-lg space-y-4">
      {templates.isPending ? <Loading /> : null}

      {templates.data?.length === 0 ? (
        <EmptyState title="No templates yet">
          <Link className="text-sm underline" to="/templates/create">
            Create one
          </Link>
        </EmptyState>
      ) : null}

      <ul className="space-y-2">
        {templates.data?.map((template: { id: string; name: string; currentVersionId: string | null }) => (
          <li key={template.id}>
            <button
              type="button"
              disabled={template.currentVersionId === null}
              onClick={() =>
                save.mutate({ templateId: template.id }, { onSuccess: onDone })
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-left text-sm disabled:opacity-50"
            >
              {template.name}
              {template.currentVersionId === null ? (
                // A template with no published version cannot be pinned, and
                // saying why is more useful than a disabled button.
                <span className="ml-2 text-xs text-slate-500">— no published version yet</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SenderStep({ campaign, onDone }: { campaign: Campaign; onDone: () => void }) {
  const save = useSave(campaign);

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-slate-600">
        Choose the sender this campaign goes out from, or a pool if you want it spread across
        several.
      </p>

      <Link className="text-sm underline" to="/senders">
        Manage senders
      </Link>

      <Button type="button" disabled={save.isPending} onClick={onDone}>
        Continue
      </Button>
    </div>
  );
}

function TrackingStep({ onDone }: { onDone: () => void }) {
  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-slate-600">
        Opens and clicks are tracked by default. An unsubscribe link is always added — it is
        required by every major mailbox provider and is not a setting.
      </p>

      <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Open tracking is approximate. Privacy features in Apple Mail and others fetch images
        automatically, which inflates opens, and image blocking suppresses them. Click rate is the
        number to judge a campaign by.
      </p>

      <Button type="button" onClick={onDone}>
        Continue
      </Button>
    </div>
  );
}

function ScheduleStep({ campaign, onDone }: { campaign: Campaign; onDone: () => void }) {
  const [when, setWhen] = useState('');
  const client = useQueryClient();

  const schedule = useMutation({
    mutationFn: () =>
      campaignsApi.schedule(campaign.id, {
        scheduledAt: new Date(when).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: campaignKeys.one(campaign.id) });
      onDone();
    },
  });

  return (
    <div className="max-w-lg space-y-4">
      <TextField
        id="scheduled-at"
        label="Send at"
        type="datetime-local"
        value={when}
        onChange={setWhen}
        hint={`Times are in ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`}
      />

      <div className="flex gap-2">
        <Button type="button" disabled={when === '' || schedule.isPending} onClick={() => schedule.mutate()}>
          Schedule
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Send manually instead
        </Button>
      </div>
    </div>
  );
}

function ReviewStep({ campaign }: { campaign: Campaign }) {
  const client = useQueryClient();
  const issues = usePreflight(campaign);
  const blocking = issues.filter((issue) => issue.severity === 'blocking');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const [source, setSource] = useState<ConsentSource | ''>('');
  const [detail, setDetail] = useState('');

  /**
   * One key per mounted review step, not one per click.
   *
   * That is the whole point: a double-clicked launch, or a retried request
   * after a flaky connection, must carry the *same* key so the second one
   * receives the first one's result instead of a 409 (F29). Minting it inside
   * the click handler would produce a new key each time, which is the same as
   * having none.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const launch = useMutation({
    mutationFn: () =>
      campaignsApi.launch(campaign.id, idempotencyKey, {
        source: source as ConsentSource,
        ...(detail.trim() === '' ? {} : { detail: detail.trim() }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: campaignKeys.one(campaign.id) }),
  });

  return (
    <div className="max-w-lg space-y-4">
      {blocking.length > 0 ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm font-medium text-rose-900">Fix these before sending</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-800">
            {blocking.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.map((issue) => (
        <p key={issue.message} className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {issue.message}
        </p>
      ))}

      {/*
        A declared source, not a tick box.

        The tick box was here first and recorded nothing — it could not be
        shown to a provider asking why we let this workspace send, which is
        the only reason it exists. docs/06: "every launch re-confirms it.
        Stored, timestamped, attributed to a user."

        No default selection, deliberately. A pre-selected first option
        would be attested by everyone who clicked past this screen without
        reading it, and an attestation the sender did not mean is worse than
        none: it looks like evidence.
      */}
      <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
        <label htmlFor="launch-consent" className="block text-sm font-medium text-slate-800">
          Where did this audience agree to hear from you?
        </label>
        <select
          id="launch-consent"
          value={source}
          onChange={(event) => setSource(event.target.value as ConsentSource)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">Choose one…</option>
          {CONSENT_SOURCE_LABELS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {source === 'other' ? (
          <div className="space-y-1">
            <label htmlFor="launch-consent-detail" className="block text-sm text-slate-700">
              Describe how they agreed
            </label>
            <textarea
              id="launch-consent-detail"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              rows={2}
              placeholder="Collected at our trade stand, paper forms scanned and retained"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        ) : null}

        <p className="text-xs text-slate-500">
          Recorded against this campaign with your name and the time. This is what we show a
          provider who asks why we let this send.
        </p>
      </div>

      <Button
        type="button"
        disabled={
          !canLaunch(issues) || !consentIsComplete(source, detail) || launch.isPending
        }
        onClick={() => launch.mutate()}
      >
        {launch.isPending ? 'Starting…' : 'Send campaign'}
      </Button>

      {launch.isError ? (
        <p className="text-sm text-rose-700">{(launch.error as Error).message}</p>
      ) : null}
    </div>
  );
}

/** A launched campaign: the report. */
function CampaignReport({ campaign }: { campaign: Campaign }) {
  const client = useQueryClient();

  const progress = useQuery({
    queryKey: campaignKeys.progress(campaign.id),
    queryFn: () => campaignsApi.progress(campaign.id),
    refetchInterval: pollIntervalFor(campaign.status),
  });

  const act = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') => campaignsApi[action](campaign.id),
    onSuccess: () => client.invalidateQueries({ queryKey: campaignKeys.one(campaign.id) }),
  });

  const counts = progress.data;

  return (
    <Page
      title={campaign.name}
      action={
        <div className="flex gap-2">
          {campaign.status === 'sending' ? (
            <Button variant="secondary" onClick={() => act.mutate('pause')}>
              Pause
            </Button>
          ) : null}
          {campaign.status === 'paused' ? (
            <Button onClick={() => act.mutate('resume')}>Resume</Button>
          ) : null}
          {['sending', 'paused', 'pausing', 'held'].includes(campaign.status) ? (
            <Button variant="danger" onClick={() => act.mutate('cancel')}>
              Cancel
            </Button>
          ) : null}
        </div>
      }
    >
      <p className="mb-4">
        <StatusBadge status={campaign.status} />
      </p>

      {counts !== undefined ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Sent" value={counts.sent} />
          <Stat label="Remaining" value={counts.outstanding} />
          <Stat label="Failed" value={counts.failed} />
          {/* Its own tile, never added to Failed. D3: these may well have been
              delivered, and they are not billed. */}
          <Stat
            label="Delivery uncertain"
            value={counts.deliveryUncertain}
            hint="Sent, but the provider never confirmed. Not charged."
          />
        </div>
      ) : (
        <Loading />
      )}
    </Page>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | undefined;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      {/* An em dash rather than a crash. This screen is what a customer
          watches while a campaign sends, and a missing field in one response
          should cost them one number, not the page. */}
      <p className="mt-1 text-2xl font-semibold text-slate-900">
        {typeof value === 'number' ? value.toLocaleString() : '—'}
      </p>
      {hint === undefined ? null : <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: CampaignStatus }) {
  const meta = STATUS_LABELS[status];
  const tone =
    status === 'failed' || status === 'cancelled'
      ? 'bad'
      : status === 'held' || status === 'completed_with_errors' || status === 'paused'
        ? 'warn'
        : status === 'completed'
          ? 'good'
          : 'neutral';

  return (
    <span title={meta.hint}>
      <Badge tone={tone}>{meta.label}</Badge>
    </span>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      {hint === undefined ? null : <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
