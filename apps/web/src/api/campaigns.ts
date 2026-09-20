import { api } from './client.js';
import type { SegmentCounts } from '@relayd/ui';

/** Campaign and sending-pool endpoints. */

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'validating'
  | 'queueing'
  | 'sending'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'completed_with_errors'
  | 'held'
  | 'failed';

/** The banner G3b and G3c draw above the campaign, when it has one. */
export interface CampaignHold {
  tone: 'warning' | 'danger';
  icon: 'lock' | 'alert';
  title: string;
  body: string;
  actionLabel: string;
  actionHref: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  subjectOverride: string | null;
  templateVersionId: string | null;
  senderAccountId: string | null;
  sendingPoolId: string | null;
  audience: { listIds?: string[]; segmentIds?: string[] };
  scheduledAt: string | null;
  timezone: string | null;
  recipientCount: number;
  launchedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;

  // ---- BACKEND PENDING: GET /campaigns returns none of these yet ---------
  // G1 draws one row per campaign with its segmented bar, its click rate and
  // the sentence under the name. Every one of those is a counter or a label
  // the list endpoint does not carry today; computing them in the browser
  // would mean a progress call per row, which is the `COUNT(*)`-in-a-request
  // problem wearing a different hat (CLAUDE.md section 12).
  /** The segmented bar's buckets, from `campaign_counters`. Never a COUNT(*). */
  counts?: SegmentCounts;
  /** Unique clickers. `null` while nothing has been delivered. */
  clicks?: number | null;
  /** G1's "Scheduled / sent" cell: "Started today, 09:00", "Held since 17 Sep". */
  whenLabel?: string;
  /** G1's "Sender" cell: the from address, or the pool's name. */
  senderLabel?: string;
  /** The second line under the name when there is one: "Held by billing". */
  note?: string | null;
  /** G3's meta line: "Launched 19 Sep 2026, 09:00 GST by Farah Al-Mansoori · …". */
  metaLabel?: string;
  /** The banner above a held or auto-paused campaign (G3b, G3c). */
  hold?: CampaignHold | null;
}

export interface CampaignProgress {
  total: number;
  pending: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  suppressed: number;
  uncertain: number;
  outstanding: number;
  complete: boolean;
  /** D3: terminal, unbilled, and its own number — never folded into failures. */
  deliveryUncertain: number;

  // ---- BACKEND PENDING: GET /campaigns/:id/progress ----------------------
  // G3's progress card and its six stat tiles read delivered, bounced and
  // complained separately; `sent` alone cannot draw them.
  counts?: SegmentCounts;
  /** Unique clickers, for the headline click rate. */
  clicks?: number | null;
  /** "~38.1%" — always rendered with the approximate marker beside it. */
  openRate?: number | null;
}

export interface AudiencePreview {
  eligible: number;
  suppressed: number;
  total: number;
}

export interface LaunchResult {
  ok: boolean;
  recipientCount?: number;
  suppressedAtSnapshot?: number;
}

export interface Recipient {
  id: string;
  email: string;
  state: string;
  deliveryState: string | null;
  attemptCount: number;
  errorCode: string | null;
  sentAt: string | null;

  // ---- BACKEND PENDING: GET /campaigns/:id/recipients --------------------
  /** G3's "Provider message ID" column — the join to the provider's own log. */
  providerMessageId?: string | null;
  /** G3's "Last event" column: "Mailbox full · retry 13:15". */
  lastEvent?: string | null;
  /** G3's "Sender used" column: "offers@ · SendGrid". */
  senderUsed?: string | null;
}

export interface TimelineEvent {
  id: string;
  title: string;
  /**
   * "11:02", "18 Sep, 16:20" — already in the campaign's timezone.
   *
   * Rendered by the API rather than here, and that is the point: a Dubai
   * campaign read from a laptop in London has to say the time the customer
   * scheduled, not the time it is where the browser happens to be.
   */
  time: string;
  detail: string;
  tone: 'brand' | 'success' | 'warning' | 'danger' | 'neutral';
  /** The instant behind `time`, for sorting or re-rendering. */
  occurredAt: string;
}

/**
 * One row of G2 step 7's pre-flight list.
 *
 * The server runs the same checks the launch runs — literally the same
 * function — so a pre-flight that passes and a launch that then refuses
 * cannot disagree about anything in this list.
 *
 * Two checks are not here and their absence is deliberate: the audience
 * count and the plan-limit headroom are decided against the snapshot the
 * launch takes, and the pre-flight takes none. The wizard shows those from
 * `POST /campaigns/audience-preview`, which counts with the snapshot's own
 * predicates.
 */
