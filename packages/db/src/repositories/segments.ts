import { and, eq } from 'drizzle-orm';
import type { SegmentId, WorkspaceId } from '@relayd/types';
import { segments } from '../schema/audience.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';
import { bindPlaceholders } from '../helpers.js';

export interface SegmentRow {
  id: SegmentId;
  workspaceId: WorkspaceId;
  name: string;
  definition: unknown;
  cachedCount: number | null;
  cachedAt: Date | null;
  createdAt: Date;
}

/**
 * A compiled segment, produced by @relayd/audience.
 *
 * The repository takes SQL it did not write, which is the one place in the
 * codebase that happens — so the contract is narrow and explicit: a boolean
 * expression over the alias `c`, plus its parameters in order. The compiler
 * guarantees every user value is a parameter; this layer executes it and
 * nothing else.
 */
export interface CompiledPreview {
  sql: string;
  params: unknown[];
  cap: number;
}

export class SegmentRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: { id: SegmentId; name: string; definition: unknown },
  ): Promise<SegmentRow> {
    const [row] = await this.db
      .insert(segments)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        name: input.name,
        definition: input.definition,
      })
      .returning();

    if (row === undefined) throw new Error('createSegment: insert returned no row');
    return toRow(row);
  }

  async list(scope: WorkspaceScope): Promise<SegmentRow[]> {
    const rows = await this.db
      .select()
      .from(segments)
      .where(eq(segments.workspaceId, scope.workspaceId));

    return rows.map(toRow);
  }

  async findById(scope: WorkspaceScope, id: SegmentId): Promise<SegmentRow | null> {
    const [row] = await this.db
      .select()
      .from(segments)
      .where(and(eq(segments.id, id), eq(segments.workspaceId, scope.workspaceId)))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  async update(
    scope: WorkspaceScope,
    id: SegmentId,
    patch: { name?: string; definition?: unknown },
  ): Promise<SegmentRow | null> {
    const [row] = await this.db
      .update(segments)
      .set({
        ...patch,
        // A changed definition invalidates the cached count; serving the old
        // one would show a number for a segment that no longer exists.
        ...(patch.definition === undefined ? {} : { cachedCount: null, cachedAt: null }),
        updatedAt: new Date(),
      })
      .where(and(eq(segments.id, id), eq(segments.workspaceId, scope.workspaceId)))
      .returning();

    return row === undefined ? null : toRow(row);
  }

  async remove(scope: WorkspaceScope, id: SegmentId): Promise<boolean> {
    const rows = await this.db
      .delete(segments)
      .where(and(eq(segments.id, id), eq(segments.workspaceId, scope.workspaceId)))
      .returning({ id: segments.id });

    return rows.length > 0;
  }

  /**
   * Runs a compiled preview count.
   *
   * The scope parameter is unused by the query itself — the compiler already
   * bound the workspace into every predicate — but it is still the first
   * parameter, because a repository method that silently did not need scope
   * would be the one place a reader stops checking for it.
   */
  async previewCount(
    scope: WorkspaceScope,
    compiled: CompiledPreview,
  ): Promise<{ count: number; capped: boolean }> {
    void scope;

    const result = await this.db.execute(bindPlaceholders(compiled.sql, compiled.params));
    const rows = (result as unknown as { rows: { matched: number }[] }).rows;
    const matched = rows[0]?.matched ?? 0;

    return { count: Math.min(matched, compiled.cap), capped: matched > compiled.cap };
  }

  async cacheCount(
    scope: WorkspaceScope,
    id: SegmentId,
    count: number,
  ): Promise<void> {
    await this.db
      .update(segments)
      .set({ cachedCount: count, cachedAt: new Date() })
      .where(and(eq(segments.id, id), eq(segments.workspaceId, scope.workspaceId)));
  }
}

function toRow(row: typeof segments.$inferSelect): SegmentRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    definition: row.definition,
    cachedCount: row.cachedCount,
    cachedAt: row.cachedAt,
    createdAt: row.createdAt,
  };
}
