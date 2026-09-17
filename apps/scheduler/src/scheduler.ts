import type { DirectClient } from '@relayd/db';
import type { Logger } from '@relayd/logger';

export interface SchedulerOptions {
  client: DirectClient;
  logger: Logger;
}

/**
 * The leader-elected ticker.
 *
 * Phase 0 ships the process and its connection. The tick itself — reading
 * scheduled_jobs, computing due work, and taking pg_try_advisory_xact_lock
 * inside a transaction that spans the whole tick — is Phase 5 (INVARIANTS
 * R23, R35).
 *
 * Two constraints that shape this process and are worth stating before there
 * is any code to break them:
 *
 * Recurring work is driven from the scheduled_jobs table in Postgres, never
 * from BullMQ repeatable jobs (R23). Redis is transport; a flushed Redis must
 * not lose a schedule.
 *
 * The advisory lock must be the transaction-scoped _xact_ variant, never the
 * session-scoped one (CLAUDE.md section 12), and it is taken only from here,
 * over a direct connection.
 */
export class Scheduler {
  #started = false;

  constructor(private readonly options: SchedulerOptions) {}

  async start(): Promise<void> {
    await this.options.client.connect();
    // Proves the connection is live and usable before the process reports
    // itself started, rather than discovering it on the first tick.
    await this.options.client.query('SELECT 1');
    this.#started = true;
    this.options.logger.info('scheduler connected');
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    await this.options.client.end();
    this.options.logger.info('scheduler connection closed');
  }

  get started(): boolean {
    return this.#started;
  }
}