export interface PreflightServerCheck {
  key: string;
  outcome: 'pass' | 'warn' | 'fail';
  title: string;
  detail: string;
  /** The launch failure code this check would produce. Null when it passed. */
  failure: string | null;
}

export interface PreflightResult {
  ok: boolean;
  /** The first failure in launch order — the code `POST /launch` would answer. */
  failure: string | null;
  checks: PreflightServerCheck[];
}

export interface PoolMemberHealth {
  senderAccountId: string;
  providerConnectionId: string;
  enabled: boolean;
  status: string;
  healthScore: number;
  belowHealthFloor: boolean;
  sharesProviderAccount: boolean;
}

export interface PoolHealth {
  strategy: string;
  members: PoolMemberHealth[];
  healthyCount: number;
  sharedProviderAccounts: string[];
  wouldHold: boolean;
}

/** A row of `GET /pools`, as the wizard's step 3 needs to draw it. */
export interface PoolSummary {
  id: string;
  name: string;
  strategy: string;

  // ---- BACKEND PENDING: GET /pools --------------------------------------
  /** "Round-robin · hello@ (SES) + offers@ (SendGrid) · 64 emails/s combined". */
  detail?: string;
  /** Today's remaining provider quota across the members, and its ceiling. */
  headroomLeft?: number | null;
  headroomTotal?: number | null;
}

