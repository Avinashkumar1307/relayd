import { and, eq, isNull } from 'drizzle-orm';
import type { UserId, WorkspaceId } from '@relayd/types';
import { workspaces } from '../schema/identity.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

export interface WorkspaceRow {
  id: WorkspaceId;
  name: string;
  slug: string;
  ownerUserId: UserId;
  status: 'active' | 'past_due' | 'suspended' | 'cancelled' | 'deleted';
  timezone: string;
  defaultCurrency: string;
  createdAt: Date;
}

export interface CreateWorkspaceInput {
  id: WorkspaceId;
  name: string;
  slug: string;
  ownerUserId: UserId;
  timezone?: string;
}

/**
 * Every method takes WorkspaceScope first (CLAUDE.md section 6.2), and every
 * query repeats the workspace predicate even though RLS already applies it.
 *
 * The duplication is deliberate. RLS is the backstop for a bug in the layers
 * above it; if the predicate lived only in the policy, a query run outside a
 * scoped transaction would return nothing and look like missing data rather
 * than a missing scope. With both, the intent is visible in the query.
 */
export class WorkspaceRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Creates the workspace the scope names.
   *
   * Scope is constructed from the new workspace's own id before the insert,
   * which keeps creation inside the same RLS discipline as everything else:
   * the policy's USING clause is applied as the INSERT check, so a row whose
   * id does not match the current scope is rejected by the database.
   */
  async create(scope: WorkspaceScope, input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    if (input.id !== scope.workspaceId) {
      throw new Error('createWorkspace: scope must name the workspace being created');
    }

    const [row] = await this.db
      .insert(workspaces)
      .values({
        id: input.id,
        name: input.name,
        slug: input.slug,
        ownerUserId: input.ownerUserId,
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      })
      .returning();

    if (row === undefined) throw new Error('createWorkspace: insert returned no row');
    return toRow(row);
  }

  async findById(scope: WorkspaceScope, id: WorkspaceId): Promise<WorkspaceRow | null> {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, id),
          eq(workspaces.id, scope.workspaceId),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  async findCurrent(scope: WorkspaceScope): Promise<WorkspaceRow | null> {
    return this.findById(scope, scope.workspaceId);
  }

  async updateDetails(
    scope: WorkspaceScope,
    patch: { name?: string; timezone?: string },
  ): Promise<WorkspaceRow | null> {
    const [row] = await this.db
      .update(workspaces)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(workspaces.id, scope.workspaceId), isNull(workspaces.deletedAt)))
      .returning();

    return row === undefined ? null : toRow(row);
  }

  /**
   * Soft delete. docs/02 lists workspaces among the tables carrying
   * deleted_at, and the slug uniqueness index is partial on deleted_at IS
   * NULL, so a deleted workspace releases its slug.
   */
  async softDelete(scope: WorkspaceScope): Promise<boolean> {
    const rows = await this.db
      .update(workspaces)
      .set({ deletedAt: new Date(), status: 'deleted', updatedAt: new Date() })
      .where(and(eq(workspaces.id, scope.workspaceId), isNull(workspaces.deletedAt)))
      .returning({ id: workspaces.id });

    return rows.length > 0;
  }
}

function toRow(row: typeof workspaces.$inferSelect): WorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerUserId: row.ownerUserId,
    status: row.status,
    timezone: row.timezone,
    defaultCurrency: row.defaultCurrency,
    createdAt: row.createdAt,
  };
}
