/**
 * The send worker.
 *
 * The single most important sequence in the product, and the order of its
 * steps is the whole of it. Five invariants meet here:
 *
 *   R1 — the *first* statement is a guarded transition to `sending`. Zero rows
 *   means somebody else has this recipient, and the worker exits without
 *   sending. The BullMQ job id is a dedupe optimisation and nothing more: a
 *   job evicted by `removeOnComplete` and re-enqueued would otherwise send
 *   twice.
 *
 *   R5 — `provider_attempt_started_at` is written *before* the provider call,
 *   in that same statement. A worker killed between the provider accepting and
 *   the commit leaves a row the sweeper can find; without the timestamp the row
 *   looks identical to one that never started.
 *
 *   R30/F30 — suppression is re-checked here, not only at snapshot. A six-hour
 *   campaign otherwise mails someone who unsubscribed in hour two. One indexed
 *   lookup, and it is a legal exposure rather than a nicety.
 *
 *   R9/R10/R11 — the rate limiter and daily quota live inside
 *   `sendWithLimits`, so this path cannot forget them.
 *
 *   R14 — on success, one transaction writes `sent`, `metered = true`, the
 *   usage record, the daily usage increment and the counters. Anything less
 *   than one transaction is a way to bill without sending or send without
 *   billing.
 */

export type SendOutcomeKind =
  | 'sent'
  | 'skipped_not_claimable'
  | 'skipped_suppressed'
  | 'skipped_campaign_not_sending'
  | 'failed'
  | 'deferred'
  | 'uncertain';

export interface SendPort {
  /**
   * R1 and R5 in one statement.
   *
   * `UPDATE campaign_recipients SET state='sending', attempt_count=attempt_count+1,
   *  provider_attempt_started_at=now(), attempt_token=gen_random_uuid()
   *  WHERE id=$1 AND state IN ('queued','pending') RETURNING attempt_token`
   *
   * Returns null when zero rows matched.
   */
  claimForSending(recipientId: string): Promise<{ attemptToken: string; attemptCount: number } | null>;

  /** Everything needed to build the message. Read after the claim. */
  loadRecipient(recipientId: string): Promise<SendableRecipient | null>;

  /** R30: one indexed lookup on suppressions, at send time. */
  isSuppressed(input: { workspaceId: string; email: string }): Promise<boolean>;

  /** The campaign's current state, so a pause takes effect mid-flight. */
  campaignState(campaignId: string): Promise<string | null>;

  /**
   * The success transaction (R14).
   *
   * Writes `sent`, `metered = true`, the usage record keyed
   * `send:{recipientId}`, the sender_daily_usage increment and the counter
   * move — all of it, or none.
   */
  commitSent(input: {
    recipientId: string;
    attemptToken: string;
    providerMessageId: string | null;
    senderAccountId: string;
    providerConnectionId: string;
    acceptedAt: Date;
  }): Promise<void>;

  /** A terminal failure: no further attempts, never metered. */
  commitFailed(input: {
    recipientId: string;
    attemptToken: string;
    errorCode: string;
    errorMessage: string;
    suppressContact: boolean;
  }): Promise<void>;

  /** A retryable failure: back to `pending` with a delay. */
  commitDeferred(input: {
    recipientId: string;
    attemptToken: string;
    errorCode: string;
    retryAfterMs: number | undefined;
  }): Promise<void>;

  /**
   * D3: the provider may have accepted it.
   *
   * Terminal, unmetered, and surfaced to the customer. Never resent — a later
   * provider event carrying the message id can reconcile it to `sent`.
   */
  commitUncertain(input: {
    recipientId: string;
    attemptToken: string;
    reason: string;
  }): Promise<void>;

  /** Marks the recipient suppressed without sending (R30). */
  commitSuppressed(input: { recipientId: string; attemptToken: string }): Promise<void>;
}

export interface SendableRecipient {
  id: string;
  workspaceId: string;
  campaignId: string;
  email: string;
  mergeData: Record<string, unknown>;
  messageToken: Buffer;
  senderAccountId: string;
  providerConnectionId: string;
}

/** What the caller does with the message once it is built. */
export interface ProviderCall {
  (input: { recipient: SendableRecipient; attemptToken: string }): Promise<ProviderCallResult>;
}

export type ProviderCallResult =
  | { ok: true; providerMessageId: string | null; acceptedAt: Date }
  | {
      ok: false;
      kind: 'permanent' | 'retryable' | 'ambiguous';
      errorCode: string;
      message: string;
      retryAfterMs?: number;
      /** A bad address suppresses; a rejected subject line does not. */
      suppressContact?: boolean;
    };

/** Campaign states in which sending should continue. */
const SENDING_STATES = new Set(['sending', 'queueing', 'pausing']);

export interface SendResult {
  kind: SendOutcomeKind;
  detail?: string;
}

