/**
 * One scheduler tick.
 *
 * The whole tick runs inside a single transaction that holds
 * `pg_try_advisory_xact_lock` (INVARIANTS R35). Three properties follow, and
 * each of them is the reason for a specific choice here:
 *
 *   *Exactly one scheduler acts.* The lock is taken first; a scheduler that
 *   does not get it does nothing and returns immediately. It does not wait —
 *   waiting would queue every instance behind the leader and turn a 60-second
 *   tick into a thundering herd when the leader is slow.
 *
 *   *A dead leader needs no intervention.* The lock is transaction-scoped, so
 *   it is released by the database when the connection dies. The next tick
 *   from any instance takes it. This is why the session-scoped variant is
 *   banned (CLAUDE.md §12): it survives the transaction and a crashed leader
 *   would hold it until someone noticed.
 *
 *   *No schedule is enqueued twice.* Reading due rows, enqueueing, and
 *   advancing `next_run_at` all commit together. A crash between enqueue and
 *   advance rolls back the advance, so the job is enqueued again — which the
 *   deterministic job id makes a no-op.
 *
 * Recurring work comes from `scheduled_jobs` rather than BullMQ repeatables
 * (R23): a repeatable lives in Redis, and a flush loses every schedule with
 * no error at all.
 */

/** Anything that can run a query inside the tick's transaction. */
export interface TickClient {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface DueJob {
  name: string;
  queue: string;
  payload: unknown;
  cron: string;
}

export interface TickEnqueuer {
  /**
   * Enqueues one due schedule.
   *
   * The job id is deterministic and derived from the schedule name and the
   * bucket it is due for, so the same tick running twice enqueues the same
   * job — which BullMQ deduplicates.
   */
  enqueue(input: {
    queue: string;
    jobId: string;
    name: string;
    payload: unknown;
  }): Promise<void>;
}

export interface TickOptions {
  client: TickClient;
  enqueuer: TickEnqueuer;
  /** Identifies this instance in `locked_by`, for an operator reading the table. */
  instanceId: string;
  /** Computes the next due time from a cron expression. */
  nextRun: (cron: string, after: Date) => Date;
  now?: () => Date;
  logger?: {
    info: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

export interface TickResult {
  /** False when another instance held the lock. */
  leader: boolean;
  enqueued: number;
  failed: number;
}

/**
 * A fixed key for the scheduler's advisory lock.
 *
 * A constant rather than a hash of a string: `pg_try_advisory_xact_lock` takes
 * a bigint, and a hash collision with some other advisory lock in the system
 * would silently serialise two unrelated things.
 */
export const SCHEDULER_LOCK_KEY = 4_070_100_001;

/**
 * Runs one tick.
 *
 * The caller opens the transaction and commits or rolls it back — this
 * function must not, because the point is that the lock spans the whole tick
 * and the lock is released by the transaction ending.
 */
export async function runTick(options: TickOptions): Promise<TickResult> {
  const now = options.now ?? ((): Date => new Date());
  const { client } = options;

  // Transaction-scoped, and non-blocking. An instance that loses the election
  // returns immediately rather than queueing behind the leader.
  const lock = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_xact_lock($1) AS acquired',
    [SCHEDULER_LOCK_KEY],
  );

  if (lock.rows[0]?.acquired !== true) {
    return { leader: false, enqueued: 0, failed: 0 };
  }

  const at = now();

  /**
   * Claims every due schedule in one statement.
   *
   * FOR UPDATE SKIP LOCKED is belt and braces under the advisory lock: it
   * costs nothing, and it means a future change that relaxes the election
   * cannot silently produce double enqueues.
   */
  const due = await client.query<DueJob>(
    `
    SELECT name, queue, payload, cron
    FROM scheduled_jobs
    WHERE enabled
      AND next_run_at <= $1
    ORDER BY next_run_at
    FOR UPDATE SKIP LOCKED
    `,
    [at],
  );

  let enqueued = 0;
  let failed = 0;

  for (const job of due.rows) {
    // The bucket the job is due for, to the minute. Two ticks in the same
    // minute produce the same job id, and BullMQ deduplicates the second.
    const bucket = at.toISOString().slice(0, 16);
    const jobId = `sched:${job.name}:${bucket}`;

    try {
      await options.enqueuer.enqueue({
        queue: job.queue,
        jobId,
        name: job.name,
        payload: job.payload,
      });

      await client.query(
        `
        UPDATE scheduled_jobs
        SET last_run_at = $2,
            next_run_at = $3,
            last_error = NULL,
            consecutive_failures = 0,
            locked_by = $4,
            updated_at = now()
        WHERE name = $1
        `,
        [job.name, at, options.nextRun(job.cron, at), options.instanceId],
      );

      enqueued += 1;
    } catch (cause) {
      failed += 1;

      /**
       * A failed enqueue still advances `next_run_at`.
       *
       * Leaving it in the past would make this schedule the only thing the
       * next tick sees, every tick, forever — one broken schedule would starve
       * every other one. The failure is recorded on the row instead, where an
       * operator can see it without reading logs.
       */
      await client.query(
        `
        UPDATE scheduled_jobs
        SET next_run_at = $2,
            last_error = $3,
            consecutive_failures = consecutive_failures + 1,
            updated_at = now()
        WHERE name = $1
        `,
        [
          job.name,
          options.nextRun(job.cron, at),
          (cause instanceof Error ? cause.message : 'enqueue failed').slice(0, 500),
        ],
      );

      options.logger?.error({ schedule: job.name, queue: job.queue }, 'schedule enqueue failed');
    }
  }

  if (enqueued > 0 || failed > 0) {
    options.logger?.info({ enqueued, failed }, 'scheduler tick');
  }

  return { leader: true, enqueued, failed };
}
