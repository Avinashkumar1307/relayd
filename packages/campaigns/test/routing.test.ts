import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DEFER_MS,
  MIN_HEALTH,
  bucketKeysFor,
  eligibleMembers,
  mayFailOver,
  orderMembers,
  selectSender,
  sharedConnections,
  type PoolMember,
  type RoutingPort,
} from '../src/engine/routing.js';

/**
 * Pool routing (docs/07 §10).
 *
 * The thing this has to get right is not load balancing. It is that a pool
 * must never become a way to exceed what one provider account permits — "add
 * the same SES account three times to triple the quota". Most of this file is
 * about that one property, approached from the three directions it can be
 * broken from: the bucket key, the failover rule, and the refund path.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');

function member(overrides: Partial<PoolMember> = {}): PoolMember {
  return {
    senderAccountId: 'sa-1',
    providerConnectionId: 'conn-1',
    enabled: true,
    status: 'active',
    healthScore: 100,
    cooldownUntil: null,
    verifiedDomains: ['example.com'],
    priority: 1,
    weight: 1,
    tokensRemaining: 1000,
    ...overrides,
  };
}

function port(overrides: Partial<RoutingPort> = {}) {
  const consumed: { keys: readonly string[]; count: number }[] = [];
  const refunded: { keys: readonly string[]; count: number }[] = [];
  let cursor = 0;

  const base: RoutingPort = {
    async consume(input) {
      consumed.push(input);
      return { ok: true };
    },
    async refund(input) {
      refunded.push(input);
    },
    async acquireSlot() {
      return true;
    },
    async releaseSlot() {
      /* nothing */
    },
    async nextCursor() {
      return cursor++;
    },
  };

  return { port: { ...base, ...overrides }, consumed, refunded };
}

const base = {
  poolId: 'p1',
  strategy: 'round_robin' as const,
  batchSize: 10,
  fromDomain: 'example.com',
  now: NOW,
  concurrencyLimit: 5,
};

describe('the bucket key is the guardrail', () => {
  it('scopes the first two buckets to the connection, not the sender', () => {
    // This single choice is what stops a pool exceeding one account's quota.
    // Key these by sender and you have built a quota-evasion tool.
    const keys = bucketKeysFor({ providerConnectionId: 'conn-9', senderAccountId: 'sa-9' });

    expect(keys[0]).toBe('rl:conn-9:hour');
    expect(keys[1]).toBe('rl:conn-9:day');
  });

  it('still keeps a per-sender bucket for the operator’s own limit', () => {
    const keys = bucketKeysFor({ providerConnectionId: 'conn-9', senderAccountId: 'sa-9' });

    expect(keys).toContain('rl:sa-9:hour');
    expect(keys).toContain('rl:sa-9:day');
  });

  it('gives two senders on one account the same connection buckets', () => {
    // The "add the same SES account three times" case, stated directly.
    const a = bucketKeysFor({ providerConnectionId: 'conn-1', senderAccountId: 'sa-1' });
    const b = bucketKeysFor({ providerConnectionId: 'conn-1', senderAccountId: 'sa-2' });

    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(b[1]);
    expect(a[2]).not.toBe(b[2]);
  });

  it('consumes across every bucket in one call, never one at a time', async () => {
    // Four sequential consumes is four chances to grant half a batch and then
    // refuse, leaving tokens spent on a send that never happens.
    const { port: p, consumed } = port();

    await selectSender({ ...base, members: [member()] }, p);

    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.keys).toHaveLength(4);
    expect(consumed[0]?.count).toBe(10);
  });

  it('names the pool members that share an account', () => {
    const shared = sharedConnections([
      member({ senderAccountId: 'sa-1', providerConnectionId: 'conn-1' }),
      member({ senderAccountId: 'sa-2', providerConnectionId: 'conn-1' }),
      member({ senderAccountId: 'sa-3', providerConnectionId: 'conn-2' }),
    ]);

    expect(shared).toEqual(['conn-1']);
  });

  it('flags the lease when the chosen sender shares a bucket', async () => {
    // So the UI can show the warning docs/07 requires rather than letting a
    // customer believe they have doubled their capacity.
    const { port: p } = port();

    const result = await selectSender(
      {
        ...base,
        members: [
          member({ senderAccountId: 'sa-1', providerConnectionId: 'conn-1' }),
          member({ senderAccountId: 'sa-2', providerConnectionId: 'conn-1' }),
        ],
      },
      p,
    );

    expect(result).toMatchObject({ kind: 'lease', sharesBucket: true });
  });

  it('does not flag a pool of genuinely separate accounts', async () => {
    const { port: p } = port();

    const result = await selectSender(
      {
        ...base,
        members: [
          member({ senderAccountId: 'sa-1', providerConnectionId: 'conn-1' }),
          member({ senderAccountId: 'sa-2', providerConnectionId: 'conn-2' }),
        ],
      },
      p,
    );

    expect(result).toMatchObject({ sharesBucket: false });
  });
});

