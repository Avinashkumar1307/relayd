import { api } from './client.js';

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

export const campaignsApi = {
  list: (query: { state?: string; search?: string } = {}) =>
    api.get<{ items: Campaign[]; nextCursor: string | null }>('/campaigns', query),

  get: (id: string) =>
    api.get<{ campaign: Campaign; counters: CampaignProgress | null }>(`/campaigns/${id}`),

  progress: (id: string) => api.get<CampaignProgress>(`/campaigns/${id}/progress`),

  recipients: (id: string, query: { state?: string; search?: string } = {}) =>
    api.get<{ items: Recipient[]; nextCursor: string | null }>(`/campaigns/${id}/recipients`, query),

  create: (input: { name: string }) => api.post<Campaign>('/campaigns', input),

  update: (id: string, input: Record<string, unknown>) =>
    api.patch<Campaign>(`/campaigns/${id}`, input),

  previewAudience: (input: { listIds: string[]; segmentIds?: string[] }) =>
    api.post<AudiencePreview>('/campaigns/audience-preview', {
      listIds: input.listIds,
      segmentIds: input.segmentIds ?? [],
      excludeListIds: [],
    }),

  schedule: (id: string, input: { scheduledAt: string; timezone: string }) =>
    api.post<Campaign>(`/campaigns/${id}/schedule`, input),

  /**
   * Launch, with an idempotency key.
   *
   * The key is minted here rather than by the server precisely because a
   * retry has to reuse it — a server-minted key would be a new key on every
   * attempt, which is the same as having none (F29).
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
};

export const poolsApi = {
  list: () => api.get<{ id: string; name: string; strategy: string }[]>('/pools'),
  health: (id: string) => api.get<PoolHealth>(`/pools/${id}/health`),
};

export const campaignKeys = {
  all: ['campaigns'] as const,
  one: (id: string) => ['campaigns', id] as const,
  progress: (id: string) => ['campaigns', id, 'progress'] as const,
  recipients: (id: string, query: unknown) => ['campaigns', id, 'recipients', query] as const,
  audiencePreview: (listIds: string[]) => ['campaigns', 'audience-preview', listIds] as const,
  poolHealth: (id: string) => ['pools', id, 'health'] as const,
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
 * Written out rather than prettified from the enum, because several of these
 * need to say more than their name does. `held` in particular: a customer who
 * reads "Held" learns nothing, and a customer who reads that it will resume by
 * itself does not open a ticket.
 */
export const STATUS_LABELS: Readonly<Record<CampaignStatus, { label: string; hint?: string }>> = {
  draft: { label: 'Draft' },
  scheduled: { label: 'Scheduled' },
  validating: { label: 'Checking', hint: 'Taking a snapshot of the audience' },
  queueing: { label: 'Starting', hint: 'Queueing the first recipients' },
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
    label: 'On hold',
    hint: 'Paused automatically — it will resume by itself once the reason clears',
  },
  failed: { label: 'Failed' },
};
