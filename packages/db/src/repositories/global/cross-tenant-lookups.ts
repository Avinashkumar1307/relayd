import { and, eq, gt, isNull } from 'drizzle-orm';
import type { UserId, WorkspaceId, WorkspaceInvitationId } from '@relayd/types';
import { users, workspaceInvitations, workspaceMembers, workspaces } from '../../schema/identity.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * Two lookups that cannot be workspace-scoped because they run BEFORE a
 * workspace is known. Both are narrow on purpose: each returns only what the
 * caller needs to establish scope, never workspace content.
 */

export interface MembershipSummary {
  workspaceId: WorkspaceId;
  workspaceName: string;
  workspaceSlug: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
}

export class GlobalMembershipRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Every workspace a user belongs to — the workspace switcher, and the set
   * the auth layer checks a requested workspace against.
   *
   * This is the query that decides 404 versus proceed. It spans tenants by
   * definition: asking "which workspaces may this user enter" cannot be
   * answered from inside one of them.
   *
   * Returns names and slugs only. A user learns nothing about a workspace
   * they are not a member of, because the join starts from their own
   * memberships.
   */
  async listForUser(userId: UserId): Promise<MembershipSummary[]> {
    const rows = await this.db
      .select({
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        workspaceSlug: workspaces.slug,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)));

    return rows;
  }

  /**
   * Whether a user may act in a workspace, and as what.
   *
   * The auth middleware calls this before scope exists, which is precisely
   * why it cannot take a WorkspaceScope: the scope is its output, not its
   * input.
   */
  async findMembership(
    userId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<MembershipSummary | null> {
    const [row] = await this.db
      .select({
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        workspaceSlug: workspaces.slug,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.workspaceId, workspaceId),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }
}

export interface PendingInvitation {
  id: WorkspaceInvitationId;
  workspaceId: WorkspaceId;
  workspaceName: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
}

/**
 * Everything the invitation page (B5) prints before anyone has signed in:
 * which workspace, which role, who sent it and when it runs out.
 */
export interface InvitationPreviewRow {
  workspaceId: WorkspaceId;
  workspaceName: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  inviterName: string;
  invitedAt: Date;
  expiresAt: Date;
}

export class GlobalInvitationRepository {
  constructor(private readonly db: Executor) {}

  /**
   * The same live-invitation lookup as `findLiveByTokenHash`, returning what
   * the page needs to render rather than what acceptance needs to act.
   *
   * Cross-tenant for the same reason: whoever holds the token is not a member
   * of anything yet, so there is no scope to look it up within.
   *
   * The `expires_at` predicate is deliberately repeated here rather than left
   * to the caller to interpret. An expired invitation and an invented token
   * must answer the same way, and the surest way to keep that true is for the
   * query to return nothing in both cases.
   */
  async previewByTokenHash(tokenHash: Buffer): Promise<InvitationPreviewRow | null> {
    const [row] = await this.db
      .select({
        workspaceId: workspaceInvitations.workspaceId,
        workspaceName: workspaces.name,
        email: workspaceInvitations.email,
        role: workspaceInvitations.role,
        inviterName: users.name,
        invitedAt: workspaceInvitations.createdAt,
        expiresAt: workspaceInvitations.expiresAt,
      })
      .from(workspaceInvitations)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
      .innerJoin(users, eq(users.id, workspaceInvitations.invitedBy))
      .where(
        and(
          eq(workspaceInvitations.tokenHash, tokenHash),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
          gt(workspaceInvitations.expiresAt, new Date()),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * Resolves an invitation token to the workspace it grants access to.
   *
   * Cross-tenant because the person holding the token is not yet a member of
   * anything — there is no scope to look it up within. The token hash is the
   * only credential, which is why it carries a unique index and why only
   * live, unexpired invitations are returned: an expired or revoked token
   * must be indistinguishable from an invalid one.
   */
  async findLiveByTokenHash(tokenHash: Buffer): Promise<PendingInvitation | null> {
    const [row] = await this.db
      .select({
        id: workspaceInvitations.id,
        workspaceId: workspaceInvitations.workspaceId,
        workspaceName: workspaces.name,
        email: workspaceInvitations.email,
        role: workspaceInvitations.role,
      })
      .from(workspaceInvitations)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
      .where(
        and(
          eq(workspaceInvitations.tokenHash, tokenHash),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
          gt(workspaceInvitations.expiresAt, new Date()),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }
}