describe('which senders are eligible', () => {
  it('skips a disabled member', () => {
    expect(eligibleMembers([member({ enabled: false })], { fromDomain: 'example.com', now: NOW })).toEqual(
      [],
    );
  });

  it('skips anything not active', () => {
    for (const status of ['cooling_down', 'paused', 'disabled'] as const) {
      expect(
        eligibleMembers([member({ status })], { fromDomain: 'example.com', now: NOW }),
        status,
      ).toEqual([]);
    }
  });

  it('skips a sender below the health floor', () => {
    expect(
      eligibleMembers([member({ healthScore: MIN_HEALTH - 1 })], {
        fromDomain: 'example.com',
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('keeps one exactly at the floor', () => {
    expect(
      eligibleMembers([member({ healthScore: MIN_HEALTH })], {
        fromDomain: 'example.com',
        now: NOW,
      }),
    ).toHaveLength(1);
  });

  it('skips a sender still cooling down', () => {
    const cooldownUntil = new Date(NOW.getTime() + 60_000);
    expect(
      eligibleMembers([member({ cooldownUntil })], { fromDomain: 'example.com', now: NOW }),
    ).toEqual([]);
  });

  it('keeps one whose cooldown has expired', () => {
    const cooldownUntil = new Date(NOW.getTime() - 1);
    expect(
      eligibleMembers([member({ cooldownUntil })], { fromDomain: 'example.com', now: NOW }),
    ).toHaveLength(1);
  });

  it('skips a sender not verified for the From domain', () => {
    // Sending from an unverified domain is how a provider account gets
    // suspended, and the verification can lapse without anyone touching us.
    expect(
      eligibleMembers([member({ verifiedDomains: ['other.com'] })], {
        fromDomain: 'example.com',
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('matches the domain exactly rather than by suffix', () => {
    // `notexample.com` must not satisfy `example.com`.
    expect(
      eligibleMembers([member({ verifiedDomains: ['notexample.com'] })], {
        fromDomain: 'example.com',
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe('ordering by strategy', () => {
  const three = [
    member({ senderAccountId: 'a', priority: 3, weight: 1, tokensRemaining: 10, healthScore: 100 }),
    member({ senderAccountId: 'b', priority: 1, weight: 5, tokensRemaining: 90, healthScore: 100 }),
    member({ senderAccountId: 'c', priority: 2, weight: 3, tokensRemaining: 50, healthScore: 100 }),
  ];

  it('rotates for round robin rather than sorting', () => {
    // Sorting by a cursor starves the tail; rotating tries every member each
    // pass and moves the starting point.
    expect(orderMembers(three, 'round_robin', 0).map((m) => m.senderAccountId)).toEqual(['a', 'b', 'c']);
    expect(orderMembers(three, 'round_robin', 1).map((m) => m.senderAccountId)).toEqual(['b', 'c', 'a']);
    expect(orderMembers(three, 'round_robin', 2).map((m) => m.senderAccountId)).toEqual(['c', 'a', 'b']);
  });

  it('wraps the round-robin cursor', () => {
    expect(orderMembers(three, 'round_robin', 3).map((m) => m.senderAccountId)).toEqual(['a', 'b', 'c']);
    expect(orderMembers(three, 'round_robin', 7).map((m) => m.senderAccountId)).toEqual(['b', 'c', 'a']);
  });

  it('wraps a negative cursor the same way as a positive one', () => {
    // `nextCursor` is monotonic, so a negative only arrives via an overflow or
    // a reset — but the rotation must still be a rotation rather than a
    // truncation. Asserted as exact orders: `Array.slice` happens to wrap
    // negative indices identically, so the explicit normalisation in the
    // source is belt-and-braces, and what matters is the contract below.
    expect(orderMembers(three, 'round_robin', -1).map((m) => m.senderAccountId)).toEqual(['c', 'a', 'b']);
    expect(orderMembers(three, 'round_robin', -3).map((m) => m.senderAccountId)).toEqual(['a', 'b', 'c']);
    expect(orderMembers(three, 'round_robin', -5).map((m) => m.senderAccountId)).toEqual(['b', 'c', 'a']);
  });

  it('keeps every member exactly once however it rotates', () => {
    // A rotation that drops or duplicates a member silently halves a pool's
    // capacity or doubles one account's share of it.
    for (const cursor of [-5, -1, 0, 1, 2, 3, 97]) {
      const ids = orderMembers(three, 'round_robin', cursor).map((m) => m.senderAccountId).sort();
      expect(ids, String(cursor)).toEqual(['a', 'b', 'c']);
    }
  });

  it('puts the lowest priority number first for failover', () => {
    expect(orderMembers(three, 'failover', 0).map((m) => m.senderAccountId)).toEqual(['b', 'c', 'a']);
  });

  it('puts the most tokens first for least loaded', () => {
    expect(orderMembers(three, 'least_loaded', 0).map((m) => m.senderAccountId)).toEqual(['b', 'c', 'a']);
  });

  it('weights by health as well as by weight', () => {
    // A degraded sender takes proportionally less traffic before it crosses
    // the floor and drops out entirely.
    const degraded = [
      member({ senderAccountId: 'strong', weight: 2, healthScore: 50 }),
      member({ senderAccountId: 'healthy', weight: 1, healthScore: 100 }),
    ];

    expect(orderMembers(degraded, 'weighted', 0).map((m) => m.senderAccountId)).toEqual([
      'strong',
      'healthy',
    ]);

    const sicker = [
      member({ senderAccountId: 'strong', weight: 2, healthScore: 45 }),
      member({ senderAccountId: 'healthy', weight: 1, healthScore: 100 }),
    ];

    expect(orderMembers(sicker, 'weighted', 0).map((m) => m.senderAccountId)).toEqual([
      'healthy',
      'strong',
    ]);
  });

  it('does not mutate the list it was given', () => {
    const list = [...three];
    orderMembers(list, 'failover', 0);
    expect(list.map((m) => m.senderAccountId)).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty pool without throwing', () => {
    expect(orderMembers([], 'round_robin', 0)).toEqual([]);
  });
});

describe('when nothing can send', () => {
  it('reports no_sender for an empty pool', async () => {
    const result = await selectSender({ ...base, members: [] }, port().port);
    expect(result).toMatchObject({ kind: 'no_sender' });
    expect(result.kind === 'no_sender' && result.reason).toContain('no senders');
  });

  it('reports no_sender when every member is unhealthy', async () => {
    const { port: p } = port();

    const result = await selectSender(
      { ...base, members: [member({ healthScore: 10 }), member({ status: 'paused' })] },
      p,
    );

    expect(result.kind).toBe('no_sender');
    expect(result.kind === 'no_sender' && result.reason).toContain('healthy');
  });

  it('never consumes a token when there is no eligible sender', async () => {
    const consume = vi.fn(async () => ({ ok: true }));
    const { port: p } = port({ consume });

    await selectSender({ ...base, members: [member({ enabled: false })] }, p);

    expect(consume).not.toHaveBeenCalled();
  });
});

describe('when every sender is rate limited', () => {
  it('defers with the soonest refill rather than failing', async () => {
    const { port: p } = port({
      async consume() {
        return { ok: false, refillMs: 12_000, blockedBy: 'rl:conn-1:hour' };
      },
    });

    const result = await selectSender({ ...base, members: [member()] }, p);

    expect(result).toMatchObject({ kind: 'defer', retryAfterMs: 12_000 });
  });

  it('takes the soonest refill across all candidates', async () => {
    const refills = [30_000, 5_000, 20_000];
    let call = 0;
    const { port: p } = port({
      async consume() {
        return { ok: false, refillMs: refills[call++] ?? MAX_DEFER_MS, blockedBy: 'b' };
      },
    });

    const result = await selectSender(
      {
        ...base,
        members: [
          member({ senderAccountId: 'a' }),
          member({ senderAccountId: 'b' }),
          member({ senderAccountId: 'c' }),
        ],
      },
      p,
    );

    expect(result).toMatchObject({ retryAfterMs: 5_000 });
  });

  it('caps the deferral so a campaign keeps checking back', async () => {
    const { port: p } = port({
      async consume() {
        return { ok: false, refillMs: 6 * 60 * 60_000, blockedBy: 'b' };
      },
    });

    expect(await selectSender({ ...base, members: [member()] }, p)).toMatchObject({
      retryAfterMs: MAX_DEFER_MS,
    });
  });

  it('defers by the cap when no bucket said when', async () => {
    const { port: p } = port({
      async consume() {
        return { ok: false };
      },
    });

    expect(await selectSender({ ...base, members: [member()] }, p)).toMatchObject({
      kind: 'defer',
      retryAfterMs: MAX_DEFER_MS,
    });
  });

  it('names the bucket that refused', async () => {
    const { port: p } = port({
      async consume() {
        return { ok: false, refillMs: 1_000, blockedBy: 'rl:conn-7:day' };
      },
    });

    expect(await selectSender({ ...base, members: [member()] }, p)).toMatchObject({
      blockedBy: 'rl:conn-7:day',
    });
  });

  it('tries the next candidate before giving up', async () => {
    let call = 0;
    const { port: p } = port({
      async consume() {
        call += 1;
        return call === 1 ? { ok: false, refillMs: 1000 } : { ok: true };
      },
    });

    const result = await selectSender(
      { ...base, members: [member({ senderAccountId: 'a' }), member({ senderAccountId: 'b' })] },
      p,
    );

    expect(result).toMatchObject({ kind: 'lease', senderAccountId: 'b' });
  });
});

describe('the concurrency slot', () => {
  it('refunds the tokens when no slot is free', async () => {
    // Keeping them would let a concurrency squeeze silently drain a sender's
    // whole hourly quota without sending anything.
    const { port: p, refunded } = port({
      async acquireSlot() {
        return false;
      },
    });

    await selectSender({ ...base, members: [member()] }, p);

    expect(refunded).toHaveLength(1);
    expect(refunded[0]?.count).toBe(10);
  });

  it('refunds exactly the buckets it consumed', async () => {
    const { port: p, consumed, refunded } = port({
      async acquireSlot() {
        return false;
      },
    });

    await selectSender({ ...base, members: [member()] }, p);

    expect(refunded[0]?.keys).toEqual(consumed[0]?.keys);
  });

  it('moves on to the next sender after a refund', async () => {
    let slots = 0;
    const { port: p } = port({
      async acquireSlot() {
        slots += 1;
        return slots > 1;
      },
    });

    const result = await selectSender(
      { ...base, members: [member({ senderAccountId: 'a' }), member({ senderAccountId: 'b' })] },
      p,
    );

    expect(result).toMatchObject({ kind: 'lease', senderAccountId: 'b' });
  });

  it('does not refund when the lease succeeds', async () => {
    const { port: p, refunded } = port();
    await selectSender({ ...base, members: [member()] }, p);
    expect(refunded).toEqual([]);
  });
});

describe('what may fail over to a sibling sender', () => {
  it('fails over when the provider is unavailable', () => {
    // Not the account's fault, and failing over is the point of a pool.
    expect(mayFailOver('provider_unavailable')).toBe(true);
  });

  it('fails over on a credential or identity problem', () => {
    expect(mayFailOver('auth_failed')).toBe(true);
    expect(mayFailOver('invalid_sender')).toBe(true);
  });

  it('never fails over on an exhausted quota', () => {
    // This is the whole argument. Rerouting on quota is exactly the evasion
    // that keying buckets by connection prevents, reintroduced one layer up
    // where it is much harder to see.
    expect(mayFailOver('quota_exceeded')).toBe(false);
  });

  it('never fails over on a rate limit', () => {
    // Same reason. Retry after the reset; do not go looking for a sibling.
    expect(mayFailOver('rate_limited')).toBe(false);
  });

  it('never fails over on a per-message failure', () => {
    // A bad address or rejected content will be just as bad on another
    // sender, and trying is five times the provider reputation damage.
    for (const kind of ['invalid_recipient', 'content_rejected', 'message_too_large']) {
      expect(mayFailOver(kind), kind).toBe(false);
    }
  });

  it('never fails over on an ambiguous timeout', () => {
    // The message may have been accepted. Sending it again on another sender
    // is the duplicate R31 exists to prevent.
    expect(mayFailOver('timeout')).toBe(false);
  });

  it('does not fail over on a kind it does not recognise', () => {
    expect(mayFailOver('something_new')).toBe(false);
    expect(mayFailOver('')).toBe(false);
  });
});

describe('the round-robin cursor', () => {
  it('is read once per selection, not per candidate', async () => {
    const nextCursor = vi.fn(async () => 0);
    const { port: p } = port({ nextCursor });

    await selectSender(
      { ...base, members: [member({ senderAccountId: 'a' }), member({ senderAccountId: 'b' })] },
      p,
    );

    expect(nextCursor).toHaveBeenCalledOnce();
  });

  it('is not read at all for the other strategies', async () => {
    const nextCursor = vi.fn(async () => 0);
    const { port: p } = port({ nextCursor });

    await selectSender({ ...base, strategy: 'failover', members: [member()] }, p);

    expect(nextCursor).not.toHaveBeenCalled();
  });
});
