import { api } from './client.js';

/**
 * Sending pools (design section H).
 *
 * A pool is a group of verified senders a campaign can send through. The one
 * thing this whole section exists to make visible is the thing docs/07 spends
 * a page forbidding: a pool is not a way to exceed a provider account's
 * quota. Two senders on one provider connection share one bucket, so the
 * headroom the UI shows is summed **per connection**, never per sender — see
 * `combineHeadroom` in `routes/pools/headroom.ts`, which is the browser copy
 * of the same rule the rate limiter enforces on the connection id.
 *
 * `POST /pools`, `PATCH /pools/:id`, `DELETE /pools/:id` and the two member
 * endpoints are real (apps/api/src/routes/pools.ts, `provider:write`).
 * `GET /pools` is real but returns only the pool rows, so the columns H1a
 * draws — members, combined rate, combined headroom, which campaigns use it —
 * are optional here and marked BACKEND PENDING at their call sites. Absent
 * means the cell renders an em dash rather than a wrong number.
 */

/** The database's four; H1b offers the two the design names. */
export type PoolStrategy = 'round_robin' | 'weighted' | 'failover' | 'least_loaded';

/** One chip in H1a's "Members" cell. */
export interface PoolMemberChip {
  senderAccountId: string;
  email: string;
  /** "SES", "SG", "SMTP" — the letters in the 16px tile. */
  monogram: string;
}

export interface PoolHeadroom {
  /** Emails this pool's connections can still accept today. */
  remaining: number;
  /** What those connections allow in a day, all together. */
  total: number;
  /** H1a's line under the bar: "2 connections · counted once each". */
  note: string;
}

export interface Pool {
  id: string;
  name: string;
  strategy: PoolStrategy;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;

  // ---- BACKEND PENDING: GET /pools returns none of these yet ------------
  /** The senders in the pool, for the chips. */
  members?: PoolMemberChip[];
  /** Emails per second the pool can sustain, under its strategy. */
  combinedPerSecond?: number;
  headroom?: PoolHeadroom;
  /** Names of the campaigns that name this pool. */
  usedBy?: string[];
}

/** A row of `GET /pools/:id` — the membership, as the router reads it. */
export interface PoolMember {
  poolId: string;
  senderAccountId: string;
  providerConnectionId: string;
  weight: number;
  priority: number;
  enabled: boolean;
  status: string;
  healthScore: number;
  cooldownUntil: string | null;
}

export interface PoolDetail {
  pool: Pool;
  members: PoolMember[];
}

/**
 * One row of H1b's member list.
 *
 * The connection fields are properties of the *connection*, repeated on every
 * sender that draws on it. That repetition is deliberate: it is what lets the
 * drawer group by `providerConnectionId` and count each connection once
 * without a second request, and it is why two senders on one SES account do
 * not double the headroom the drawer reports.
 */
export interface EligibleSender {
  id: string;
  email: string;
  monogram: string;
  providerConnectionId: string;
  /** "Amazon SES · eu-west-1". */
  connectionLabel: string;
  /** The connection's rate limit, not this sender's share of it. */
  perSecond: number;
  /** What the connection has left today. */
  remainingToday: number;
  /**
   * Why this sender cannot be pooled yet — an unverified identity, in
   * practice. The row is disabled and the label becomes a warning badge.
   */
  blockedReason?: string | null;
}

export const poolsApi = {
  list: () => api.get<Pool[]>('/pools'),

  get: (id: string) => api.get<PoolDetail>(`/pools/${id}`),

  /**
   * The verified senders a pool may contain, with their connection's current
   * headroom — everything H1b's member list draws.
   *
   * BACKEND PENDING: GET /pools/senders. `GET /senders` exists but answers
   * with sender rows alone: no connection label, no rate and no remaining
   * quota, and the combined-headroom panel is those three numbers.
   */
  eligibleSenders: () => api.get<EligibleSender[]>('/pools/senders'),

  create: (input: { name: string; strategy: PoolStrategy }) => api.post<Pool>('/pools', input),

  update: (id: string, input: { name?: string; strategy?: PoolStrategy }) =>
    api.patch<Pool>(`/pools/${id}`, input),

  remove: (id: string) => api.delete<void>(`/pools/${id}`),

  addMember: (poolId: string, input: { senderAccountId: string; weight?: number; priority?: number }) =>
    api.post<PoolMember>(`/pools/${poolId}/members`, {
      senderAccountId: input.senderAccountId,
      weight: input.weight ?? 1,
      priority: input.priority ?? 0,
    }),

  removeMember: (poolId: string, senderAccountId: string) =>
    api.delete<void>(`/pools/${poolId}/members/${senderAccountId}`),
};

/** Query keys, prefixed with the workspace as docs/09 requires. */
export const poolKeys = {
  scoped: (workspaceId: string | null) => [workspaceId, 'pools'] as const,
  list: (workspaceId: string | null) => [workspaceId, 'pools', 'list'] as const,
  detail: (workspaceId: string | null, id: string) =>
    [workspaceId, 'pools', 'detail', id] as const,
  senders: (workspaceId: string | null) => [workspaceId, 'pools', 'senders'] as const,
};

/** The two strategies H1b offers, with the frame's own descriptions. */
export const STRATEGY_OPTIONS: readonly {
  value: Extract<PoolStrategy, 'round_robin' | 'failover'>;
  label: string;
  description: string;
}[] = [
  {
    value: 'round_robin',
    label: 'Round-robin',
    description:
      'Alternate members per recipient. Combined speed is the sum of members on different connections.',
  },
  {
    value: 'failover',
    label: 'Failover',
    description: 'Send through the first member; switch to the next only when it errors or hits its quota.',
  },
];

/** What H1a's pill says. `weighted` and `least_loaded` have no frame. */
export function strategyLabel(strategy: PoolStrategy): string {
  switch (strategy) {
    case 'round_robin':
      return 'Round-robin';
    case 'failover':
      return 'Failover';
    case 'weighted':
      return 'Weighted';
    case 'least_loaded':
      return 'Least loaded';
  }
}