export async function sendOne(
  recipientId: string,
  port: SendPort,
  call: ProviderCall,
): Promise<SendResult> {
  // 1. The guarded claim. First statement, before anything is read (R1), and
  //    it records the attempt start in the same write (R5).
  const claim = await port.claimForSending(recipientId);
  if (claim === null) {
    // Somebody else has it, or it is already terminal. Exiting cleanly is the
    // correct response to a redelivered job.
    return { kind: 'skipped_not_claimable' };
  }

  const recipient = await port.loadRecipient(recipientId);
  if (recipient === null) {
    await port.commitFailed({
      recipientId,
      attemptToken: claim.attemptToken,
      errorCode: 'recipient_missing',
      errorMessage: 'The recipient row disappeared between claim and load',
      suppressContact: false,
    });
    return { kind: 'failed', detail: 'recipient_missing' };
  }

  // 2. The campaign may have been paused or cancelled since this job was
  //    enqueued. Checked before the expensive part, so a pause takes effect
  //    within one dispatcher tick rather than one queue drain.
  const campaignState = await port.campaignState(recipient.campaignId);
  if (campaignState === null || !SENDING_STATES.has(campaignState)) {
    await port.commitDeferred({
      recipientId,
      attemptToken: claim.attemptToken,
      errorCode: 'campaign_not_sending',
      retryAfterMs: undefined,
    });
    return { kind: 'skipped_campaign_not_sending', detail: campaignState ?? 'missing' };
  }

  // 3. Suppression, re-checked here (R30/F30). The snapshot may be hours old.
  if (await port.isSuppressed({ workspaceId: recipient.workspaceId, email: recipient.email })) {
    await port.commitSuppressed({ recipientId, attemptToken: claim.attemptToken });
    return { kind: 'skipped_suppressed' };
  }

  // 4. The provider call. The limiter and the daily quota are inside it
  //    (R9-R11), and its timeout is below the queue's lock duration (R2).
  const result = await call({ recipient, attemptToken: claim.attemptToken });

  if (result.ok) {
    // 5. One transaction: sent, metered, usage, daily usage, counters (R14).
    await port.commitSent({
      recipientId,
      attemptToken: claim.attemptToken,
      providerMessageId: result.providerMessageId,
      senderAccountId: recipient.senderAccountId,
      providerConnectionId: recipient.providerConnectionId,
      acceptedAt: result.acceptedAt,
    });

    return { kind: 'sent' };
  }

  switch (result.kind) {
    case 'ambiguous':
      // The provider may have accepted it. Resending is the one thing that
      // must not happen (D3, R31).
      await port.commitUncertain({
        recipientId,
        attemptToken: claim.attemptToken,
        reason: result.errorCode,
      });
      return { kind: 'uncertain', detail: result.errorCode };

    case 'retryable':
      await port.commitDeferred({
        recipientId,
        attemptToken: claim.attemptToken,
        errorCode: result.errorCode,
        retryAfterMs: result.retryAfterMs,
      });
      return { kind: 'deferred', detail: result.errorCode };

    default:
      await port.commitFailed({
        recipientId,
        attemptToken: claim.attemptToken,
        errorCode: result.errorCode,
        errorMessage: result.message,
        suppressContact: result.suppressContact === true,
      });
      return { kind: 'failed', detail: result.errorCode };
  }
}

/**
 * Translates a provider error into what the send path should do.
 *
 * Reads ERROR_POLICY rather than deciding again, so the adapter boundary and
 * the send path cannot disagree about whether an error suppresses.
 */
export function classifyForSend(error: {
  kind: string;
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
}): Extract<ProviderCallResult, { ok: false }> {
  // A timeout is the ambiguous one: the provider may have accepted it.
  if (error.kind === 'timeout') {
    return {
      ok: false,
      kind: 'ambiguous',
      errorCode: error.kind,
      message: error.message,
    };
  }

  if (error.retryable) {
    return {
      ok: false,
      kind: 'retryable',
      errorCode: error.kind,
      message: error.message,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }

  return {
    ok: false,
    kind: 'permanent',
    errorCode: error.kind,
    message: error.message,
    // Only a bad address suppresses. A rejected subject line must not remove
    // a contact from every future campaign.
    suppressContact: error.kind === 'invalid_recipient',
  };
}

/**
 * A deterministic Message-ID for one attempt.
 *
 * Deterministic so a resend of the same attempt — which should not happen, but
 * is the case this defends — carries the same id, and a provider that
 * deduplicates on it catches what we missed. Built from the recipient and the
 * attempt token rather than a clock or a counter.
 */
export function messageIdFor(input: {
  recipientId: string;
  attemptToken: string;
  domain: string;
}): string {
  return `<${input.recipientId}.${input.attemptToken}@${input.domain}>`;
}
