/**
 * Retry, in both of its forms.
 *
 * **Automatic.** A retryable failure goes back onto `email-send` as a delayed
 * job, not onto a queue of its own. A separate retry consumer would be a
 * second code path to the provider, and R1's guarded claim, R30's suppression
 * re-check and the limiter inside `sendWithLimits` would all have to be
 * remembered again in it. They would not be. The recipient returns to
 * `pending` and the same worker picks it up later.
 *
 * **Manual.** `POST /campaigns/:id/retry-failed` resets failed recipients
 * whose error was retryable and leaves the rest alone. A `content_rejected`
 * does not become deliverable because a human clicked a button, and telling
 * the customer how many were excluded is more useful than silently retrying
 * them five more times.
 *
 * Neither form touches `metered` (R14/F14). The trigger would refuse it, and
 * this module never asks: `metered` is already true if the send was accepted
 * and false if it was not, so there is nothing for a retry to correct. The
 * trace F14 describes is a campaign with 10,000 failures from a provider
 * outage, a customer clicking retry-failed, and an implementation that resets
 * `metered` alongside `state` — which is the natural thing to write, because
 * resetting state feels like it should reset everything.
 */

/** From the queue catalogue. A recipient gets five attempts, then stops. */
export const MAX_SEND_ATTEMPTS = 5;

/** `backoff: { type: 'exponential', delay: 2000, maxDelay: 5 * 60_000 }`. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 5 * 60_000;

/**
 * Columns `retry-failed` is allowed to write.
 *
 * Exported so the repository's UPDATE and this module cannot disagree, and so
 * that a test can assert `metered` is not among them. A list is a weak guard
 * on its own — the trigger is the real one — but it is the guard that fails at
 * review time rather than at runtime.
 */
export const RETRY_RESET_COLUMNS = [
  'state',
  'attempt_count',
  'error_code',
  'error_message',
  'queued_at',
  'provider_attempt_started_at',
  'attempt_token',
] as const;

/**
 * How long to wait before the next attempt.
 *
 * The provider's own `Retry-After` wins whenever it gave one: it knows when
 * its rate window resets and we are guessing. Otherwise exponential from the
 * base, capped — an uncapped exponential reaches hours by attempt eight and a
 * campaign quietly stops finishing.
 */
export function retryDelayMs(
  attemptCount: number,
  retryAfterMs?: number | undefined,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    // Still capped. A provider asking for a six-hour wait is asking for
    // something the queue's own lock and the campaign's deadlines cannot
    // honour; the sweeper would reclaim the row long before it elapsed.
    return Math.min(retryAfterMs, RETRY_MAX_MS);
  }

  const attempt = Math.max(1, Math.floor(attemptCount));
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

export type RetryDecision =
  | { action: 'retry'; delayMs: number; attempt: number }
  | { action: 'exhausted'; attempts: number };

/**
 * Whether this recipient gets another attempt, and when.
 *
 * `attemptCount` is what the guarded claim already incremented, so it is the
 * number of attempts *made*, not the index of the next one.
 */
export function planRetry(input: {
  attemptCount: number;
  retryAfterMs?: number | undefined;
  maxAttempts?: number;
}): RetryDecision {
  const maxAttempts = input.maxAttempts ?? MAX_SEND_ATTEMPTS;

  if (input.attemptCount >= maxAttempts) {
    return { action: 'exhausted', attempts: input.attemptCount };
  }

  return {
    action: 'retry',
    delayMs: retryDelayMs(input.attemptCount, input.retryAfterMs),
    attempt: input.attemptCount + 1,
  };
}

/**
 * Error codes a manual retry-failed may reset.
 *
 * Read from ERROR_POLICY rather than listed again here, so that adding a kind
 * to the provider port cannot leave this file behind. The alternative — a
 * second list — is how `content_rejected` ends up retryable eighteen months
 * from now.
 */
export function manuallyRetryable(
  errorCode: string,
  policy: Readonly<Record<string, { retryable: boolean }>>,
): boolean {
  const entry = policy[errorCode];
  // An unrecognised code is not retried. It came from somewhere we no longer
  // understand, and a send is not the place to find out.
  return entry?.retryable === true;
}

export interface RetryFailedPort {
  /**
   * Resets the retryable failures of one campaign to `pending`.
   *
   * Writes only RETRY_RESET_COLUMNS. `metered` is not among them and the
   * `trg_guard_metered` trigger would reject the statement if it were.
   * Counters move in the same transaction (R13).
   */
  resetRetryableFailures(input: {
    campaignId: string;
    retryableCodes: readonly string[];
  }): Promise<number>;

  /** How many were left alone, and why, so the customer can be told. */
  countPermanentFailures(campaignId: string): Promise<Record<string, number>>;

  /** Guarded `completed*|paused -> queueing`, so the dispatcher restarts. */
  reopenForDispatch(campaignId: string): Promise<boolean>;

  recordEvent(input: { campaignId: string; eventType: string; detail: unknown }): Promise<void>;
}

export interface RetryFailedResult {
  retried: number;
  /** Error code → how many were excluded as permanent. */
  excluded: Record<string, number>;
  reopened: boolean;
}

/**
 * The manual retry.
 *
 * Order matters once: the permanent failures are counted *before* the reset,
 * because afterwards the retryable ones are no longer `failed` and the two
 * counts would not add up to what the customer saw when they clicked.
 */
export async function retryFailedRecipients(
  campaignId: string,
  policy: Readonly<Record<string, { retryable: boolean }>>,
  port: RetryFailedPort,
): Promise<RetryFailedResult> {
  const excluded = await port.countPermanentFailures(campaignId);

  const retryableCodes = Object.keys(policy).filter((code) => manuallyRetryable(code, policy));

  const retried = await port.resetRetryableFailures({ campaignId, retryableCodes });

  if (retried === 0) {
    // Nothing to do, and reopening a completed campaign with no work would
    // leave it in `queueing` for the reconciler to fail out ten minutes later.
    await port.recordEvent({
      campaignId,
      eventType: 'campaign.retry_failed',
      detail: { retried: 0, excluded },
    });

    return { retried: 0, excluded, reopened: false };
  }

  const reopened = await port.reopenForDispatch(campaignId);

  await port.recordEvent({
    campaignId,
    eventType: 'campaign.retry_failed',
    detail: { retried, excluded, reopened },
  });

  return { retried, excluded, reopened };
}
