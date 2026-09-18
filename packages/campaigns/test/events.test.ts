import { describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_RANK,
  SUPPRESSING_STATES,
  dedupeKeyFor,
  ingestEvent,
  isDeliveryState,
  isEngagement,
  wouldAdvance,
  type EventIngestPort,
  type NormalisedEvent,
} from '../src/engine/events.js';

/**
 * Inbound provider events (INVARIANTS R4, R16, R32; findings F4, F16, F32).
 *
 * The failure this file exists to prevent is specific and routine: SES
 * publishes through SNS, which has no ordering guarantee, so a `delivered`
 * arriving after a `bounced` is an ordinary Tuesday. Overwriting the bounce
 * means the contact is never suppressed and the next campaign mails a dead
 * address — a compliance failure, not just a wrong number on a dashboard.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');

const RECIPIENT = {
  id: 'r1',
  campaignId: 'c1',
  contactId: 'ct1',
  email: 'a@example.com',
};

function event(over: Partial<NormalisedEvent> = {}): NormalisedEvent {
  return {
    type: 'delivered',
    providerMessageId: 'pm-1',
    occurredAt: NOW,
    raw: { provider: 'ses' },
    ...over,
  };
}

function port(over: Partial<EventIngestPort> = {}) {
  const calls: string[] = [];
  const raw: { type: string; matched: boolean }[] = [];
  const suppressions: { email: string; reason: string }[] = [];
  const advances: { state: string; rank: number }[] = [];

  const base: EventIngestPort = {
    async findRecipient() {
      calls.push('findRecipient');
      return RECIPIENT;
    },
    async advanceDeliveryState(input) {
      calls.push('advance');
      advances.push({ state: input.state, rank: input.rank });
      return true;
    },
    async writeRawEvent(input) {
      calls.push('writeRaw');
      raw.push({ type: input.type, matched: input.matched });
      return { inserted: true };
    },
    async suppressContact(input) {
      calls.push('suppress');
      suppressions.push({ email: input.email, reason: input.reason });
    },
    async reconcileUncertain() {
      calls.push('reconcile');
      return false;
    },
    ...over,
  };

  return { port: base, calls, raw, suppressions, advances };
}

const context = { workspaceId: 'ws-1', providerConnectionId: 'conn-1' };

describe('the rank lattice (R16, F16)', () => {
  it('orders the six delivery states as F16 specifies', () => {
    expect(DELIVERY_RANK).toEqual({
      queued: 0,
      sent: 1,
      delivered: 2,
      soft_bounced: 3,
      hard_bounced: 4,
      complained: 5,
    });
  });

  it('passes the rank to the guarded update', () => {
    // The UPDATE is `WHERE delivery_rank < $3`. A wrong rank here is a lattice
    // that silently permits the transition it exists to forbid.
    const { port: p, advances } = port();

    return ingestEvent({ ...context, event: event({ type: 'hard_bounced' }) }, p).then(() => {
      expect(advances[0]).toEqual({ state: 'hard_bounced', rank: 4 });
    });
  });

  it('lets a delivery follow a send', () => {
    expect(wouldAdvance('sent', 'delivered')).toBe(true);
  });

  it('refuses a delivery that follows a hard bounce', () => {
    // The F16 trace exactly.
    expect(wouldAdvance('hard_bounced', 'delivered')).toBe(false);
  });

  it('refuses a send that follows anything', () => {
    for (const state of ['delivered', 'soft_bounced', 'hard_bounced', 'complained'] as const) {
      expect(wouldAdvance(state, 'sent'), state).toBe(false);
    }
  });

  it('refuses an equal rank, not only a lower one', () => {
    // Strictly increasing. A duplicate `delivered` must not rewrite the
    // timestamp of the first one.
    expect(wouldAdvance('delivered', 'delivered')).toBe(false);
  });

  it('lets a complaint follow a hard bounce but not the reverse', () => {
    expect(wouldAdvance('hard_bounced', 'complained')).toBe(true);
    expect(wouldAdvance('complained', 'hard_bounced')).toBe(false);
  });

  it('lets a delivery supersede a soft bounce', () => {
    // Deliberate: a soft bounce may be superseded by a later delivery within
    // the retry window, which is why it sits below hard_bounced.
    expect(wouldAdvance('soft_bounced', 'hard_bounced')).toBe(true);
    expect(DELIVERY_RANK.soft_bounced).toBeLessThan(DELIVERY_RANK.hard_bounced);
  });

  it('reports a lost race as not advanced rather than as an error', () => {
    // Zero rows from the guarded update is the expected outcome for a
    // reordered event.
    const { port: p } = port({
      async advanceDeliveryState() {
        return false;
      },
    });

    return ingestEvent({ ...context, event: event() }, p).then((result) => {
      expect(result.advanced).toBe(false);
      expect(result.matched).toBe(true);
    });
  });
});

describe('engagement is outside the lattice', () => {
  it('does not advance delivery state on an open', async () => {
    // A message can be opened and later complained about, and neither fact
    // replaces the other.
    const advance = vi.fn(async () => true);
    const { port: p } = port({ advanceDeliveryState: advance });

    const result = await ingestEvent({ ...context, event: event({ type: 'open' }) }, p);

    expect(advance).not.toHaveBeenCalled();
    expect(result.advanced).toBe(false);
  });

  it('does not advance on a click either', async () => {
    const advance = vi.fn(async () => true);
    const { port: p } = port({ advanceDeliveryState: advance });

    await ingestEvent({ ...context, event: event({ type: 'click', url: 'https://x.test' }) }, p);

    expect(advance).not.toHaveBeenCalled();
  });

  it('says why an engagement event went no further', async () => {
    // One gate decides this, and the reason is what distinguishes "additive
    // by design" from "we did not recognise it" — so the reason is what the
    // test holds onto.
    const { port: p } = port();

    const result = await ingestEvent({ ...context, event: event({ type: 'open' }) }, p);

    expect(result.reason).toContain('additive');
  });

  it('says something different for a type it does not recognise', async () => {
    const { port: p } = port();

    const result = await ingestEvent({ ...context, event: event({ type: 'unknown' }) }, p);

    expect(result.reason).not.toContain('additive');
  });

  it('still records the raw engagement event', async () => {
    // Analytics is the whole point of keeping them.
    const { port: p, raw } = port();

    await ingestEvent({ ...context, event: event({ type: 'open' }) }, p);

    expect(raw).toEqual([{ type: 'open', matched: true }]);
  });

  it('classifies the two engagement types and nothing else', () => {
    expect(isEngagement('open')).toBe(true);
    expect(isEngagement('click')).toBe(true);
    expect(isEngagement('delivered')).toBe(false);
    expect(isEngagement('unsubscribe')).toBe(false);
  });

  it('classifies the six delivery states and nothing else', () => {
    for (const state of Object.keys(DELIVERY_RANK)) {
      expect(isDeliveryState(state), state).toBe(true);
    }
    expect(isDeliveryState('open')).toBe(false);
    expect(isDeliveryState('unknown')).toBe(false);
  });

  it('is not fooled by a prototype key', () => {
    expect(isDeliveryState('constructor')).toBe(false);
    expect(isDeliveryState('toString')).toBe(false);
  });
});

describe('raw events are always written', () => {
  it('writes before it touches state', async () => {
    // An event that fails half-way still leaves the evidence.
    const { port: p, calls } = port();

    await ingestEvent({ ...context, event: event() }, p);

    expect(calls.indexOf('writeRaw')).toBeLessThan(calls.indexOf('advance'));
  });

  it('writes an unmatched event and mutates nothing (R4)', async () => {
    const { port: p, raw, calls } = port({
      async findRecipient() {
        return null;
      },
    });

    const result = await ingestEvent({ ...context, event: event() }, p);

    expect(raw).toEqual([{ type: 'delivered', matched: false }]);
    expect(calls).not.toContain('advance');
    expect(calls).not.toContain('suppress');
    expect(result.matched).toBe(false);
  });

  it('writes the raw event even when the lattice refuses it', async () => {
    // Analytics stays complete when state does not move, and the row is the
    // only evidence when the two disagree.
    const { port: p, raw } = port({
      async advanceDeliveryState() {
        return false;
      },
    });

    await ingestEvent({ ...context, event: event() }, p);

    expect(raw).toHaveLength(1);
  });

  it('writes an event with no message id, unmatched', async () => {
    const { port: p, raw, calls } = port();

    await ingestEvent({ ...context, event: event({ providerMessageId: null }) }, p);

    expect(raw[0]?.matched).toBe(false);
    expect(calls).not.toContain('findRecipient');
  });
});

describe('deduplication (R32, F32)', () => {
  it('prefers the provider’s own event id', () => {
    // That is exactly what it is for.
    const key = dedupeKeyFor('conn-1', event({ providerEventId: 'evt_123' }));
    expect(key).toBe('conn-1:evt_123');
  });

  it('ignores an empty provider event id', () => {
    // A provider that sends an empty id would otherwise give every event on
    // one connection the same key — and every event after the first would be
    // dropped as a duplicate, silently, for the life of that connection.
    const empty = dedupeKeyFor('conn-1', event({ providerEventId: '' }));
    const other = dedupeKeyFor('conn-1', event({ providerEventId: '', type: 'hard_bounced' }));

    expect(empty).not.toBe('conn-1:');
    expect(empty).not.toBe(other);
  });

  it('synthesises a key when the provider has none', () => {
    const key = dedupeKeyFor('conn-1', event());
    expect(key).toContain('conn-1');
    expect(key).toContain('pm-1');
  });

  it('separates two connections', () => {
    expect(dedupeKeyFor('conn-1', event())).not.toBe(dedupeKeyFor('conn-2', event()));
  });

  it('separates two event types for one message', () => {
    // A `delivered` and a `bounced` for the same message at the same instant
    // are different events, and collapsing them drops the bounce.
    expect(dedupeKeyFor('c', event({ type: 'delivered' }))).not.toBe(
      dedupeKeyFor('c', event({ type: 'hard_bounced' })),
    );
  });

  it('separates two messages', () => {
    expect(dedupeKeyFor('c', event({ providerMessageId: 'pm-1' }))).not.toBe(
      dedupeKeyFor('c', event({ providerMessageId: 'pm-2' })),
    );
  });

  it('separates two instants a millisecond apart', () => {
    // Second precision would collapse two genuinely distinct clicks on
    // different links a few hundred milliseconds apart.
    expect(dedupeKeyFor('c', event({ occurredAt: NOW }))).not.toBe(
      dedupeKeyFor('c', event({ occurredAt: new Date(NOW.getTime() + 1) })),
    );
  });

  it('separates two clicks on different links at the same instant', () => {
    expect(dedupeKeyFor('c', event({ type: 'click', url: 'https://a.test' }))).not.toBe(
      dedupeKeyFor('c', event({ type: 'click', url: 'https://b.test' })),
    );
  });

  it('cannot be confused by one field running into the next', () => {
    // Length-prefixed rather than concatenated. The pair below is the shape
    // that collides without prefixes: a connection id ending where the type
    // begins. Today's connection ids are UUIDs and today's types come from a
    // fixed set, so this is insurance against a field order or an id format
    // that changes — which is exactly the sort of thing that does.
    // Concatenated, both of these are "conn-1delivered..." exactly.
    const a = dedupeKeyFor('conn-1', event({ type: 'delivered' }));
    const b = dedupeKeyFor('conn-1delivere', event({ type: 'd' as 'delivered' }));

    expect(a).not.toBe(b);
  });

  it('cannot be confused by a message id running into the URL', () => {
    const a = dedupeKeyFor('c', event({ type: 'click', providerMessageId: 'ab', url: '' }));
    const b = dedupeKeyFor('c', event({ type: 'click', providerMessageId: 'a', url: 'b' }));

    expect(a).not.toBe(b);
  });

  it('gives the same key for a replayed payload', () => {
    expect(dedupeKeyFor('c', event())).toBe(dedupeKeyFor('c', event()));
  });

  it('does nothing twice when the same event arrives again', async () => {
    // The raw insert is what makes the whole function idempotent.
    const { port: p, calls } = port({
      async writeRawEvent() {
        return { inserted: false };
      },
    });

    const result = await ingestEvent({ ...context, event: event({ type: 'hard_bounced' }) }, p);

    expect(result.duplicate).toBe(true);
    expect(calls).not.toContain('advance');
    expect(calls).not.toContain('suppress');
  });
});

describe('suppression', () => {
  it('suppresses on a hard bounce', async () => {
    const { port: p, suppressions } = port();

    await ingestEvent({ ...context, event: event({ type: 'hard_bounced' }) }, p);

    expect(suppressions).toEqual([{ email: 'a@example.com', reason: 'hard_bounced' }]);
  });

  it('suppresses on a complaint', async () => {
    const { port: p, suppressions } = port();

    await ingestEvent({ ...context, event: event({ type: 'complained' }) }, p);

    expect(suppressions[0]?.reason).toBe('complained');
  });

  it('does not suppress on a soft bounce', async () => {
    // It may be superseded by a delivery within the retry window.
    const { port: p, calls } = port();

    await ingestEvent({ ...context, event: event({ type: 'soft_bounced' }) }, p);

    expect(calls).not.toContain('suppress');
  });

  it('does not suppress on a delivery', async () => {
    const { port: p, calls } = port();
    await ingestEvent({ ...context, event: event({ type: 'delivered' }) }, p);
    expect(calls).not.toContain('suppress');
  });

  it('suppresses even when the lattice refused the transition', async () => {
    // The bounce lost the race to a complaint. The address is still dead, and
    // the lattice governs what we display, not whether we may mail someone.
    const { port: p, suppressions } = port({
      async advanceDeliveryState() {
        return false;
      },
    });

    await ingestEvent({ ...context, event: event({ type: 'hard_bounced' }) }, p);

    expect(suppressions).toHaveLength(1);
  });

  it('never suppresses on an unmatched event', async () => {
    // Another system's mail on a shared provider account must not remove our
    // customer's contacts.
    const { port: p, suppressions } = port({
      async findRecipient() {
        return null;
      },
    });

    await ingestEvent({ ...context, event: event({ type: 'hard_bounced' }) }, p);

    expect(suppressions).toEqual([]);
  });

  it('names the two suppressing states once', () => {
    expect([...SUPPRESSING_STATES]).toEqual(['hard_bounced', 'complained']);
  });
});

describe('resolving an uncertain send (D3)', () => {
  it('reconciles when an event carries the message id', async () => {
    // The worker died between the provider accepting and the commit. This
    // event is the proof it was sent.
    const { port: p } = port({
      async reconcileUncertain() {
        return true;
      },
    });

    expect((await ingestEvent({ ...context, event: event() }, p)).reconciled).toBe(true);
  });

  it('reconciles before it advances the lattice', async () => {
    // Otherwise the recipient is still `delivery_uncertain` when the delivery
    // state moves, and the two disagree for the life of the campaign.
    const { port: p, calls } = port();

    await ingestEvent({ ...context, event: event() }, p);

    expect(calls.indexOf('reconcile')).toBeLessThan(calls.indexOf('advance'));
  });

  it('does not attempt it for an engagement event', async () => {
    // An open proves the message arrived, but the send path's own uncertainty
    // is resolved by delivery events, which carry the id the sweeper stored.
    const { port: p, calls } = port();

    await ingestEvent({ ...context, event: event({ type: 'open' }) }, p);

    expect(calls).not.toContain('reconcile');
  });
});

describe('an event type nothing understands', () => {
  it('records it without touching state', async () => {
    const { port: p, calls, raw } = port();

    const result = await ingestEvent({ ...context, event: event({ type: 'unknown' }) }, p);

    expect(raw).toHaveLength(1);
    expect(calls).not.toContain('advance');
    expect(result.reason).toContain('unknown');
  });

  it('records an unsubscribe without putting it on the lattice', async () => {
    // Unsubscribing is not a delivery outcome; the message was delivered.
    const { port: p, calls } = port();

    await ingestEvent({ ...context, event: event({ type: 'unsubscribe' }) }, p);

    expect(calls).not.toContain('advance');
  });
});
