import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runEntrypoint, type ProcessLike, type WorkerEntrypoint } from '../src/harness.js';

/**
 * Graceful shutdown with work in flight (BUILD-PLAN Phase 5 item 6).
 *
 * The requirement is "SIGTERM mid-job → job completes or is released, never
 * lost". Those are two different outcomes and both are acceptable; what is
 * not acceptable is a third, where the job is neither finished nor available
 * to be run again.
 *
 * Modelled with a consumer whose `stop()` behaves the way BullMQ's
 * `worker.close()` does: it stops accepting new jobs and waits for the active
 * ones. The "job" here writes to a ledger that stands in for Postgres, which
 * is where the durable truth actually lives.
 */

function fakeProcess() {
  const emitter = new EventEmitter();
  const exits: number[] = [];

  const proc: ProcessLike = {
    on: (signal, handler) => emitter.on(signal, handler),
    exit: (code) => {
      exits.push(code);
    },
  };

  return { proc, exits, raise: (signal: string) => emitter.emit(signal) };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
} as never;

/**
 * A consumer with one long job in flight.
 *
 * `outcome` is the ledger: 'claimed' while running, 'done' when the job
 * finished, 'released' when it was handed back. A job that is lost leaves it
 * on 'claimed', which is the failure this exists to detect.
 */
function consumerWithJobInFlight(options: { jobMs: number; releaseOnStop?: boolean }) {
  const ledger = { outcome: 'idle' as 'idle' | 'claimed' | 'done' | 'released' };
  let active: Promise<void> | null = null;

  const entrypoint: WorkerEntrypoint = {
    name: 'test',

    async start() {
      ledger.outcome = 'claimed';
      active = new Promise<void>((resolve) => {
        setTimeout(() => {
          // The job only reaches 'done' if it was allowed to finish.
          if (ledger.outcome === 'claimed') ledger.outcome = 'done';
          resolve();
        }, options.jobMs);
      });
    },

    async stop() {
      if (options.releaseOnStop === true) {
        // The other acceptable outcome: hand the job back so another worker
        // picks it up. A BullMQ worker does this by not extending the lock;
        // in Postgres it is a state transition back to pending.
        ledger.outcome = 'released';
        return;
      }

      // BullMQ's close(): stop accepting, wait for what is active.
      await active;
    },
  };

  return { entrypoint, ledger };
}

describe('SIGTERM with a job in flight', () => {
  it('lets the job finish before the process exits', async () => {
    const { proc, exits, raise } = fakeProcess();
    const { entrypoint, ledger } = consumerWithJobInFlight({ jobMs: 30 });

    await runEntrypoint({ entrypoint, logger, processRef: proc, shutdownTimeoutMs: 1000 });

    expect(ledger.outcome).toBe('claimed');
    raise('SIGTERM');

    // The drain is what waits; the process must not exit before it returns.
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(ledger.outcome).toBe('done');
  });

  it('does not exit while the job is still running', async () => {
    const { proc, exits, raise } = fakeProcess();
    const { entrypoint } = consumerWithJobInFlight({ jobMs: 60 });

    await runEntrypoint({ entrypoint, logger, processRef: proc, shutdownTimeoutMs: 1000 });
    raise('SIGTERM');

    // Immediately after the signal, nothing has exited.
    expect(exits).toEqual([]);
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  it('accepts a release instead of a completion', async () => {
    // Handing the job back is equally correct: another worker runs it.
    const { proc, exits, raise } = fakeProcess();
    const { entrypoint, ledger } = consumerWithJobInFlight({ jobMs: 500, releaseOnStop: true });

    await runEntrypoint({ entrypoint, logger, processRef: proc, shutdownTimeoutMs: 1000 });
    raise('SIGTERM');

    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(ledger.outcome).toBe('released');
  });

  it('never leaves the job neither done nor released', async () => {
    // The whole point. 'claimed' after shutdown is a lost job.
    for (const releaseOnStop of [false, true]) {
      const { proc, exits, raise } = fakeProcess();
      const { entrypoint, ledger } = consumerWithJobInFlight({
        jobMs: 20,
        ...(releaseOnStop ? { releaseOnStop } : {}),
      });

      await runEntrypoint({ entrypoint, logger, processRef: proc, shutdownTimeoutMs: 1000 });
      raise('SIGTERM');

      await vi.waitFor(() => expect(exits.length).toBe(1));
      expect(ledger.outcome, `releaseOnStop=${String(releaseOnStop)}`).not.toBe('claimed');
    }
  });

  it('exits non-zero when a job outruns the grace period, rather than pretending', async () => {
    // The drain timeout must stay below the orchestrator's, or the process is
    // killed mid-drain and this never runs (docs/10). Exiting 1 is what makes
    // the deploy visible as unclean instead of silently dropping work.
    const { proc, exits, raise } = fakeProcess();
    const { entrypoint, ledger } = consumerWithJobInFlight({ jobMs: 5000 });

    await runEntrypoint({ entrypoint, logger, processRef: proc, shutdownTimeoutMs: 30 });
    raise('SIGTERM');

    await vi.waitFor(() => expect(exits).toEqual([1]));
    // The job is still in flight, which is exactly why the exit code says so.
    expect(ledger.outcome).toBe('claimed');
  });

  it('drains once when SIGTERM arrives twice', async () => {
    // A second signal must not start a second drain and race the first.
    const { proc, exits, raise } = fakeProcess();
    let stops = 0;

    const entrypoint: WorkerEntrypoint = {
      name: 'test',
      async start() {},
      async stop() {
        stops += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    };

    await runEntrypoint({ entrypoint, logger, processRef: proc, shutdownTimeoutMs: 1000 });
    raise('SIGTERM');
    raise('SIGTERM');

    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(stops).toBe(1);
  });
});
