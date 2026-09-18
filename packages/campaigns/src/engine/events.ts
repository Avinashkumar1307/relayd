/**
 * Inbound provider events (INVARIANTS R4, R16, R32; findings F4, F16, F32).
 *
 * A stored webhook event becomes a state change here. Four rules govern it and
 * three of them exist because providers do not guarantee ordering.
 *
 *   **R16/F16 — the rank lattice.** SES publishes through SNS, which has no
 *   ordering guarantee at all, so a `delivered` arriving after a `bounced` is
 *   routine rather than exotic. The design's original answer — re-fetch the
 *   object — works for Stripe and cannot work here: no provider has an
 *   endpoint that returns the current delivery state of a message. So state
 *   only ever moves up a fixed ladder, and a late `delivered` that would
 *   overwrite a hard bounce is simply a write that matches zero rows.
 *
 *   That is a compliance property as much as a correctness one. Overwriting a
 *   bounce with a delivery means the contact is never suppressed, and the next
 *   campaign mails a dead address again.
 *
 *   **R32/F32 — the dedupe key.** Providers without a stable event id get
 *   `sha256(connection || type || messageId || occurredAt)`. This collapses
 *   genuinely identical simultaneous events, which for opens is an acceptable
 *   loss and for state events is the correct behaviour.
 *
 *   **R4 — connection scope.** The recipient lookup is scoped to
 *   `(workspace_id, provider_connection_id)`. An event that matches nothing is
 *   stored with `matched = false` and mutates nothing, ever.
 *
 *   **Raw events are always written.** Whether or not the lattice moves,
 *   `email_events` gets the row. Analytics stays complete even when state does
 *   not, and the row is the only evidence when the two disagree.
 */

/**
 * R16's ladder.
 *
 * Repeated from `packages/db/src/schema/campaigns.ts` rather than imported:
 * this package has no dependency on the database package, because the engine
 * is expressed against ports and the worker wires them together. Both copies
 * are pinned to the same literal by
 * `packages/db/test/campaign-schema.test.ts` and by this package's own
 * `events.test.ts`, so a change to either fails in one of the two places.
 */
export type DeliveryState =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'soft_bounced'
  | 'hard_bounced'
  | 'complained';

export const DELIVERY_RANK: Readonly<Record<DeliveryState, number>> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  soft_bounced: 3,
  hard_bounced: 4,
  complained: 5,
};

/**
 * Events that advance the lattice, and events that merely accumulate.
 *
 * An open is not a delivery state — a message can be opened and later
 * complained about, and neither fact replaces the other. Putting engagement
 * on the ladder would mean the first open freezes the delivery state, or that
 * a complaint erases the open.
 */
export const ENGAGEMENT_EVENTS = ['open', 'click'] as const;

export type EngagementEvent = (typeof ENGAGEMENT_EVENTS)[number];

/** Delivery states whose arrival suppresses the contact. */
export const SUPPRESSING_STATES: readonly DeliveryState[] = ['hard_bounced', 'complained'];

export interface NormalisedEvent {
  /** What the adapter made of the provider's payload. */
  type: DeliveryState | EngagementEvent | 'unsubscribe' | 'unknown';
  providerMessageId: string | null;
  occurredAt: Date;
  /** Present only for a click. */
  url?: string;
  /** The provider's own event id, when it has a stable one (R32). */
  providerEventId?: string;
  raw: unknown;
}

export interface EventIngestPort {
  /**
   * R4: scoped to `(workspace_id, provider_connection_id)`.
   *
   * Returns null when nothing matches, which is a completely normal outcome —
   * a message sent before this connection existed, or another system's mail
   * on a shared account.
   */
  findRecipient(input: {
    workspaceId: string;
    providerConnectionId: string;
    providerMessageId: string;
  }): Promise<{ id: string; campaignId: string; contactId: string; email: string } | null>;

  /**
   * The guarded lattice write (R16):
   * `UPDATE ... SET delivery_state = $2, delivery_rank = $3
   *  WHERE id = $1 AND delivery_rank < $3`
   *
   * Returns false when zero rows matched, which means a later event already
   * won. That is the expected outcome for a reordered delivery, not an error.
   */
  advanceDeliveryState(input: {
    recipientId: string;
    state: DeliveryState;
    rank: number;
    occurredAt: Date;
  }): Promise<boolean>;

  /** Always called, whether or not the lattice moved. */
  writeRawEvent(input: {
    recipientId: string | null;
    campaignId: string | null;
    type: string;
    occurredAt: Date;
    dedupeKey: string;
    matched: boolean;
    raw: unknown;
  }): Promise<{ inserted: boolean }>;

  /** Hard bounce and complaint only. Idempotent. */
  suppressContact(input: {
    workspaceId: string;
    email: string;
    reason: DeliveryState;
  }): Promise<void>;

  /**
   * D3: a `delivery_uncertain` recipient whose message id turns up in a
   * provider event was in fact sent. This is the only path that resolves one.
   */
  reconcileUncertain(input: { recipientId: string; providerMessageId: string }): Promise<boolean>;
}

export interface IngestResult {
  matched: boolean;
  duplicate: boolean;
  advanced: boolean;
  suppressed: boolean;
  reconciled: boolean;
  reason?: string;
}

