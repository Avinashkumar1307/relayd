/**
 * Sending pools: choosing which of the customer's own accounts sends a batch.
 *
 * Routing exists for two reasons — to respect limits across several accounts,
 * and to fail over when one stops working. It exists for exactly those two,
 * and the constraint it is built around is the one that stops it becoming a
 * third thing:
 *
 *   **A pool's capacity is the sum of independently legitimate accounts, not
 *   a way to exceed one account's quota.**
 *
 * The mechanism that enforces it is small and easy to get wrong: rate-limit
 * buckets are keyed by `provider_connection_id`, never by
 * `sender_account_id`. Add the same SES account to a pool three times and all
 * three senders draw on one bucket. Key by sender and you have built a
 * quota-evasion tool with a scheduling UI.
 *
 * Three more rules follow from the same principle:
 *
 *   A `quota_exceeded` rejection cools that sender down and does **not**
 *   reroute the message to a sibling. Rerouting on quota is exactly the
 *   evasion the bucket keying prevents, reintroduced at a higher layer.
 *
 *   A `provider_unavailable` rejection is different in kind — the account is
 *   fine, the provider is not — so it may fail over immediately.
 *
 *   A pool with no healthy sender does not fail the campaign. It moves to
 *   `held`, which is auto-resumable, because failing a half-sent campaign is
 *   almost always the wrong call.
 */

/** Below this a sender is skipped by the router, though still selectable by hand. */
export const MIN_HEALTH = 40;

/** A deferral never waits longer than this, whatever the buckets say. */
export const MAX_DEFER_MS = 60_000;

export type PoolStrategy = 'round_robin' | 'weighted' | 'failover' | 'least_loaded';

export interface PoolMember {
  senderAccountId: string;
  /** The bucket key. Two members may legitimately share one. */
  providerConnectionId: string;
  enabled: boolean;
  status: 'active' | 'cooling_down' | 'paused' | 'disabled';
  healthScore: number;
  cooldownUntil: Date | null;
  /** Domains this sender's identity is verified for. */
  verifiedDomains: readonly string[];
  priority: number;
  weight: number;
  tokensRemaining: number;
}

export type SenderSelection =
  | {
      kind: 'lease';
      senderAccountId: string;
      providerConnectionId: string;
      /** True when another member of this pool shares the same bucket. */
      sharesBucket: boolean;
    }
  | { kind: 'defer'; retryAfterMs: number; blockedBy: string }
  | { kind: 'no_sender'; reason: string };

export interface RateGrant {
  ok: boolean;
  /** How long until the blocking bucket has room, when refused. */
  refillMs?: number;
  /** Which bucket refused, for the log line that gets read at 3am. */
  blockedBy?: string;
}

export interface RoutingPort {
  /**
   * Consumes `count` tokens across every bucket at once, or none of them.
   *
   * The keys are built by `bucketKeysFor`, and the connection-scoped ones are
   * what make a shared account share a quota.
   */
  consume(input: { keys: readonly string[]; count: number }): Promise<RateGrant>;

  /** Returns tokens when a later step in the same selection fails. */
  refund(input: { keys: readonly string[]; count: number }): Promise<void>;

  /**
   * The Redis concurrency counter, not a Postgres row lock.
   *
   * Deliberately the weaker mechanism: a brief over-admission by one is
   * harmless, and a row lock held across an HTTP call to a provider is not.
   */
  acquireSlot(input: { senderAccountId: string; limit: number }): Promise<boolean>;

  releaseSlot(senderAccountId: string): Promise<void>;

  /** Round-robin's cursor, per pool. Monotonic; wrapping is the caller's job. */
  nextCursor(poolId: string): Promise<number>;
}

/**
 * The buckets one send must pass, in the order they are checked.
 *
 * Connection first, so the shared-account case is refused by the cheapest and
 * most important bucket before a per-sender bucket can grant anything.
 */
export function bucketKeysFor(member: {
  providerConnectionId: string;
  senderAccountId: string;
}): string[] {
  return [
    `rl:${member.providerConnectionId}:hour`,
    `rl:${member.providerConnectionId}:day`,
    `rl:${member.senderAccountId}:hour`,
    `rl:${member.senderAccountId}:day`,
  ];
}

/**
 * Members eligible to send right now.
 *
 * Every filter is a separate reason a sender is unavailable, and the order is
 * cheapest-first so the common rejections cost nothing.
 */
export function eligibleMembers(
  members: readonly PoolMember[],
  input: { fromDomain: string; now: Date; minHealth?: number },
): PoolMember[] {
  const minHealth = input.minHealth ?? MIN_HEALTH;

  return members.filter(
    (m) =>
      m.enabled &&
      m.status === 'active' &&
      m.healthScore >= minHealth &&
      (m.cooldownUntil === null || m.cooldownUntil.getTime() <= input.now.getTime()) &&
      m.verifiedDomains.includes(input.fromDomain),
  );
}

