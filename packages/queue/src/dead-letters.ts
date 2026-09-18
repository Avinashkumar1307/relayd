import { CRITICAL_QUEUES, type QueueName } from './queues.js';

/**
 * The dead-letter handler.
 *
 * BullMQ has no native DLQ, so it is explicit: once a job has exhausted its
 * attempts, its payload and a scrubbed error are written to Postgres, where an
 * operator can see them, and replayed from.
 *
 * Replay re-enqueues with the *original* job id. That is why every queue has a
 * deterministic one: replaying a job that actually succeeded is then a no-op
 * rather than a second send.
 */

export interface FailedJob {
  readonly queueName: string;
  readonly id: string | undefined;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly opts: { attempts?: number };
}

export interface DeadLetterRecord {
  queue: string;
  jobId: string;
  workspaceId: string | null;
  payload: unknown;
  error: Record<string, unknown>;
  attempts: number;
}

export interface DeadLetterSink {
  /** Returns false when this failure was already recorded. */
  record(entry: DeadLetterRecord): Promise<boolean>;
}

export interface DeadLetterDeps {
  sink: DeadLetterSink;
  /** Wakes someone. Only called for queues marked critical. */
  page?: (input: { queue: string; jobId: string }) => Promise<void>;
  metrics?: { increment: (name: string, tags: Record<string, string>) => void };
  logger?: { error: (context: Record<string, unknown>, message: string) => void };
}

/**
 * Serialises an error for storage.
 *
 * Reconstructed rather than copied, in the same shape as the provider error
 * boundary (R22): a thrown object can carry a connection string, an
 * Authorization header, or a whole request. Only the name, a bounded message
 * and a bounded stack are kept, and the message goes through the caller's
 * scrubber if one is supplied.
 */
export function serialiseError(
  cause: unknown,
  redact: (text: string) => string = (text) => text,
): Record<string, unknown> {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: redact(cause.message).slice(0, 2000),
      // Enough to locate the throw, not enough to fill a jsonb column.
      stack: redact(cause.stack ?? '').slice(0, 4000),
    };
  }

  if (typeof cause === 'string') {
    return { name: 'Error', message: redact(cause).slice(0, 2000) };
  }

  // Never JSON.stringify an unknown object: that is how a credential hanging
  // off a thrown value ends up in the database.
  return { name: 'UnknownError', message: 'A non-Error value was thrown' };
}

/**
 * Handles a job that has failed.
 *
 * Returns true when a dead letter was written. A job with retries left writes
 * nothing — BullMQ will try it again, and recording every intermediate
 * failure would bury the final one.
 */
export async function handleFailedJob(
  job: FailedJob,
  cause: unknown,
  deps: DeadLetterDeps,
  redact?: (text: string) => string,
): Promise<boolean> {
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return false;

  // A job with no id cannot be replayed and cannot be deduplicated. Recording
  // it is still worth more than losing it.
  const jobId = job.id ?? `unidentified:${job.queueName}:${Date.now()}`;

  const written = await deps.sink.record({
    queue: job.queueName,
    jobId,
    workspaceId: workspaceIdOf(job.data),
    payload: job.data,
    error: serialiseError(cause, redact),
    attempts: job.attemptsMade,
  });

  deps.metrics?.increment('queue.dead_letter', { queue: job.queueName });
  deps.logger?.error(
    { queue: job.queueName, jobId, attempts: job.attemptsMade },
    'job dead-lettered',
  );

  // Paged only once per failure, and only for queues where silence is
  // expensive. Paging on a duplicate event is how a pager gets ignored.
  if (written && CRITICAL_QUEUES.has(job.queueName as QueueName)) {
    await deps.page?.({ queue: job.queueName, jobId });
  }

  return written;
}

/**
 * The workspace a job belonged to, if its payload says.
 *
 * Every payload in docs/04 that has a tenant carries `workspaceId`. One that
 * does not is a genuinely cross-tenant job, and null is the honest answer —
 * guessing would attribute someone else's failure to a workspace.
 */
export function workspaceIdOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const value = (payload as Record<string, unknown>)['workspaceId'];
  return typeof value === 'string' && value !== '' ? value : null;
}

export interface ReplayTarget {
  /** Re-enqueues with the original job id, so a succeeded job is a no-op. */
  enqueue(input: { queue: string; jobId: string; payload: unknown }): Promise<void>;
}

export interface ReplayableDeadLetter {
  id: string;
  queue: string;
  jobId: string;
  payload: unknown;
  status: string;
}

/**
 * Replays a dead letter.
 *
 * Refuses anything already replayed. Without that, an operator clicking twice
 * enqueues twice — and while the deterministic job id makes that harmless for
 * a job that already succeeded, it is not harmless for one that failed and is
 * now runnable again.
 */
export async function replayDeadLetter(
  entry: ReplayableDeadLetter,
  target: ReplayTarget,
  markReplayed: (id: string) => Promise<boolean>,
): Promise<{ replayed: boolean; reason?: string }> {
  if (entry.status === 'replayed') {
    return { replayed: false, reason: 'already replayed' };
  }
  if (entry.status === 'discarded') {
    return { replayed: false, reason: 'discarded' };
  }

  // Marked first. If the enqueue then fails the operator sees a replayed row
  // that did not run, which they can investigate — the other order risks a
  // job enqueued twice, which they cannot undo.
  const claimed = await markReplayed(entry.id);
  if (!claimed) return { replayed: false, reason: 'already replayed' };

  await target.enqueue({ queue: entry.queue, jobId: entry.jobId, payload: entry.payload });
  return { replayed: true };
}
