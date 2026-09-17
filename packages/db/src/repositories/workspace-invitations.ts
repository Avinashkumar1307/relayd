import { and, eq, isNull } from 'drizzle-orm';
import type { UserId, WorkspaceId, WorkspaceInvitationId } from '@relayd/types';
import { workspaceInvitations } from '../schema/identity.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

export type InvitableRole = 'admin' | 'editor' | 'viewer';

export interface InvitationRow {
  id: WorkspaceInvitationId;
  workspaceId: WorkspaceId;
  email: string;
  role: InvitableRole;
  invitedBy: UserId;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateInvitationInput {
  id: WorkspaceInvitationId;
  email: string;
  role: InvitableRole;
  /** sha256 of the emailed token. The token itself is never stored. */
  tokenHash: Buffer;
  invitedBy: UserId;
  expiresAt: Date;
}

export class WorkspaceInvitationRepository {
  constructor(private readonly db: Executor) {}

  /**
   * A partial unique index allows only one live invitation per address per
   * workspace, so a duplicate raises rather than quietly creating a second
   * token that also works.
   */
  async create(scope: WorkspaceScope, input: CreateInvitationInput): Promise<InvitationRow> {
    const [row] = await this.db
      .insert(workspaceInvitations)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        invitedBy: input.invitedBy,
        expiresAt: input.expiresAt,
      })
      .returning();

    if (row === undefined) throw new Error('createInvitation: insert returned no row');
    return toRow(row);
  }

  async findById(
    scope: WorkspaceScope,
    id: WorkspaceInvitationId,
  ): Promise<InvitationRow | null> {
    const [row] = await this.db
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.id, id),
          eq(workspaceInvitations.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  /** Pending only: accepted and revoked invitations are history, not offers. */
  async listPending(scope: WorkspaceScope): Promise<InvitationRow[]> {
    const rows = await this.db
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, scope.workspaceId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
        ),
      );

    return rows.map(toRow);
  }

  /**
   * Guarded: only a still-pending invitation can be revoked, so a revoke
   * racing an accept loses cleanly instead of overwriting the acceptance.
   */
  async revoke(scope: WorkspaceScope, id: WorkspaceInvitationId): Promise<boolean> {
    const rows = await this.db
      .update(workspaceInvitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(workspaceInvitations.id, id),
          eq(workspaceInvitations.workspaceId, scope.workspaceId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
        ),
      )
      .returning({ id: workspaceInvitations.id });

    return rows.length > 0;
  }

  /**
   * Guarded transition to accepted. Zero rows means someone else accepted or
   * revoked it first; the caller must treat that as a conflict rather than
   * granting membership anyway.
   */
  async markAccepted(scope: WorkspaceScope, id: WorkspaceInvitationId): Promise<boolean> {
    const rows = await this.db
      .update(workspaceInvitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(workspaceInvitations.id, id),
          eq(workspaceInvitations.workspaceId, scope.workspaceId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
        ),
      )
      .returning({ id: workspaceInvitations.id });

    return rows.length > 0;
  }
}

function toRow(row: typeof workspaceInvitations.$inferSelect): InvitationRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
