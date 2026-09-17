import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { ImportJobId, UserId, WorkspaceId } from '@relayd/types';
import { importJobs, importRowErrors } from '../schema/audience.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

export type ImportStatus =
  | 'pending'
  | 'mapping'
  | 'validating'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ImportJobRow {
  id: ImportJobId;
  workspaceId: WorkspaceId;
  originalFilename: string;
  fileType: 'csv' | 'tsv' | 'xlsx';
  status: ImportStatus;
  columnMapping: Record<string, string> | null;
  totalRows: number | null;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: Date;
  completedAt: Date | null;
}

export interface RowError {
  rowNumber: number;
  columnName?: string;
  errorCode: string;
  message: string;
  rawValue?: string;
}

/**
 * Per-import cap on stored row errors.
 *
 * A file where every row is malformed would otherwise write one error row per
 * input row — a 500,000-row import becoming a 500,000-row insert into a table
 * nobody will read past the first page. The count on the job stays
 * authoritative; this table holds the first N so the user can see the shape of
 * the problem.
 */
export const MAX_STORED_ROW_ERRORS = 1_000;

export class ImportJobRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: {
      id: ImportJobId;
      s3Key: string;
      originalFilename: string;
      byteSize: number;
      fileType: 'csv' | 'tsv' | 'xlsx';
      createdBy?: UserId;
      options?: Record<string, unknown>;
    },
  ): Promise<ImportJobRow> {
    const [row] = await this.db
      .insert(importJobs)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        s3Key: input.s3Key,
        originalFilename: input.originalFilename,
        byteSize: String(input.byteSize),
        fileType: input.fileType,
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
        ...(input.options === undefined ? {} : { options: input.options }),
      })
      .returning();

    if (row === undefined) throw new Error('createImport: insert returned no row');
    return toRow(row);
  }

  async findById(scope: WorkspaceScope, id: ImportJobId): Promise<ImportJobRow | null> {
    const [row] = await this.db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.id, id), eq(importJobs.workspaceId, scope.workspaceId)))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  async list(scope: WorkspaceScope, options: { limit?: number } = {}): Promise<ImportJobRow[]> {
    const rows = await this.db
      .select()
      .from(importJobs)
      .where(eq(importJobs.workspaceId, scope.workspaceId))
      .orderBy(desc(importJobs.createdAt))
      .limit(Math.min(Math.max(options.limit ?? 20, 1), 100));

    return rows.map(toRow);
  }

  /**
   * Guarded status transition.
   *
   * Zero rows means the job was not in a state this transition is legal from —
   * a cancelled import must not be dragged back into processing by a worker
   * that started before the cancellation landed. The caller exits cleanly on
   * false (CLAUDE.md section 9: "zero rows means exit cleanly").
   */
  /**
   * Records the column mapping and moves the job to `mapping`.
   *
   * Guarded on the current status like every other transition: a mapping
   * submitted twice, or submitted for a job already processing, must not
   * change what a running import is doing halfway through the file.
   */
  async setMapping(
    scope: WorkspaceScope,
    id: ImportJobId,
    mapping: Record<string, string>,
    options: Record<string, unknown>,
  ): Promise<boolean> {
    const rows = await this.db
      .update(importJobs)
      .set({ columnMapping: mapping, options, status: 'mapping' })
      .where(
        and(
          eq(importJobs.id, id),
          eq(importJobs.workspaceId, scope.workspaceId),
          sql`${importJobs.status} = ANY(${sql.param(['pending', 'mapping'])})`,
        ),
      )
      .returning({ id: importJobs.id });

    return rows.length > 0;
  }

  async transition(
    scope: WorkspaceScope,
    id: ImportJobId,
    from: readonly ImportStatus[],
    to: ImportStatus,
    fields: { totalRows?: number; startedAt?: Date; completedAt?: Date } = {},
  ): Promise<boolean> {
    const rows = await this.db
      .update(importJobs)
      .set({ status: to, ...fields })
      .where(
        and(
          eq(importJobs.id, id),
          eq(importJobs.workspaceId, scope.workspaceId),
          sql`${importJobs.status} = ANY(${sql.param(from)})`,
        ),
      )
      .returning({ id: importJobs.id });

    return rows.length > 0;
  }

  /**
   * Adds to the running counters.
   *
   * Relative rather than absolute, so two batches completing out of order
   * cannot lose one another's progress — the alternative is a read-modify-write
   * that races with itself.
   */
  async addProgress(
    scope: WorkspaceScope,
    id: ImportJobId,
    delta: {
      processed?: number;
      created?: number;
      updated?: number;
      skipped?: number;
      failed?: number;
    },
  ): Promise<void> {
    await this.db
      .update(importJobs)
      .set({
        processedRows: sql`${importJobs.processedRows} + ${delta.processed ?? 0}`,
        createdCount: sql`${importJobs.createdCount} + ${delta.created ?? 0}`,
        updatedCount: sql`${importJobs.updatedCount} + ${delta.updated ?? 0}`,
        skippedCount: sql`${importJobs.skippedCount} + ${delta.skipped ?? 0}`,
        failedCount: sql`${importJobs.failedCount} + ${delta.failed ?? 0}`,
      })
      .where(and(eq(importJobs.id, id), eq(importJobs.workspaceId, scope.workspaceId)));
  }

  /** Records row errors, bounded. Returns how many were actually stored. */
  async recordRowErrors(
    scope: WorkspaceScope,
    id: ImportJobId,
    errors: readonly RowError[],
  ): Promise<number> {
    if (errors.length === 0) return 0;

    const existing = await this.db
      .select({ id: importRowErrors.id })
      .from(importRowErrors)
      .where(
        and(
          eq(importRowErrors.importId, id),
          eq(importRowErrors.workspaceId, scope.workspaceId),
        ),
      )
      .limit(MAX_STORED_ROW_ERRORS);

    const room = MAX_STORED_ROW_ERRORS - existing.length;
    if (room <= 0) return 0;

    const batch = errors.slice(0, room);

    await this.db.insert(importRowErrors).values(
      batch.map((error) => ({
        workspaceId: scope.workspaceId,
        importId: id,
        rowNumber: error.rowNumber,
        errorCode: error.errorCode,
        message: error.message,
        ...(error.columnName === undefined ? {} : { columnName: error.columnName }),
        ...(error.rawValue === undefined ? {} : { rawValue: error.rawValue }),
      })),
    );

    return batch.length;
  }

  async listRowErrors(
    scope: WorkspaceScope,
    id: ImportJobId,
    options: { limit?: number } = {},
  ): Promise<(RowError & { createdAt: Date })[]> {
    const rows = await this.db
      .select()
      .from(importRowErrors)
      .where(
        and(
          eq(importRowErrors.importId, id),
          eq(importRowErrors.workspaceId, scope.workspaceId),
        ),
      )
      .orderBy(asc(importRowErrors.rowNumber))
      .limit(Math.min(Math.max(options.limit ?? 100, 1), MAX_STORED_ROW_ERRORS));

    return rows.map((row) => ({
      rowNumber: row.rowNumber,
      errorCode: row.errorCode,
      message: row.message,
      createdAt: row.createdAt,
      ...(row.columnName === null ? {} : { columnName: row.columnName }),
      ...(row.rawValue === null ? {} : { rawValue: row.rawValue }),
    }));
  }
}

function toRow(row: typeof importJobs.$inferSelect): ImportJobRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    originalFilename: row.originalFilename,
    fileType: row.fileType,
    status: row.status,
    columnMapping: (row.columnMapping as Record<string, string> | null) ?? null,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    skippedCount: row.skippedCount,
    failedCount: row.failedCount,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
