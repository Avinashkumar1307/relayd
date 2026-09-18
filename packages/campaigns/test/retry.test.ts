import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SEND_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RETRY_RESET_COLUMNS,
  manuallyRetryable,
  planRetry,
  retryDelayMs,
  retryFailedRecipients,
  type RetryFailedPort,
} from '../src/engine/retry.js';

/**
 * Retry, automatic and manual (INVARIANTS R14; review finding F14).
 *
 * The expensive mistake here is not getting the backoff curve wrong. It is
 * `retry-failed` resetting `metered` along with `state`, which bills every
 * successful retry a second time — so most of this file is about what a retry
 * is allowed to write.
 *
 * The policy below mirrors the `retryable` column of the real ERROR_POLICY.
 * It is a copy on purpose: `packages/campaigns` has no dependency on
 * `packages/email-providers` and should not grow one for a test, since the
 * engine is expressed against ports and the worker is what wires them
 * together. The real table is pinned at its own source, in
 * `packages/email-providers/test/errors.test.ts`, so a change there fails
 * loudly rather than silently disagreeing with this.
 */

const ERROR_POLICY: Readonly<Record<string, { retryable: boolean }>> = {
  auth_failed: { retryable: false },
  rate_limited: { retryable: true },
  quota_exceeded: { retryable: true },
  invalid_recipient: { retryable: false },
  invalid_sender: { retryable: false },
  content_rejected: { retryable: false },
  message_too_large: { retryable: false },
  provider_unavailable: { retryable: true },
  timeout: { retryable: true },
  unknown: { retryable: true },
};

function port(overrides: Partial<RetryFailedPort> = {}) {
  const calls: string[] = [];
  const events: { eventType: string; detail: unknown }[] = [];
  let resetWith: readonly string[] = [];

  const base: RetryFailedPort = {
    async resetRetryableFailures(input) {
      calls.push('reset');
      resetWith = input.retryableCodes;
      return 120;
    },
    async countPermanentFailures() {
      calls.push('countPermanent');
      return { invalid_recipient: 30, content_rejected: 4 };
    },
    async reopenForDispatch() {
      calls.push('reopen');
      return true;
    },
    async recordEvent(input) {
      events.push({ eventType: input.eventType, detail: input.detail });
    },
    ...overrides,
  };

  return { port: base, calls, events, codes: () => resetWith };
}

describe('the backoff', () => {
  it('starts at the queue catalogue’s base delay', () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(RETRY_BASE_MS).toBe(2_000);
  });

  it('doubles each attempt', () => {
    expect(retryDelayMs(2)).toBe(4_000);
    expect(retryDelayMs(3)).toBe(8_000);
    expect(retryDelayMs(4)).toBe(16_000);
  });

  it('caps, so a campaign does not quietly stop finishing', () => {
    // Uncapped, attempt eight is over four minutes and attempt twelve is an
    // hour. The campaign never completes and nobody can say why.
    expect(retryDelayMs(20)).toBe(RETRY_MAX_MS);
    expect(RETRY_MAX_MS).toBe(5 * 60_000);
  });

  it('prefers the provider’s own Retry-After', () => {
    // It knows when its rate window resets; we are guessing.
    expect(retryDelayMs(1, 45_000)).toBe(45_000);
    expect(retryDelayMs(4, 1_000)).toBe(1_000);
  });

  it('caps Retry-After too', () => {
    // A provider asking for six hours is asking for something the queue lock
    // and the sweeper's ten-minute deadline cannot honour.
    expect(retryDelayMs(1, 6 * 60 * 60_000)).toBe(RETRY_MAX_MS);
  });

  it('ignores a nonsensical Retry-After', () => {
    expect(retryDelayMs(2, 0)).toBe(4_000);
    expect(retryDelayMs(2, -5)).toBe(4_000);
  });

  it('never returns a negative or zero delay', () => {
    for (const attempt of [0, -1, 1, 5]) {
      expect(retryDelayMs(attempt)).toBeGreaterThan(0);
    }
  });
});

describe('deciding whether to retry at all', () => {
  it('retries while attempts remain', () => {
    expect(planRetry({ attemptCount: 1 })).toEqual({
      action: 'retry',
      delayMs: 2_000,
      attempt: 2,
    });
  });

  it('stops at the queue’s attempt limit', () => {
    expect(planRetry({ attemptCount: MAX_SEND_ATTEMPTS })).toEqual({
      action: 'exhausted',
      attempts: 5,
    });
  });

  it('stops past the limit as well as at it', () => {
    // A recipient whose attempt count somehow overshot — a manual reset, a
    // replayed dead letter — must not become immortal.
    expect(planRetry({ attemptCount: 99 }).action).toBe('exhausted');
  });

  it('uses the attempt count the claim already incremented', () => {
    // `attemptCount` is attempts made, not the index of the next one. Off by
    // one here is a sixth attempt on a queue configured for five.
    expect(planRetry({ attemptCount: 4 }).action).toBe('retry');
    expect(planRetry({ attemptCount: 5 }).action).toBe('exhausted');
  });

  it('carries Retry-After into the plan', () => {
    const decision = planRetry({ attemptCount: 1, retryAfterMs: 30_000 });
    expect(decision).toMatchObject({ action: 'retry', delayMs: 30_000 });
  });

  it('takes a lower limit for a caller that wants one', () => {
    expect(planRetry({ attemptCount: 2, maxAttempts: 2 }).action).toBe('exhausted');
  });
});