/**
 * Turns one stored provider event into whatever it implies.
 *
 * The order is: write the raw event, then move state. Writing first means an
 * event that fails half-way still leaves the evidence, and the dedupe key on
 * the raw write is what makes the whole function idempotent — a replayed
 * webhook does the state work at most once because the second insert is a
 * no-op and returns early.
 */
export async function ingestEvent(
  input: {
    workspaceId: string;
    providerConnectionId: string;
    event: NormalisedEvent;
  },
  port: EventIngestPort,
): Promise<IngestResult> {
  const dedupeKey = dedupeKeyFor(input.providerConnectionId, input.event);

  const recipient =
    input.event.providerMessageId === null
      ? null
      : await port.findRecipient({
          workspaceId: input.workspaceId,
          providerConnectionId: input.providerConnectionId,
          providerMessageId: input.event.providerMessageId,
        });

  // Always written, matched or not. An unmatched event is evidence that
  // something is misrouted, and deleting it destroys the only trace.
  const { inserted } = await port.writeRawEvent({
    recipientId: recipient?.id ?? null,
    campaignId: recipient?.campaignId ?? null,
    type: input.event.type,
    occurredAt: input.event.occurredAt,
    dedupeKey,
    matched: recipient !== null,
    raw: input.event.raw,
  });

  if (!inserted) {
    // A replay. The first delivery already did everything below.
    return {
      matched: recipient !== null,
      duplicate: true,
      advanced: false,
      suppressed: false,
      reconciled: false,
    };
  }

  if (recipient === null) {
    return {
      matched: false,
      duplicate: false,
      advanced: false,
      suppressed: false,
      reconciled: false,
      reason: 'no recipient for this message id on this connection',
    };
  }

  // One gate, not two. An earlier version checked engagement separately and
  // then checked for a delivery state, and the first check turned out to
  // change nothing — an open is not a delivery state either, so it left by the
  // same door. Two guards where one bites is how the next reader comes to
  // believe the dead one is doing something.
  if (!isDeliveryState(input.event.type)) {
    return {
      matched: true,
      duplicate: false,
      advanced: false,
      suppressed: false,
      reconciled: false,
      reason: isEngagement(input.event.type)
        ? 'engagement is additive and outside the lattice'
        : `nothing to do for ${input.event.type}`,
    };
  }

  const state = input.event.type;

  // D3: an event carrying this message id proves the send happened, whatever
  // the sweeper concluded when the worker died mid-commit.
  const reconciled =
    input.event.providerMessageId === null
      ? false
      : await port.reconcileUncertain({
          recipientId: recipient.id,
          providerMessageId: input.event.providerMessageId,
        });

  const advanced = await port.advanceDeliveryState({
    recipientId: recipient.id,
    state,
    rank: DELIVERY_RANK[state],
    occurredAt: input.event.occurredAt,
  });

  // Suppression follows the event, not the lattice. A hard bounce that lost
  // the race to a complaint still means the address is dead, and the contact
  // must be suppressed either way — the lattice governs the recipient's
  // displayed state, not whether we are allowed to mail someone again.
  let suppressed = false;
  if (SUPPRESSING_STATES.includes(state)) {
    await port.suppressContact({
      workspaceId: input.workspaceId,
      email: recipient.email,
      reason: state,
    });
    suppressed = true;
  }

  return { matched: true, duplicate: false, advanced, suppressed, reconciled };
}

/**
 * R32: a stable key for an event that may arrive twice.
 *
 * Uses the provider's own event id when there is one, because that is exactly
 * what it is for. Otherwise a synthetic key over the fields that identify the
 * event: connection, type, message id, and the instant it happened.
 *
 * The synthetic form collapses genuinely identical simultaneous events. For
 * two opens in the same second that is an acceptable loss; for two `delivered`
 * events for one message it is the correct behaviour.
 */
export function dedupeKeyFor(providerConnectionId: string, event: NormalisedEvent): string {
  if (event.providerEventId !== undefined && event.providerEventId !== '') {
    return `${providerConnectionId}:${event.providerEventId}`;
  }

  // Length-prefixed rather than delimiter-joined. A message id or a URL can
  // contain any byte one might pick as a separator, and two fields that run
  // into each other are two different events that collapse into one — which
  // for delivery state means silently dropping a bounce.
  return [
    providerConnectionId,
    event.type,
    event.providerMessageId ?? '',
    // Millisecond precision. Second precision would collapse two genuinely
    // distinct clicks on different links a few hundred milliseconds apart.
    event.occurredAt.toISOString(),
    event.url ?? '',
  ]
    .map((field) => `${field.length}:${field}`)
    .join('');
}

export function isEngagement(type: string): type is EngagementEvent {
  return (ENGAGEMENT_EVENTS as readonly string[]).includes(type);
}

export function isDeliveryState(type: string): type is DeliveryState {
  return Object.hasOwn(DELIVERY_RANK, type);
}

/**
 * Whether an event would move a recipient forward, without writing anything.
 *
 * The same comparison the guarded UPDATE makes, available to callers that
 * want to decide before they touch the database.
 */
export function wouldAdvance(current: DeliveryState, next: DeliveryState): boolean {
  return DELIVERY_RANK[current] < DELIVERY_RANK[next];
}
