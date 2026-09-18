import { asc, eq, sql } from 'drizzle-orm';
import { scheduledJobs } from '../../schema/scheduler.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * `scheduled_jobs` is deployment configuration, not tenant data: one row per
 * recurring job for the whole installation. The scheduler reads it over a
 * direct connection before any workspace exists (R35), so there is no scope
 * to take.
 *
 * The tick itself does not use this repository — it runs raw SQL inside the
 * transaction that holds the advisory lock, because the lock, the read, the
 * enqueue and the advance must all be the same transaction. This is for
 * seeding schedules at deploy and for the operator console.
 */

export interface ScheduledJobRow {
  name: string;
  cron: string;
  queue: string;
  payload: unknown;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date;
  lastError: string | null;
  consecutiveFailures: number;
}

export class GlobalScheduledJobRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Installs or updates a schedule.
   *
   * `next_run_at` is only set on insert. A deploy that changed the cron
   * expression must not also drag the next run backwards — that would fire
   * every schedule at once on every deploy, which for a nightly reconcile is
   * a real cost.
   */
  async upsert(input: {
    name: string;
    cron: string;
    queue: string;
    payload?: unknown;
    nextRunAt: Date;
    enabled?: boolean;
  }): Promise<void> {
    await this.db
      .insert(scheduledJobs)
      .values({
        name: input.name,
        cron: input.cron,
        queue: input.queue,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        nextRunAt: input.nextRunAt,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      })
      .onConflictDoUpdate({
        target: scheduledJobs.name,
        set: {
          cron: input.cron,
          queue: input.queue,
          ...(input.payload === undefined ? {} : { payload: input.payload }),
          updatedAt: new Date(),
        },
      });
  }

  async list(): Promise<ScheduledJobRow[]> {
    const rows = await this.db.select().from(scheduledJobs).orderBy(asc(scheduledJobs.name));
    return rows.map(toRow);
  }

  async findByName(name: string): Promise<ScheduledJobRow | null> {
    const [row] = await this.db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.name, name))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  /** Turns a schedule off without deleting it, so it can be turned back on. */
  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db
      .update(scheduledJobs)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(scheduledJobs.name, name))
      .returning({ name: scheduledJobs.name });

    return rows.length > 0;
  }

  /**
   * Makes a schedule due immediately.
   *
   * The operator's "run it now" button. Sets `next_run_at` to now rather than
   * enqueueing directly, so the run still goes through the leader-elected
   * tick and cannot produce a second copy alongside a scheduled one.
   */
  async runNow(name: string): Promise<boolean> {
    const rows = await this.db
      .update(scheduledJobs)
      .set({ nextRunAt: sql`now()`, updatedAt: new Date() })
      .where(eq(scheduledJobs.name, name))
      .returning({ name: scheduledJobs.name });

    return rows.length > 0;
  }
}

function toRow(row: typeof scheduledJobs.$inferSelect): ScheduledJobRow {
  return {
    name: row.name,
    cron: row.cron,
    queue: row.queue,
    payload: row.payload,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
  };
}
