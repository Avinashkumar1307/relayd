import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { UserId, WorkspaceId } from '@relayd/types';
import { users, workspaces } from './identity.js';

/**
 * Scheduler and dead-letter tables, mirroring 0008_scheduler_and_dlq.sql.
 *
 * `scheduledJobs` is the reason BullMQ repeatable jobs are banned (R23): a
 * repeatable lives in Redis, and a flush loses every recurring job silently.
 */

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    name: text('name').primaryKey(),
    cron: text('cron').notNull(),
    queue: text('queue').notNull(),
    payload: jsonb('payload').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),

    lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }).notNull(),

    /** Claimed by one tick; expires so a dead scheduler needs no human. */
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    lockedBy: text('locked_by'),

    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  // Partial on `enabled`: the tick's query never looks at a disabled
  // schedule, and an operator who disables one expects it to cost nothing.
  (table) => [index('ix_scheduled_due').on(table.nextRunAt).where(sql`${table.enabled}`)],
);

export type DeadLetterStatus = 'new' | 'investigating' | 'replayed' | 'discarded';

export const jobDeadLetters = pgTable(
  'job_dead_letters',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull(),
    jobId: text('job_id').notNull(),

    /** Nullable: a job that failed before its payload was read belongs to nobody. */
    workspaceId: uuid('workspace_id')
      .references(() => workspaces.id, { onDelete: 'set null' })
      .$type<WorkspaceId>(),

    payload: jsonb('payload').notNull(),
    /** The scrubbed error, never the original object (R22). */
    error: jsonb('error').notNull(),
    attempts: smallint('attempts').notNull(),

    status: text('status').notNull().default('new').$type<DeadLetterStatus>(),
    replayedAt: timestamp('replayed_at', { withTimezone: true, mode: 'date' }),
    replayedBy: uuid('replayed_by')
      .references(() => users.id)
      .$type<UserId>(),
    notes: text('notes'),

    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex('uq_dl_job').on(table.queue, table.jobId, table.attempts),
    index('ix_dl_queue').on(table.queue, table.status, table.failedAt.desc()),
    // Both partial, as migration 0008 creates them. The predicates are the
    // point of these two: the operator console's default view is the
    // unreviewed letters, and the workspace lookup skips the global ones.
    index('ix_dl_new').on(table.failedAt.desc()).where(sql`${table.status} = 'new'`),
    index('ix_dl_workspace')
      .on(table.workspaceId, table.failedAt.desc())
      .where(sql`${table.workspaceId} IS NOT NULL`),
  ],
);
