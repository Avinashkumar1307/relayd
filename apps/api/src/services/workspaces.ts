import { AppError } from '@relayd/types';
import type {
  Permission,
  UserId,
  WorkspaceId,
  WorkspaceInvitationId,
  WorkspaceMemberId,
  WorkspaceRole,
} from '@relayd/types';
import { generateToken, hashToken } from '@relayd/utils';
import { workspaceScope } from '@relayd/db';
import type { WorkspaceScope } from '@relayd/db';
import type { Repositories } from './auth.js';

/**
 * Workspace management: details, members, invitations.
 *
 * Authorization is NOT done here — the middleware has already established that
 * the caller holds the permission for the route (CLAUDE.md section 6.1:
 * controllers validate, services hold business logic). What lives here is the
 * business rule the permission check cannot express: that a workspace must
 * never be left without an owner.
 */

export type WorkspaceRepositories = Repositories;

export type WorkspaceUnitOfWork = <T>(
  fn: (repos: WorkspaceRepositories) => Promise<T>,
) => Promise<T>;

export interface WorkspaceNotifier {
  sendWorkspaceInvitation(to: string, workspaceName: string, token: string): Promise<void>;
}

export interface WorkspaceServiceOptions {
  unitOfWork: WorkspaceUnitOfWork;
  notifier: WorkspaceNotifier;
  newId: () => string;
  now: () => Date;
  invitationTtlDays?: number;
}

export interface MemberView {
  userId: UserId;
  role: WorkspaceRole;
  joinedAt: Date;
}

/** Roles an invitation may offer. Ownership transfers, it is not invited. */
export type InvitableRole = Exclude<WorkspaceRole, 'owner'>;

const DAY_MS = 24 * 60 * 60 * 1000;

export class WorkspaceService {
  constructor(private readonly options: WorkspaceServiceOptions) {}

  async get(scope: WorkspaceScope) {
    return this.options.unitOfWork(async (repos) => {
      const workspace = await repos.workspaces.findCurrent(scope);
      if (workspace === null) {
        throw new AppError('not_found', 'Workspace not found', 404);
      }
      return workspace;
    });
  }

  async updateDetails(scope: WorkspaceScope, patch: { name?: string; timezone?: string }) {
    return this.options.unitOfWork(async (repos) => {
      const updated = await repos.workspaces.updateDetails(scope, patch);
      if (updated === null) {
        throw new AppError('not_found', 'Workspace not found', 404);
      }
      return updated;
    });
  }

