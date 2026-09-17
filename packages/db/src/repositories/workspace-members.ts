import { and, eq } from 'drizzle-orm';
import type { UserId, WorkspaceId, WorkspaceMemberId } from '@relayd/types';
import { workspaceMembers } from '../schema/identity.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface MemberRow {
  id: WorkspaceMemberId;
  workspaceId: WorkspaceId;
  userId: UserId;
  role: WorkspaceRole;
  joinedAt: Date;
}

export interface CreateMemberInput {
  id: WorkspaceMemberId;
  userId: UserId;
  role: WorkspaceRole;
  invitedBy?: UserId;
}

export class WorkspaceMemberRepository {
  constructor(private readonly db: Executor) {}

  async create(scope: WorkspaceScope, input: CreateMemberInput): Promise<MemberRow> {
    const [row] = await this.db
      .insert(workspaceMembers)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        userId: input.userId,
        role: input.role,
        ...(input.invitedBy === undefined ? {} : { invitedBy: input.invitedBy }),
      })
      .returning();

    if (row === undefined) throw new Error('createMember: insert returned no row');
    return toRow(row);
  }

  /**
   * The membership lookup the auth middleware runs on every request.
   *
   * A null here is what produces a 404 rather than a 403: docs/06 is explicit
   * that a non-member must never learn that a workspace exists.
   */
  async findByUser(scope: WorkspaceScope, userId: UserId): Promise<MemberRow | null> {
    const [row] = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, scope.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  async list(scope: WorkspaceScope): Promise<MemberRow[]> {
    const rows = await this.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, scope.workspaceId));

    return rows.map(toRow);
  }

  async countByRole(scope: WorkspaceScope, role: WorkspaceRole): Promise<number> {
    const rows = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.role, role)),
      );

    return rows.length;
  }

  async updateRole(
    scope: WorkspaceScope,
    userId: UserId,
    role: WorkspaceRole,
  ): Promise<MemberRow | null> {
    const [row] = await this.db
      .update(workspaceMembers)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceMembers.workspaceId, scope.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning();

    return row === undefined ? null : toRow(row);
  }

  async remove(scope: WorkspaceScope, userId: UserId): Promise<boolean> {
    const rows = await this.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, scope.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning({ id: workspaceMembers.id });

    return rows.length > 0;
  }
}

function toRow(row: typeof workspaceMembers.$inferSelect): MemberRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role,
    joinedAt: row.joinedAt,
  };
}