export const campaignsApi = {
  /**
   * `archived` defaults to `active` server-side, so an archived campaign is
   * off G1 until something asks for it.
   */
  list: (query: { state?: string; search?: string; archived?: 'active' | 'archived' | 'all' } = {}) =>
    api.get<{ items: Campaign[]; nextCursor: string | null }>('/campaigns', query),

  get: (id: string) =>
    api.get<{ campaign: Campaign; counters: CampaignProgress | null }>(`/campaigns/${id}`),

  progress: (id: string) => api.get<CampaignProgress>(`/campaigns/${id}/progress`),

  recipients: (id: string, query: { state?: string; search?: string } = {}) =>
    api.get<{ items: Recipient[]; nextCursor: string | null }>(`/campaigns/${id}/recipients`, query),

  /** G3's "Event timeline", newest first, from `campaign_events`. */
  timeline: (id: string) => api.get<TimelineEvent[]>(`/campaigns/${id}/timeline`),

  create: (input: { name: string }) => api.post<Campaign>('/campaigns', input),

  update: (id: string, input: Record<string, unknown>) =>
    api.patch<Campaign>(`/campaigns/${id}`, input),

  remove: (id: string) => api.delete<void>(`/campaigns/${id}`),

  clone: (id: string, name?: string) =>
    api.post<Campaign>(`/campaigns/${id}/clone`, name === undefined ? {} : { name }),

  previewAudience: (input: { listIds: string[]; segmentIds?: string[]; excludeListIds?: string[] }) =>
    api.post<AudiencePreview>('/campaigns/audience-preview', {
      listIds: input.listIds,
      segmentIds: input.segmentIds ?? [],
      excludeListIds: input.excludeListIds ?? [],
    }),

  schedule: (id: string, input: { scheduledAt: string; timezone: string }) =>
    api.post<Campaign>(`/campaigns/${id}/schedule`, input),

  /**
   * Launch, with an idempotency key.
   *
   * The key is minted here rather than by the server precisely because a
   * retry has to reuse it — a server-minted key would be a new key on every
   * attempt, which is the same as having none (F29).
   *
   * An API key can never reach this: the route carries `refuseApiKey()` on
   * top of `campaign:launch`, because a consent attestation has to be
   * attributable to a person (CLAUDE.md section 11).
   */
  launch: (id: string, idempotencyKey: string, consent: { source: string; detail?: string }) =>
    api.post<LaunchResult>(`/campaigns/${id}/launch`, { consent }, {
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  pause: (id: string) => api.post<{ state: string }>(`/campaigns/${id}/pause`),
  resume: (id: string) => api.post<{ state: string }>(`/campaigns/${id}/resume`),
  cancel: (id: string) => api.post<{ state: string }>(`/campaigns/${id}/cancel`),

  retryFailed: (id: string) =>
    api.post<{ retried: number; excluded: Record<string, number> }>(`/campaigns/${id}/retry-failed`),

  testSend: (id: string, to: string[]) => api.post<{ queued: number }>(`/campaigns/${id}/test-send`, { to }),

  /**
   * G1's Archive action, on a campaign that has finished.
   *
   * 409 while it is still running — archiving hides it from the list, and
   * hiding a campaign that is still handing messages to a provider would
   * take the only view of a live send off the screen.
   */
  archive: (id: string) => api.post<Campaign>(`/campaigns/${id}/archive`),

  /** The inverse. Find archived campaigns with `list({ archived: 'archived' })`. */
  unarchive: (id: string) => api.post<Campaign>(`/campaigns/${id}/unarchive`),

  /**
   * G2 step 7's server-side checks, run without launching.
   *
   * POST despite reading nothing: it renders the message and calls a link
   * reputation feed, and a GET invites a browser prefetch to do that
   * unasked.
   */
  preflight: (id: string) => api.post<PreflightResult>(`/campaigns/${id}/preflight`),
};

export const poolsApi = {
  list: () => api.get<PoolSummary[]>('/pools'),
  health: (id: string) => api.get<PoolHealth>(`/pools/${id}/health`),
};

/**
 * Query keys, prefixed with the workspace so a switch cannot serve one
 * tenant's campaigns to another from cache.
 */
export const campaignKeys = {
  /**
   * Unscoped, and deliberately still a tuple: `components/onboarding-checklist`
   * spreads it (`[...campaignKeys.all, …]`) and is a shared contract this
   * section does not own. Every key below is workspace-prefixed; this one is
   * the checklist's own namespace and is invalidated alongside them.
   */
  all: ['campaigns'] as const,
  scoped: (workspaceId: string | null) => [workspaceId, 'campaigns'] as const,
  list: (workspaceId: string | null, query: unknown) =>
    [workspaceId, 'campaigns', 'list', query] as const,
  one: (workspaceId: string | null, id: string) => [workspaceId, 'campaigns', id] as const,
  progress: (workspaceId: string | null, id: string) =>
    [workspaceId, 'campaigns', id, 'progress'] as const,
  recipients: (workspaceId: string | null, id: string, query: unknown) =>
    [workspaceId, 'campaigns', id, 'recipients', query] as const,
  timeline: (workspaceId: string | null, id: string) =>
    [workspaceId, 'campaigns', id, 'timeline'] as const,
  preflight: (workspaceId: string | null, id: string) =>
    [workspaceId, 'campaigns', id, 'preflight'] as const,
  audiencePreview: (workspaceId: string | null, selection: unknown) =>
    [workspaceId, 'campaigns', 'audience-preview', selection] as const,
  pools: (workspaceId: string | null) => [workspaceId, 'pools'] as const,
  poolHealth: (workspaceId: string | null, id: string) => [workspaceId, 'pools', id, 'health'] as const,
};

/**
 * How long a campaign in each state should be polled.
 *
 * A campaign that is sending changes every second; one that has completed
 * never changes again. Polling a terminal campaign forever is the easiest way
 * to turn a dashboard left open overnight into a sustained load.
 */
export function pollIntervalFor(status: CampaignStatus): number | false {
  if (TERMINAL.has(status)) return false;
  if (TRANSIENT.has(status)) return 2_000;
  return 5_000;
}

const TERMINAL: ReadonlySet<CampaignStatus> = new Set([
  'completed',
  'completed_with_errors',
  'cancelled',
  'failed',
]);

/** States mid-flight, where the user is watching for a change. */
const TRANSIENT: ReadonlySet<CampaignStatus> = new Set([
  'validating',
  'queueing',
  'sending',
  'pausing',
  'cancelling',
]);

/**
 * What the UI is allowed to say about a campaign's state.
 *
 * The labels and tones themselves live in `@relayd/ui`'s `CAMPAIGN_STATES`,
 * which mirrors `design/relayd-ui.js`. What is here is only the *hint*: the
 * sentence a state needs when its name does not carry its meaning. `held` in
 * particular — a customer who reads "Held" learns nothing, and a customer who
 * reads that it will resume by itself does not open a ticket.
 */
export const STATUS_LABELS: Readonly<Record<CampaignStatus, { label: string; hint?: string }>> = {
  draft: { label: 'Draft' },
  scheduled: { label: 'Scheduled' },
  validating: { label: 'Validating', hint: 'Taking a snapshot of the audience' },
  queueing: { label: 'Queueing', hint: 'Queueing the first recipients' },
  sending: { label: 'Sending' },
  pausing: { label: 'Pausing', hint: 'Messages already at the provider will finish' },
  paused: { label: 'Paused' },
  cancelling: { label: 'Cancelling', hint: 'Messages already at the provider will finish' },
  cancelled: { label: 'Cancelled' },
  completed: { label: 'Completed' },
  completed_with_errors: {
    label: 'Completed with errors',
    hint: 'Some recipients could not be delivered to',
  },
  held: {
    label: 'Held',
    hint: 'Paused automatically — it will resume by itself once the reason clears',
  },
  failed: { label: 'Failed' },
};

/**
 * G1's tabs, from the `TABS` table at the foot of `design/G Campaigns.dc.html`.
 *
 * Copied key for key rather than derived, because the groupings are a
 * product decision and not a property of the state machine: `held` is filed
 * under Scheduled because that is what a held campaign is waiting to be, and
 * `cancelled` and `failed` are filed under Completed because they are over.
 */
export interface CampaignTab {
  key: string;
  label: string;
  /** `null` is "All". */
  states: readonly CampaignStatus[] | null;
}

export const CAMPAIGN_TABS: readonly CampaignTab[] = [
  { key: 'all', label: 'All', states: null },
  { key: 'drafts', label: 'Drafts', states: ['draft'] },
  { key: 'scheduled', label: 'Scheduled', states: ['scheduled', 'held'] },
  { key: 'sending', label: 'Sending', states: ['sending', 'validating', 'queueing', 'pausing', 'paused'] },
  {
    key: 'completed',
    label: 'Completed',
    states: ['completed', 'completed_with_errors', 'cancelled', 'failed'],
  },
];

/**
 * The row menu, per state, from the same script's `ACTIONS` map.
 *
 * Verbatim, including the two places it says "Duplicate" where a neighbour
 * says "Clone" — the wording differs per state in the design and changing it
 * here would be inventing copy.
 */
export const CAMPAIGN_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ['Edit', 'Duplicate', 'Delete'],
  scheduled: ['Edit schedule', 'Unschedule', 'Duplicate'],
  sending: ['Pause', 'Cancel', 'Clone'],
  validating: ['Cancel'],
  paused: ['Resume', 'Cancel', 'Clone'],
  held: ['Update payment method', 'Cancel', 'Duplicate'],
  completed: ['View analytics', 'Duplicate', 'Archive'],
  completed_with_errors: ['Retry failed', 'View analytics', 'Duplicate'],
  cancelled: ['Duplicate', 'Archive'],
  failed: ['Retry', 'Duplicate', 'Archive'],
};

/** The design's fallback for a state the map does not name. */
export const DEFAULT_CAMPAIGN_ACTIONS: readonly string[] = ['Duplicate'];

export function actionsFor(status: CampaignStatus): readonly string[] {
  return CAMPAIGN_ACTIONS[status] ?? DEFAULT_CAMPAIGN_ACTIONS;
}

/** `/Cancel|Delete/` — the design's own test for a destructive menu item. */
export function isDestructiveAction(label: string): boolean {
  return /Cancel|Delete/u.test(label);
}

/**
 * G3's recipient filter chips, from the script's `RSTATE_FILTERS`.
 *
 * The state names are `campaign_recipients.state` values, so a chip filters
 * by what the API returns rather than by a display word.
 */
export interface RecipientFilter {
  key: string;
  label: string;
  states: readonly string[] | null;
}

export const RECIPIENT_FILTERS: readonly RecipientFilter[] = [
  { key: 'all', label: 'All', states: null },
  { key: 'delivered', label: 'Delivered', states: ['delivered'] },
  { key: 'pending', label: 'Pending', states: ['pending', 'queued', 'sending'] },
  {
    key: 'bounced',
    label: 'Bounced',
    states: ['soft_bounced', 'hard_bounced', 'complained', 'failed'],
  },
  { key: 'uncertain', label: 'Uncertain', states: ['delivery_uncertain'] },
];

/**
 * The click rate, exactly as `design/relayd-ui.js` computes it: unique
 * clickers over delivered, one decimal, an em dash when either is missing.
 *
 * Over *delivered*, not over sent. Dividing by sent understates every
 * campaign by its bounce rate, and the headline metric of the product should
 * not move when a provider changes how it reports bounces.
 */
export function clickRate(clicks: number | null | undefined, delivered: number | undefined): string {
  if (clicks === null || clicks === undefined) return '—';
  if (delivered === undefined || delivered === 0) return '—';
  return `${((clicks / delivered) * 100).toFixed(1)}%`;
}