  async softDelete(scope: WorkspaceScope): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.workspaces.softDelete(scope))) {
        throw new AppError('not_found', 'Workspace not found', 404);
      }
    });
  }

  async listMembers(scope: WorkspaceScope): Promise<MemberView[]> {
    return this.options.unitOfWork(async (repos) => {
      const members = await repos.members.list(scope);
      return members.map((m) => ({ userId: m.userId, role: m.role, joinedAt: m.joinedAt }));
    });
  }

  /**
   * Changes a member's role.
   *
   * Refuses to demote the last owner. A workspace with no owner has nobody who
   * can manage billing or delete it, and no path back short of operator
   * intervention — the permission matrix cannot express that, so it lives
   * here.
   */
  async changeMemberRole(
    scope: WorkspaceScope,
    userId: UserId,
    role: WorkspaceRole,
  ): Promise<MemberView> {
    return this.options.unitOfWork(async (repos) => {
      const member = await repos.members.findByUser(scope, userId);
      if (member === null) {
        throw new AppError('not_found', 'Member not found', 404);
      }

      if (member.role === 'owner' && role !== 'owner') {
        await this.#assertNotLastOwner(repos, scope);
      }

      const updated = await repos.members.updateRole(scope, userId, role);
      if (updated === null) {
        throw new AppError('conflict', 'Member role could not be changed', 409);
      }

      return { userId: updated.userId, role: updated.role, joinedAt: updated.joinedAt };
    });
  }

  /** Removes a member. Refuses to remove the last owner, for the same reason. */
  async removeMember(scope: WorkspaceScope, userId: UserId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      const member = await repos.members.findByUser(scope, userId);
      if (member === null) {
        throw new AppError('not_found', 'Member not found', 404);
      }

      if (member.role === 'owner') {
        await this.#assertNotLastOwner(repos, scope);
      }

      if (!(await repos.members.remove(scope, userId))) {
        throw new AppError('conflict', 'Member could not be removed', 409);
      }
    });
  }

  /**
   * Invites an address to the workspace.
   *
   * The token is generated here, emailed, and stored only as a hash — so the
   * invitation link cannot be reconstructed from a database dump. Owner is not
   * an invitable role: ownership is transferred deliberately by an existing
   * owner, never handed out by email.
   */
  async invite(
    scope: WorkspaceScope,
    input: { email: string; role: InvitableRole; invitedBy: UserId; workspaceName: string },
  ): Promise<{ id: WorkspaceInvitationId; email: string; role: InvitableRole }> {
    const token = generateToken();

    const invitation = await this.options.unitOfWork(async (repos) => {
      // Nothing to offer someone who is already here, and the partial unique
      // index would reject a second live invitation anyway — better a clear
      // 409 than a constraint violation surfacing as a 500.
      const existingUser = await repos.users.findByEmail(input.email);
      if (existingUser !== null) {
        const member = await repos.members.findByUser(scope, existingUser.id);
        if (member !== null) {
          throw new AppError('conflict', 'That person is already a member', 409);
        }
      }

      return repos.invitations.create(scope, {
        id: this.options.newId() as WorkspaceInvitationId,
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: input.invitedBy,
        expiresAt: new Date(
          this.options.now().getTime() + (this.options.invitationTtlDays ?? 7) * DAY_MS,
        ),
      });
    });

    await this.options.notifier.sendWorkspaceInvitation(
      input.email,
      input.workspaceName,
      token,
    );

    return { id: invitation.id, email: invitation.email, role: invitation.role };
  }

  async listInvitations(scope: WorkspaceScope) {
    return this.options.unitOfWork((repos) => repos.invitations.listPending(scope));
  }

  async revokeInvitation(scope: WorkspaceScope, id: WorkspaceInvitationId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.invitations.revoke(scope, id))) {
        // Already accepted, already revoked, or never existed. All three are a
        // 404: distinguishing them would confirm invitation ids to a caller.
        throw new AppError('not_found', 'Invitation not found', 404);
      }
    });
  }

  /**
   * Accepts an invitation and creates the membership, in one transaction
   * (docs/03, "Transaction boundaries").
   *
   * The accepting user's address must match the invited address. The token
   * alone is a strong credential, but invitations get forwarded, and without
   * this check a forwarded link lets an unintended account into the workspace
   * while the audit trail records the original invitee.
   */
  async acceptInvitation(
    token: string,
    acceptingUser: { id: UserId; email: string },
  ): Promise<{ workspaceId: WorkspaceId; role: WorkspaceRole }> {
    return this.options.unitOfWork(async (repos) => {
      const invitation = await repos.globalInvitations.findLiveByTokenHash(hashToken(token));

      if (invitation === null) {
        throw new AppError('not_found', 'This invitation is no longer valid', 404);
      }

      if (invitation.email.toLowerCase() !== acceptingUser.email.toLowerCase()) {
        throw new AppError(
          'insufficient_permission',
          'This invitation was sent to a different address',
          403,
        );
      }

      const scope = workspaceScope(invitation.workspaceId);

      const already = await repos.members.findByUser(scope, acceptingUser.id);
      if (already !== null) {
        // Consume the invitation so it cannot be reused, but do not fail: the
        // user is where the link was trying to take them.
        await repos.invitations.markAccepted(scope, invitation.id);
        return { workspaceId: invitation.workspaceId, role: already.role };
      }

      // Guarded: zero rows means someone accepted or revoked it first.
      if (!(await repos.invitations.markAccepted(scope, invitation.id))) {
        throw new AppError('conflict', 'This invitation has already been used', 409);
      }

      await repos.members.create(scope, {
        id: this.options.newId() as WorkspaceMemberId,
        userId: acceptingUser.id,
        role: invitation.role,
      });

      return { workspaceId: invitation.workspaceId, role: invitation.role };
    });
  }

  async #assertNotLastOwner(
    repos: WorkspaceRepositories,
    scope: WorkspaceScope,
  ): Promise<void> {
    const owners = await repos.members.countByRole(scope, 'owner');
    if (owners <= 1) {
      throw new AppError(
        'unprocessable',
        'A workspace must always have at least one owner. Promote another member first.',
        422,
      );
    }
  }
}

/** Re-exported so routes can type their permission checks. */
export type { Permission };