describe('what a retry is allowed to write (R14, F14)', () => {
  it('does not list metered among the columns it resets', () => {
    // The F14 trace: 10,000 failures from a provider outage, the customer
    // clicks retry-failed, and an implementation that resets `metered`
    // alongside `state` bills every successful retry a second time.
    expect([...RETRY_RESET_COLUMNS]).not.toContain('metered');
  });

  it('does not touch the columns that record the send itself', () => {
    for (const column of ['metered', 'provider_message_id', 'sent_at', 'terminal_at']) {
      expect([...RETRY_RESET_COLUMNS], column).not.toContain(column);
    }
  });

  it('does reset the ones a retry genuinely needs', () => {
    for (const column of ['state', 'attempt_count', 'error_code']) {
      expect([...RETRY_RESET_COLUMNS], column).toContain(column);
    }
  });

  it('clears the attempt token, so a late response cannot match', () => {
    // A provider response arriving after the reset belongs to the old
    // attempt. Leaving the token would let it commit against the new one.
    expect([...RETRY_RESET_COLUMNS]).toContain('attempt_token');
  });
});

describe('which failures a manual retry may reset', () => {
  it('reads retryability from ERROR_POLICY rather than deciding again', () => {
    // A second list is how `content_rejected` becomes retryable eighteen
    // months from now.
    expect(manuallyRetryable('rate_limited', ERROR_POLICY)).toBe(true);
    expect(manuallyRetryable('quota_exceeded', ERROR_POLICY)).toBe(true);
  });

  it('refuses a rejected address', () => {
    // It does not become deliverable because a human clicked a button.
    expect(manuallyRetryable('invalid_recipient', ERROR_POLICY)).toBe(false);
  });

  it('refuses rejected content', () => {
    expect(manuallyRetryable('content_rejected', ERROR_POLICY)).toBe(false);
    expect(manuallyRetryable('message_too_large', ERROR_POLICY)).toBe(false);
  });

  it('refuses a failed credential', () => {
    // Retrying with the same wrong password five thousand times is how a
    // provider account gets locked.
    expect(manuallyRetryable('auth_failed', ERROR_POLICY)).toBe(false);
  });

  it('refuses a code it does not recognise', () => {
    expect(manuallyRetryable('something_new', ERROR_POLICY)).toBe(false);
    expect(manuallyRetryable('', ERROR_POLICY)).toBe(false);
  });

  it('refuses a prototype key masquerading as a code', () => {
    expect(manuallyRetryable('constructor', ERROR_POLICY)).toBe(false);
    expect(manuallyRetryable('toString', ERROR_POLICY)).toBe(false);
  });
});

describe('the manual retry', () => {
  it('resets only the retryable codes', async () => {
    const { port: p, codes } = port();

    await retryFailedRecipients('c1', ERROR_POLICY, p);

    expect(codes()).toContain('rate_limited');
    expect(codes()).not.toContain('invalid_recipient');
    expect(codes()).not.toContain('content_rejected');
  });

  it('counts the permanent failures before resetting anything', async () => {
    // Afterwards the retryable ones are no longer `failed`, and the two
    // counts would not add up to what the customer saw when they clicked.
    const { port: p, calls } = port();

    await retryFailedRecipients('c1', ERROR_POLICY, p);

    expect(calls.indexOf('countPermanent')).toBeLessThan(calls.indexOf('reset'));
  });

  it('reports what it excluded and why', async () => {
    const result = await retryFailedRecipients('c1', ERROR_POLICY, port().port);

    expect(result).toMatchObject({
      retried: 120,
      excluded: { invalid_recipient: 30, content_rejected: 4 },
    });
  });

  it('restarts the dispatcher', async () => {
    // `pending` rows with no dispatcher is the F3 shape in slow motion: they
    // sit there and the campaign reports itself complete.
    const { port: p, calls } = port();

    await retryFailedRecipients('c1', ERROR_POLICY, p);

    expect(calls).toContain('reopen');
  });

  it('reopens only after the reset, never before', async () => {
    // Reopening first restarts the dispatcher against a campaign that still
    // has nothing to do, and it completes again immediately.
    const { port: p, calls } = port();

    await retryFailedRecipients('c1', ERROR_POLICY, p);

    expect(calls.indexOf('reset')).toBeLessThan(calls.indexOf('reopen'));
  });

  it('does not reopen a campaign with nothing to retry', async () => {
    // It would sit in `queueing` until the reconciler force-failed it ten
    // minutes later, turning a no-op into a failed campaign.
    const reopen = vi.fn(async () => true);
    const { port: p } = port({
      async resetRetryableFailures() {
        return 0;
      },
      reopenForDispatch: reopen,
    });

    const result = await retryFailedRecipients('c1', ERROR_POLICY, p);

    expect(result.retried).toBe(0);
    expect(result.reopened).toBe(false);
    expect(reopen).not.toHaveBeenCalled();
  });

  it('still reports the exclusions when it retried nothing', async () => {
    // "Nothing happened" and "34 of your failures are permanent" are
    // different answers, and only one of them is useful.
    const { port: p } = port({
      async resetRetryableFailures() {
        return 0;
      },
    });

    expect((await retryFailedRecipients('c1', ERROR_POLICY, p)).excluded).toEqual({
      invalid_recipient: 30,
      content_rejected: 4,
    });
  });

  it('records the retry on the campaign timeline either way', async () => {
    for (const reset of [120, 0]) {
      const { port: p, events } = port({
        async resetRetryableFailures() {
          return reset;
        },
      });

      await retryFailedRecipients('c1', ERROR_POLICY, p);

      expect(events.map((e) => e.eventType)).toEqual(['campaign.retry_failed']);
    }
  });

  it('reports a lost reopen race rather than claiming it worked', async () => {
    const { port: p } = port({
      async reopenForDispatch() {
        return false;
      },
    });

    expect((await retryFailedRecipients('c1', ERROR_POLICY, p)).reopened).toBe(false);
  });
});
