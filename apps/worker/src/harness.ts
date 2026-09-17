import type { Logger } from '@relayd/logger';

/**
 * A worker entrypoint: one process, one group of queue consumers.
 *
 * `stop` must let in-flight jobs finish rather than abandoning them. For a
 * BullMQ Worker that is `worker.close()`, which stops accepting new jobs and
 * waits for active ones. A job abandoned mid-flight is not lost — the
 * Postgres-side guards and the sweeper reclaim it (INVARIANTS R1, R3) — but
 * it costs a stall, and a deploy should not cost stalls.
 */
export interface WorkerEntrypoint {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * The two things the harness needs from the process: register a signal
 * handler, and exit with a code. Narrower than NodeJS.Process on purpose —
 * the real `process` satisfies it, and a test can too without pretending to
 * be the whole thing.
 */
export interface ProcessLike {
  on: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => unknown;
  exit: (code: number) => void;
}

export interface RunOptions {
  entrypoint: WorkerEntrypoint;
  logger: Logger;
  /**
   * How long to let in-flight work finish before giving up.
   *
   * Must stay below the orchestrator's grace period or the process is killed
   * mid-drain and the timeout never applies. ECS and Docker default to 30
   * seconds (docs/10), so this defaults to 25.
   */
  shutdownTimeoutMs?: number;
  /** Injected in tests; defaults to the real process. */
  processRef?: ProcessLike;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Starts an entrypoint and drains it on SIGTERM.
 *
 * SIGTERM arrives on every deploy. Without PID-1 signal forwarding it never
 * reaches Node at all and every deploy kills in-flight jobs after the Docker
 * grace period — which is why the image runs dumb-init (docs/10).
 */
export async function runEntrypoint(options: RunOptions): Promise<void> {
  const { entrypoint, logger } = options;
  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const proc = options.processRef ?? process;

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second SIGTERM must not start a second drain and race the first.
    if (shuttingDown) {
      logger.warn({ signal }, 'shutdown already in progress');
      return;
    }
    shuttingDown = true;
    logger.info({ signal, entrypoint: entrypoint.name }, 'draining in-flight jobs');

    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;

    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });

    try {
      const outcome = await Promise.race([entrypoint.stop().then(() => 'drained' as const), timedOut]);

      if (outcome === 'timeout') {
        logger.error(
          { entrypoint: entrypoint.name, timeoutMs },
          'drain timed out, exiting with in-flight work',
        );
        proc.exit(1);
        return;
      }

      logger.info(
        { entrypoint: entrypoint.name, durationMs: Date.now() - startedAt },
        'drained cleanly',
      );
      proc.exit(0);
    } catch (error) {
      logger.error({ err: error, entrypoint: entrypoint.name }, 'drain failed');
      proc.exit(1);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  proc.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  proc.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  logger.info({ entrypoint: entrypoint.name }, 'worker starting');
  await entrypoint.start();
  logger.info({ entrypoint: entrypoint.name }, 'worker started');
}
