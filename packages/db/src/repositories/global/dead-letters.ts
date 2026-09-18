import { and, desc, eq, sql } from 'drizzle-orm';
import type { UserId, WorkspaceId } from '@relayd/types';
import { jobDeadLetters } from '../../schema/scheduler.js';
import type { DeadLetterStatus } from '../../schema/scheduler.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * The dead-letter queue spans every workspace, and some of its rows belong to
 * none — a job that failed before its payload could be read has no workspace
 * id at all. An operator inspecting it is doing cross-tenant work by
 * definition, which is why this lives in `global/` as a named exception
 * rather than pretending to a scope it does not have.
 *
 * The table still has RLS, so a *tenant-scoped* connection reading it sees
 * only that workspace's failures. That is the useful default and it is not
 * what this repository is for: this one runs as the BYPASSRLS role from the
 * operator console, and every route that reaches it is behind an operator
 * check.
 */

export interface DeadLetterRow {
  id: string;
  queue: string;
  jobId: string;
  workspaceId: WorkspaceId | null;
  payload: unknown;
  error: unknown;
  attempts: number;
  status: DeadLetterStatus;
  replayedAt: Date | null;
  notes: string | null;
  failedAt: Date;
}

export class GlobalDeadLetterRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Records a failure.
   *
   * Returns false when this exact failure — same queue, same job, same
   * attempt count — is already recorded. BullMQ can emit `failed` more than
   * once for a job in some failure modes, and a duplicate row would page an
   * operator twice for one event.
   */
  async record(input: {
    id: string;
    queue: string;
    jobId: string;
    workspaceId: string | null;
    payload: unknown;
    error: unknown;
    attempts: number;
  }): Promise<boolean> {
    const rows = await this.db
      .insert(jobDeadLetters)
      .values({
        id: input.id,
        queue: input.queue,
        jobId: input.jobId,
        ...(input.workspaceId === null ? {} : { workspaceId: input.workspaceId as WorkspaceId }),
        payload: input.payload,
        error: input.error,
        attempts: input.attempts,
      })
      .onConflictDoNothing({
        target: [jobDeadLetters.queue, jobDeadLetters.jobId, jobDeadLetters.attempts],
      })
      .returning({ id: jobDeadLetters.id });

    return rows.length > 0;
  }

  async findById(id: string): Promise<DeadLetterRow | null> {
    const [row] = await this.db
      .select()
      .from(jobDeadLetters)
      .where(eq(jobDeadLetters.id, id))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  async list(
    options: { queue?: string; status?: DeadLetterStatus; limit?: number } = {},
  ): Promise<DeadLetterRow[]> {
    const rows = await this.db
      .select()
      .from(jobDeadLetters)
      .where(
        and(
          ...(options.queue === undefined ? [] : [eq(jobDeadLetters.queue, options.queue)]),
          ...(options.status === undefined ? [] : [eq(jobDeadLetters.status, options.status)]),
        ),
      )
      .orderBy(desc(jobDeadLetters.failedAt))
      .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));

    return rows.map(toRow);
  }

  /** Counts by queue and status, for the console's summary. */
  async summary(): Promise<{ queue: string; status: DeadLetterStatus; count: number }[]> {
    const rows = await this.db
      .select({
        queue: jobDeadLetters.queue,
        status: jobDeadLetters.status,
        count: sql<number>`count(*)::int`,
      })
      .from(jobDeadLetters)
      .groupBy(jobDeadLetters.queue, jobDeadLetters.status)
      .orderBy(jobDeadLetters.queue);

    return rows;
  }

  /**
   * Claims a row for replay.
   *
   * Guarded on the current status, so two operators clicking at once produce
   * one replay. Returns false for the loser, and for anything already
   * replayed or discarded.
   */
  async claimForReplay(id: string, replayedBy?: UserId): Promise<boolean> {
    const rows = await this.db
      .update(jobDeadLetters)
      .set({
        status: 'replayed',
        replayedAt: new Date(),
        ...(replayedBy === undefined ? {} : { replayedBy }),
      })
      .where(
        and(
          eq(jobDeadLetters.id, id),
          sql`${jobDeadLetters.status} = ANY(${sql.param(['new', 'investigating'])})`,
        ),
      )
      .returning({ id: jobDeadLetters.id });

    return rows.length > 0;
  }

  /**
   * Marks a row investigating or discarded.
   *
   * `replayed` is not settable here — it is set by claimForReplay, together
   * with the timestamp, so a row cannot say replayed without one.
   */
  async setStatus(
    id: string,
    status: 'investigating' | 'discarded',
    notes?: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(jobDeadLetters)
      .set({ status, ...(notes === undefined ? {} : { notes }) })
      .where(
        and(
          eq(jobDeadLetters.id, id),
          // A replayed row is history. Re-marking it would lose the fact that
          // it ran.
          sql`${jobDeadLetters.status} <> 'replayed'`,
        ),
      )
      .returning({ id: jobDeadLetters.id });

    return rows.length > 0;
  }
}

function toRow(row: typeof jobDeadLetters.$inferSelect): DeadLetterRow {
  return {
    id: row.id,
    queue: row.queue,
    jobId: row.jobId,
    workspaceId: row.workspaceId,
    payload: row.payload,
    error: row.error,
    attempts: row.attempts,
    status: row.status,
    replayedAt: row.replayedAt,
    notes: row.notes,
    failedAt: row.failedAt,
  };
}
