import type { EligibleSender, PoolStrategy } from '../../api/pools.js';

/**
 * The combined-headroom arithmetic behind H1b, isolated so it can be read and
 * tested on its own.
 *
 * One rule decides all of it, and it is the reason the panel exists:
 *
 *   A quota belongs to a provider connection, not to a sender.
 *
 * So two senders on the same SES account are counted **once**. Adding the
 * second does not raise the ceiling, and a UI that summed per sender would
 * tell a customer they had twice the capacity they have — which they would
 * discover at the worst moment, mid-send, as a throttle.
 *
 * The rate limiter enforces exactly this by keying its buckets on
 * `provider_connection_id` (docs/07, `packages/db/repositories/pools.ts`).
 * This is the browser's copy of that rule, and it must not drift from it.
 */

export interface ConnectionShare {
  id: string;
  /** "Amazon SES · eu-west-1". */
  label: string;
  /** How many of the selected senders draw on this connection. */
  senderCount: number;
  remaining: number;
  perSecond: number;
}

export interface CombinedHeadroom {
  connections: ConnectionShare[];
  /** Emails left today across the distinct connections. */
  remaining: number;
  /**
   * Emails per second. Round-robin alternates, so the speeds of connections
   * add up; failover sends through one member at a time, so the pool is only
   * ever as fast as the connection currently carrying it.
   */
  perSecond: number;
  /** At least one connection is shared by two or more selected senders. */
  shared: boolean;
}

export function combineHeadroom(
  senders: readonly EligibleSender[],
  strategy: PoolStrategy,
): CombinedHeadroom {
  const connections: ConnectionShare[] = [];
  const index = new Map<string, ConnectionShare>();

  for (const sender of senders) {
    const seen = index.get(sender.providerConnectionId);

    if (seen === undefined) {
      const share: ConnectionShare = {
        id: sender.providerConnectionId,
        label: sender.connectionLabel,
        senderCount: 1,
        remaining: sender.remainingToday,
        perSecond: sender.perSecond,
      };
      index.set(share.id, share);
      connections.push(share);
    } else {
      seen.senderCount += 1;
    }
  }

  const remaining = connections.reduce((total, share) => total + share.remaining, 0);
  const perSecond =
    strategy === 'round_robin'
      ? connections.reduce((total, share) => total + share.perSecond, 0)
      : connections.reduce((fastest, share) => Math.max(fastest, share.perSecond), 0);

  return {
    connections,
    remaining,
    perSecond,
    shared: connections.some((share) => share.senderCount > 1),
  };
}

/** The line to the right of "Combined headroom", verbatim from H1b. */
export function strategyNote(strategy: PoolStrategy): string {
  return strategy === 'round_robin'
    ? 'round-robin · speeds add up across connections'
    : 'failover · speed of the active member';
}

/**
 * The warning under the panel.
 *
 * Two sentences, and which one shows is the whole point: the general one
 * says a pool never raises a limit, and the specific one names the mistake
 * the customer has just made.
 */
export function guardrail(shared: boolean): string {
  return shared
    ? 'Two selected senders share one provider connection, so they share its quota. Adding both does not double headroom; the connection is counted once above.'
    : 'Pools do not raise provider limits. Each connection is counted once; to get more headroom, connect another provider account.';
}

/** "shared by 1 sender" / "shared by 2 senders". */
export function sharedBy(count: number): string {
  return `shared by ${count} ${count === 1 ? 'sender' : 'senders'}`;
}

/**
 * H1a's "Used by" cell: the first two campaign names, then a count.
 *
 * "Autumn Escapes, F1 early access, +1" — the design's own truncation, which
 * keeps the cell one line without an ellipsis that hides how many there are.
 */
export function usedByLabel(names: readonly string[] | undefined): string {
  if (names === undefined || names.length === 0) return '—';

  const shown = names.slice(0, 2).join(', ');
  const rest = names.length - 2;
  return rest > 0 ? `${shown}, +${rest}` : shown;
}

/**
 * The bar turns amber below a quarter left, as H1a draws it on the newsletter
 * pool. A pool at 17% of its day is a pool that will stop mid-campaign.
 */
export const LOW_HEADROOM = 0.25;

export function headroomLow(remaining: number, total: number): boolean {
  return total > 0 && remaining / total < LOW_HEADROOM;
}
