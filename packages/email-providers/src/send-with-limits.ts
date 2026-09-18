import { batchSizeFor } from './batching.js';
import { fromUnknown } from './errors.js';
import type {
  EmailProviderAdapter,
  OutboundMessage,
  ProviderCredentials,
  SendOutcome,
} from './port.js';

/**
 * The only way to send.
 *
 * CLAUDE.md §6.4: "the rate limiter and the daily-quota check live inside the
 * adapter call path so no consumer can forget them". This is that path. A
 * lint rule and a test both enforce that nothing outside this file calls
 * `adapter.send` or `adapter.sendBatch`, because the guarantee is worthless if
 * it can be walked around — and the walk-around is one autocomplete away.
 *
 * The limiter and quota hooks are injected rather than imported: they are
 * wired in Phase 6, and the wrapper has to exist now so that everything
 * written before then is already going through it. Until they are supplied
 * the wrapper still does the work that does not depend on them — batching to
 * the adapter's declared size, scrubbing throws into typed errors, and
 * guaranteeing one outcome per message.
 */

export interface RateLimiter {
  /**
   * Acquires permission to send `count` messages from this sender.
   *
   * Fails closed: if the limiter cannot be reached, the answer is no. Redis
   * being down must never become permission to send (CLAUDE.md §9).
   */
  acquire(input: {
    workspaceId: string;
    senderAccountId: string;
    count: number;
  }): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number; reason: 'rate' | 'quota' }>;
}

export interface SendContext {
  readonly workspaceId: string;
  readonly senderAccountId: string;
  readonly limiter?: RateLimiter;
  /** Per-call timeout. 30s for API providers, 60s for SMTP (CLAUDE.md §9). */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Sends a batch through an adapter, respecting every limit.
 *
 * Always returns exactly one outcome per message, in the order given. An
 * adapter that returns fewer, or in another order, is corrected here rather
 * than at every call site: a missing outcome means a recipient stuck in
 * `sending` forever, waiting for a reconciler.
 */
export async function sendWithLimits(
  adapter: EmailProviderAdapter,
  creds: ProviderCredentials,
  messages: readonly OutboundMessage[],
  context: SendContext,
): Promise<SendOutcome[]> {
  if (messages.length === 0) return [];

  const outcomes = new Map<string, SendOutcome>();
  // R31: capped here, not at the adapter's declared maximum. The cap bounds
  // how many recipients one ambiguous response can leave uncertain.
  const batchSize = batchSizeFor(adapter.capabilities.maxBatchSize);

  // The step is guarded a second time, in a different file from the first.
  // `batchSizeFor` already guarantees at least one, and this line exists
  // because of what happens if that ever stops being true: `index += 0` is an
  // infinite loop inside the send path, which pegs a worker, holds its queue
  // lock until it expires, and stalls the campaign without an error anywhere.
  // A redundant `Math.max` is a very cheap insurance premium against that.
  const step = Math.max(1, batchSize);

  for (let index = 0; index < messages.length; index += step) {
    const batch = messages.slice(index, index + step);

    const permission = await acquire(context, batch.length);
    if (permission !== null) {
      // Not an error the caller retries per message: every message in this
      // batch is deferred with the same reason and the same delay.
      for (const message of batch) outcomes.set(message.recipientId, { ...permission, recipientId: message.recipientId });
      continue;
    }

    for (const outcome of await callAdapter(adapter, creds, batch, context)) {
      outcomes.set(outcome.recipientId, outcome);
    }
  }

  return messages.map(
    (message) =>
      outcomes.get(message.recipientId) ?? {
        ok: false as const,
        recipientId: message.recipientId,
        error: fromUnknown(
          new Error('The provider returned no result for this recipient'),
        ),
      },
  );
}

/** Returns null when sending is permitted, or the outcome to record when not. */
async function acquire(
  context: SendContext,
  count: number,
): Promise<{ ok: false; error: ReturnType<typeof fromUnknown> } | null> {
  if (context.limiter === undefined) return null;

  let verdict;
  try {
    verdict = await context.limiter.acquire({
      workspaceId: context.workspaceId,
      senderAccountId: context.senderAccountId,
      count,
    });
  } catch (cause) {
    // Fails closed. An unreachable limiter is not permission to send.
    return {
      ok: false,
      error: {
        ...fromUnknown(cause),
        kind: 'rate_limited',
        retryable: true,
        affects: 'sender',
        message: 'The rate limiter could not be reached, so nothing was sent',
      },
    };
  }

  if (verdict.allowed) return null;

  return {
    ok: false,
    error: {
      kind: verdict.reason === 'quota' ? 'quota_exceeded' : 'rate_limited',
      retryable: true,
      retryAfterMs: verdict.retryAfterMs,
      affects: 'sender',
      message:
        verdict.reason === 'quota'
          ? 'The daily quota for this sender is exhausted'
          : 'This sender is being rate limited',
    },
  };
}

/**
 * Calls the adapter, with a timeout and with every throw scrubbed.
 *
 * A timeout is deliberately not turned into a failure: the provider may have
 * accepted the message. `timeout` leaves the recipient ambiguous for the
 * reconciler to resolve, which is the only safe reading (docs/07, D3).
 */
async function callAdapter(
  adapter: EmailProviderAdapter,
  creds: ProviderCredentials,
  batch: readonly OutboundMessage[],
  context: SendContext,
): Promise<SendOutcome[]> {
  const timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    // Keyed on the declared capability, not on how many messages this
    // particular batch happens to hold. Choosing per batch would send the
    // last partial batch of every run down a different code path from all the
    // others — so SMTP is exercised constantly and a batch provider's
    // single-message path only ever on a remainder.
    const single = adapter.capabilities.maxBatchSize <= 1;
    const first = batch[0];

    const call =
      single && first !== undefined
        ? adapter.send(creds, first).then((outcome) => [outcome])
        : adapter.sendBatch(creds, batch);

    return await withTimeout(call, timeoutMs);
  } catch (cause) {
    const error = fromUnknown(cause);
    return batch.map((message) => ({ ok: false as const, recipientId: message.recipientId, error }));
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`The provider did not respond within ${ms}ms`);
      // Classified as a timeout, not a failure: it may have been accepted.
      Object.assign(error, { code: 'ETIMEDOUT' });
      reject(error);
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}