/** Orders eligible members by the pool's strategy. */
export function orderMembers(
  members: readonly PoolMember[],
  strategy: PoolStrategy,
  cursor: number,
): PoolMember[] {
  const list = [...members];

  switch (strategy) {
    case 'round_robin': {
      if (list.length === 0) return list;
      // Rotate rather than sort, so every member is tried each pass and the
      // starting point moves. Sorting by a cursor would starve the tail.
      const offset = ((cursor % list.length) + list.length) % list.length;
      return [...list.slice(offset), ...list.slice(0, offset)];
    }

    case 'failover':
      // Lowest priority number first, and stable within a priority, so a
      // two-sender failover pool is genuinely primary-then-secondary.
      return list.sort((a, b) => a.priority - b.priority);

    case 'least_loaded':
      return list.sort((a, b) => b.tokensRemaining - a.tokensRemaining);

    case 'weighted':
    default:
      // Health is part of the weight rather than a separate filter, so a
      // degraded sender takes proportionally less traffic before it crosses
      // MIN_HEALTH and drops out entirely.
      return list.sort(
        (a, b) => b.weight * (b.healthScore / 100) - a.weight * (a.healthScore / 100),
      );
  }
}

/** True when two or more members draw on the same provider account. */
export function sharedConnections(members: readonly PoolMember[]): string[] {
  const seen = new Map<string, number>();
  for (const m of members) {
    seen.set(m.providerConnectionId, (seen.get(m.providerConnectionId) ?? 0) + 1);
  }

  return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

/**
 * Chooses a sender for a batch.
 *
 * Returns a lease, a deferral with how long to wait, or `no_sender` — which
 * the caller turns into `held`, never into a failed campaign.
 */
export async function selectSender(
  input: {
    poolId: string;
    members: readonly PoolMember[];
    strategy: PoolStrategy;
    batchSize: number;
    fromDomain: string;
    now: Date;
    concurrencyLimit: number;
  },
  port: RoutingPort,
): Promise<SenderSelection> {
  const eligible = eligibleMembers(input.members, {
    fromDomain: input.fromDomain,
    now: input.now,
  });

  if (eligible.length === 0) {
    return {
      kind: 'no_sender',
      reason:
        input.members.length === 0
          ? 'This pool has no senders'
          : 'No sender in this pool is currently healthy and verified for this domain',
    };
  }

  const shared = new Set(sharedConnections(eligible));
  const cursor = input.strategy === 'round_robin' ? await port.nextCursor(input.poolId) : 0;
  const ordered = orderMembers(eligible, input.strategy, cursor);

  let soonestRefill = Number.POSITIVE_INFINITY;
  let blockedBy = 'unknown';

  for (const member of ordered) {
    const keys = bucketKeysFor(member);
    const grant = await port.consume({ keys, count: input.batchSize });

    if (!grant.ok) {
      if (grant.refillMs !== undefined && grant.refillMs < soonestRefill) {
        soonestRefill = grant.refillMs;
        blockedBy = grant.blockedBy ?? 'unknown';
      }
      continue;
    }

    const slot = await port.acquireSlot({
      senderAccountId: member.senderAccountId,
      limit: input.concurrencyLimit,
    });

    if (!slot) {
      // Give the tokens back. Keeping them would let a concurrency squeeze
      // silently consume a sender's whole hourly quota.
      await port.refund({ keys, count: input.batchSize });
      continue;
    }

    return {
      kind: 'lease',
      senderAccountId: member.senderAccountId,
      providerConnectionId: member.providerConnectionId,
      sharesBucket: shared.has(member.providerConnectionId),
    };
  }

  return {
    kind: 'defer',
    retryAfterMs: Math.min(
      Number.isFinite(soonestRefill) ? soonestRefill : MAX_DEFER_MS,
      MAX_DEFER_MS,
    ),
    blockedBy,
  };
}

/**
 * Whether a failed send may be retried on a different sender in this pool.
 *
 * The distinction that keeps routing honest. A provider being down is not the
 * account's fault and failing over is the point of a pool. A quota being
 * exhausted *is* about the account, and moving the message to a sibling is
 * the evasion that bucket-keying exists to prevent — reintroduced one layer
 * up, where it would be much harder to see.
 */
export function mayFailOver(errorKind: string): boolean {
  return FAILOVER_KINDS.has(errorKind);
}

const FAILOVER_KINDS: ReadonlySet<string> = new Set([
  // The provider is unreachable or broken. Another account, very likely on
  // another provider, is exactly the right answer.
  'provider_unavailable',
  // These are about this connection's credentials or identity, not about how
  // much it has sent. A sibling is unaffected.
  'auth_failed',
  'invalid_sender',
]);
