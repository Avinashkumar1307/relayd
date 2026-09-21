import { AppError } from '@relayd/types';
import type {
  Permission,
  UserId,
  WorkspaceId,
  WorkspaceInvitationId,
  WorkspaceMemberId,
  WorkspaceRole,
} from '@relayd/types';
import { generateToken, hashPassword, hashToken } from '@relayd/utils';
import { workspaceScope } from '@relayd/db';
import type { UserRow, WorkspaceScope } from '@relayd/db';
import type { Repositories } from './auth.js';
import { AUDIT_ACTIONS, buildAuditEntry, type Actor, type AuditContext } from './audit.js';
// The one relative-time renderer. J5's session list and J2a's "Last active"
// column describe the same kind of instant against the same clock, and two
// implementations of "2 hours ago" drift.
import { relativeLabel } from './profile.js';

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
  /**
   * Needed by the signed-out join path, which creates an account and so owes
   * it the same verification email registration sends. `Notifier` in
   * packages/notifications already implements both.
   */
  sendEmailVerification(to: string, token: string): Promise<void>;
}

/**
 * Audit actions for the workspace lifecycle beyond Phase 1's set.
 *
 * Kept next to the service that writes them rather than in `AUDIT_ACTIONS`
 * because that file belongs to another work stream this session; they follow
 * the same dotted resource.verb shape and should be folded in when the two
 * meet.
 */
export const AUDIT_ACTIONS_WORKSPACE = {
  workspaceCreated: 'workspace.created',
  invitationResent: 'invitation.resent',
  ownershipTransferred: 'workspace.ownership_transferred',
} as const;

export interface WorkspaceServiceOptions {
  unitOfWork: WorkspaceUnitOfWork;
  notifier: WorkspaceNotifier;
  newId: () => string;
  now: () => Date;
  invitationTtlDays?: number;
  /**
   * How long after an invitation email another one may be sent for the same
   * invitation. An hour: long enough that a mistyped click cannot mail-bomb
   * the invitee, short enough that "it never arrived, send it again" is not a
   * support ticket.
   */
  invitationResendCooldownMinutes?: number;
  /** Matches AuthService: the verification link outlives one sitting. */
  verificationTtlHours?: number;
  /**
   * Who is acting, and from where. Read per call rather than threaded through
   * every signature, so adding an audited action cannot forget the actor.
   */
  currentActor: () => Actor;
  currentContext?: () => AuditContext;
}

/**
 * One row of J2a's Team table.
 *
 * `name` and `email` are the Member and Email columns. They come from `users`
 * — a global table — because a membership is a role and a join date and
 * nothing a person is called. Without them the table draws a raw uuid in the
 * column a human is meant to recognise, and K3's "ask the Owner" cannot name
 * anyone.
 *
 * `lastActiveLabel` is rendered here, against this server's clock, for the
 * same reason J5's session list is: a browser twenty minutes fast would print
 * "in 20 minutes" for somebody who is signed in right now. It is omitted, not
 * blanked, for a member who has never signed in — the column draws an em dash
 * for absent and the string "null" for null.
 */
export interface MemberView {
  userId: UserId;
  role: WorkspaceRole;
  joinedAt: Date;
  name: string;
  email: string;
  lastActiveLabel?: string;
}

/** One row of J2a's pending-invitation table. */
export interface PendingInvitationView {
  id: WorkspaceInvitationId;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
  invitedByName?: string;
}

/**
 * J1's workspace card, editable half and read-only half.
 *
 * `role` is not here: it is the caller's, not the workspace's, and the route
 * adds it from the membership the middleware already resolved.
 */
export interface WorkspaceDetailsView {
  id: WorkspaceId;
  name: string;
  slug: string;
  timezone: string;
  /** ISO 8601. J1's "Created" row. */
  createdAt: string;
  /** The owner's display name, omitted when the account is gone. */
  createdByName?: string;
}

/** Roles an invitation may offer. Ownership transfers, it is not invited. */
export type InvitableRole = Exclude<WorkspaceRole, 'owner'>;

/** What B6a needs back to switch into the workspace it just created. */
export interface CreatedWorkspace {
  id: WorkspaceId;
  name: string;
  slug: string;
  timezone: string;
  role: WorkspaceRole;
}

/** What B5 renders before anyone has accepted anything. */
export interface InvitationPreview {
  workspaceName: string;
  workspaceMonogram: string;
  inviterName: string;
  invitedAt: Date;
  expiresAt: Date;
  role: WorkspaceRole;
  email: string;
}

/** The account created by the signed-out join path, and where it landed. */
export interface JoinedByInvitation {
  userId: UserId;
  email: string;
  workspaceId: WorkspaceId;
  role: WorkspaceRole;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "Northwind Voyages" → "NV".
 *
 * The same two letters `monogramFor` derives in the web app. Sent with the
 * invitation preview rather than derived in the browser so the signed-out
 * page has nothing to compute and the two never disagree about a name with
 * an unusual shape.
 */
export function workspaceMonogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter((word) => word !== '');
  const first = words[0]?.[0] ?? '';
  const second = words[1]?.[0] ?? '';
  return (words.length >= 2 ? `${first}${second}` : name.trim().slice(0, 2)).toUpperCase();
}

export class WorkspaceService {
  constructor(private readonly options: WorkspaceServiceOptions) {}

  /**
   * Creates a workspace and makes the caller its owner (B6a).
   *
   * Registration creates the first workspace as part of creating the account;
   * this is every one after that, so there is no user to create and no
   * session to issue — only the workspace, the owner membership and the audit
   * row, in one transaction.
   *
   * Scope is built from the new workspace's own id before the insert, exactly
   * as registration does it, which keeps creation inside the same RLS
   * discipline as every other write instead of being a special unscoped case.
   *
   * The slug is not checked for availability first. Two requests can both
   * read "free" and only one can insert; the partial unique index decides,
   * and a refused insert becomes a 409 naming the field.
   */
  async createWorkspace(input: {
    ownerUserId: UserId;
    name: string;
    slug: string;
    timezone?: string;
  }): Promise<CreatedWorkspace> {
    return this.options.unitOfWork(async (repos) => {
      const workspaceId = this.options.newId() as WorkspaceId;
      const scope = workspaceScope(workspaceId);

      const created = await repos.workspaces.createIfSlugAvailable(scope, {
        id: workspaceId,
        name: input.name,
        slug: input.slug,
        ownerUserId: input.ownerUserId,
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      });

      if (created === null) {
        throw new AppError('conflict', 'That workspace URL is already taken', 409, [
          { path: 'slug', message: 'That URL is already taken' },
        ]);
      }

      await repos.members.create(scope, {
        id: this.options.newId() as WorkspaceMemberId,
        userId: input.ownerUserId,
        role: 'owner',
      });

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS_WORKSPACE.workspaceCreated,
        resourceType: 'workspace',
        resourceId: workspaceId,
        after: { name: created.name, slug: created.slug, timezone: created.timezone },
        actor: { type: 'user', id: input.ownerUserId },
      });

      return {
        id: created.id,
        name: created.name,
        slug: created.slug,
        timezone: created.timezone,
        role: 'owner' as const,
      };
    });
  }

  async get(scope: WorkspaceScope) {
    return this.options.unitOfWork(async (repos) => {
      const workspace = await repos.workspaces.findCurrent(scope);
      if (workspace === null) {
        throw new AppError('not_found', 'Workspace not found', 404);
      }
      return workspace;
    });
  }

  /**
   * J1's workspace card, in one read.
   *
   * `get` answers the raw row and several callers want exactly that; this
   * answers what the page draws, including the owner's name, so the browser
   * does not have to fetch the member list to render the "Created by" line.
   */
  async details(scope: WorkspaceScope): Promise<WorkspaceDetailsView> {
    return this.options.unitOfWork(async (repos) => {
      const workspace = await repos.workspaces.findCurrent(scope);
      if (workspace === null) {
        throw new AppError('not_found', 'Workspace not found', 404);
      }
      return toDetailsView(workspace, await ownerName(repos, workspace.ownerUserId));
    });
  }

  async updateDetails(
    scope: WorkspaceScope,
    patch: { name?: string; timezone?: string },
  ): Promise<WorkspaceDetailsView> {
    return this.options.unitOfWork(async (repos) => {
      // Read first, so the audit row shows what actually changed rather than
      // only what was requested.
      const before = await repos.workspaces.findCurrent(scope);
      const updated = await repos.workspaces.updateDetails(scope, patch);
      if (updated === null) {
        throw new AppError('not_found', 'Workspace not found', 404);
      }

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS.workspaceUpdated,
        resourceType: 'workspace',
        resourceId: scope.workspaceId,
        before: before === null ? undefined : { name: before.name, timezone: before.timezone },
        after: { name: updated.name, timezone: updated.timezone },
      });

      // The same shape GET answers with. A PATCH that came back narrower
      // would leave the page holding a record missing the fields it had a
      // moment ago, and the read-only card below the form would empty out.
      return toDetailsView(updated, await ownerName(repos, updated.ownerUserId));
    });
  }

  async softDelete(scope: WorkspaceScope): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      const before = await repos.workspaces.findCurrent(scope);
      if (!(await repos.workspaces.softDelete(scope))) {
        throw new AppError('not_found', 'Workspace not found', 404);
      }

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS.workspaceDeleted,
        resourceType: 'workspace',
        resourceId: scope.workspaceId,
        before: before === null ? undefined : { name: before.name, status: before.status },
        after: { status: 'deleted' },
      });
    });
  }

  async listMembers(scope: WorkspaceScope): Promise<MemberView[]> {
    const now = this.options.now();

    return this.options.unitOfWork(async (repos) => {
      const members = await repos.members.list(scope);
      const people = await peopleByUserId(
        repos,
        members.map((m) => m.userId),
      );

      return members.map((m) => toMemberView(m, people.get(m.userId), now));
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
    const now = this.options.now();

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

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS.memberRoleChanged,
        resourceType: 'workspace_member',
        resourceId: userId,
        before: { role: member.role },
        after: { role: updated.role },
      });

      // The same row shape the list answers with: J2a writes the response
      // straight back into the table it came from, and a narrower row would
      // blank the Member and Email columns of whoever was just changed.
      return toMemberView(updated, await repos.users.findById(userId), now);
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

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS.memberRemoved,
        resourceType: 'workspace_member',
        resourceId: userId,
        before: { role: member.role },
      });
    });
  }

  /**
   * Hands ownership to another member, in one transaction.
   *
   * A workspace has exactly one owner: `workspaces.owner_user_id` names them
   * and their `workspace_members` row says `owner`. Both move together here —
   * promote the successor, demote the outgoing owner to admin, repoint the
   * workspace — so there is no instant at which the workspace has two owners
   * or none, and no path that leaves the pointer and the membership
   * disagreeing.
   *
   * The outgoing owner becomes an admin rather than being removed. Losing
   * ownership is not the same as leaving, and the alternative deletes a
   * membership nobody asked to delete.
   *
   * Authorization is the route's (owner-only), but the check is repeated here
   * against the membership row rather than the token: the caller's role is
   * re-read inside the transaction, so a demotion that commits first wins
   * over a transfer that started earlier.
   */
  async transferOwnership(
    scope: WorkspaceScope,
    input: { fromUserId: UserId; toUserId: UserId },
  ): Promise<{ previousOwner: MemberView; newOwner: MemberView }> {
    const now = this.options.now();

    return this.options.unitOfWork(async (repos) => {
      if (input.fromUserId === input.toUserId) {
        throw new AppError('unprocessable', 'That member is already the owner', 422);
      }

      const current = await repos.members.findByUser(scope, input.fromUserId);
      if (current === null || current.role !== 'owner') {
        throw new AppError(
          'insufficient_permission',
          'Only the workspace owner can transfer ownership',
          403,
        );
      }

      const successor = await repos.members.findByUser(scope, input.toUserId);
      if (successor === null) {
        throw new AppError('not_found', 'Member not found', 404);
      }

      // Guarded on who holds the pointer now: a second transfer that read the
      // same owner matches zero rows here rather than overwriting the first.
      if (
        !(await repos.workspaces.transferOwnership(scope, {
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
        }))
      ) {
        throw new AppError('conflict', 'Ownership has already been transferred', 409);
      }

      const promoted = await repos.members.updateRole(scope, input.toUserId, 'owner');
      const demoted = await repos.members.updateRole(scope, input.fromUserId, 'admin');

      if (promoted === null || demoted === null) {
        // Either row vanishing mid-transfer would leave the workspace without
        // an owner. Rolling the whole transaction back is the only safe
        // answer; the caller sees a conflict and can retry.
        throw new AppError('conflict', 'Ownership could not be transferred', 409);
      }

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS_WORKSPACE.ownershipTransferred,
        resourceType: 'workspace',
        resourceId: scope.workspaceId,
        before: { ownerUserId: input.fromUserId },
        after: { ownerUserId: input.toUserId, previousOwnerRole: demoted.role },
      });

      const people = await peopleByUserId(repos, [demoted.userId, promoted.userId]);

      return {
        previousOwner: toMemberView(demoted, people.get(demoted.userId), now),
        newOwner: toMemberView(promoted, people.get(promoted.userId), now),
      };
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
  ): Promise<{
    id: WorkspaceInvitationId;
    email: string;
    role: InvitableRole;
    /**
     * When the link dies. J2a lists it next to the pending row, and `resend`
     * already answers with it — an invitation that came back without one
     * would render "Expires undefined" on the row it just created.
     */
    expiresAt: Date;
  }> {
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

      const created = await repos.invitations.create(scope, {
        id: this.options.newId() as WorkspaceInvitationId,
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: input.invitedBy,
        expiresAt: new Date(
          this.options.now().getTime() + (this.options.invitationTtlDays ?? 7) * DAY_MS,
        ),
      });

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS.invitationCreated,
        resourceType: 'workspace_invitation',
        resourceId: created.id,
        // The address and role, never the token.
        after: { email: created.email, role: created.role },
      });

      return created;
    });

    await this.options.notifier.sendWorkspaceInvitation(
      input.email,
      input.workspaceName,
      token,
    );

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * The pending invitations, each with the name of whoever sent it.
   *
   * J2a's "Invited by" column is a person, not a uuid. The lookup is by id
   * against `users`, which is not workspace-scoped — but every id here came
   * from an invitation row inside the scope, so nothing is learned about
   * anybody the caller could not already see.
   */
  async listInvitations(scope: WorkspaceScope): Promise<PendingInvitationView[]> {
    return this.options.unitOfWork(async (repos) => {
      const pending = await repos.invitations.listPending(scope);
      const names = await namesByUserId(
        repos,
        pending.map((invitation) => invitation.invitedBy),
      );

      return pending.map((invitation) => {
        const invitedByName = names.get(invitation.invitedBy);
        return {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
          // Omitted rather than null when the inviter's account is gone: the
          // column renders an em dash for absent, and "null" for null.
          ...(invitedByName === undefined ? {} : { invitedByName }),
        };
      });
    });
  }

  async revokeInvitation(scope: WorkspaceScope, id: WorkspaceInvitationId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.invitations.revoke(scope, id))) {
        // Already accepted, already revoked, or never existed. All three are a
        // 404: distinguishing them would confirm invitation ids to a caller.
        throw new AppError('not_found', 'Invitation not found', 404);
      }

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS.invitationRevoked,
        resourceType: 'workspace_invitation',
        resourceId: id,
      });
    });
  }

  /**
   * Sends the invitation again, with a fresh token and a fresh expiry.
   *
   * Only the hash of a token is stored, so the original link cannot be
   * resent — a resend necessarily issues a new one. It replaces the old one
   * on the same invitation rather than creating a second invitation, so there
   * is never more than one working link for one offer and revoking the
   * invitation still kills all of them.
   *
   * At most one per cooldown, enforced by the guarded update rather than by a
   * counter here: two clicks a second apart send one email, not two. An
   * invitation that has already expired is always resendable — that is the
   * case the button exists for.
   */
  async resendInvitation(
    scope: WorkspaceScope,
    id: WorkspaceInvitationId,
    input: { workspaceName: string },
  ): Promise<{ id: WorkspaceInvitationId; email: string; role: InvitableRole; expiresAt: Date }> {
    const token = generateToken();
    const now = this.options.now();
    const ttlMs = (this.options.invitationTtlDays ?? 7) * DAY_MS;
    const cooldownMs = (this.options.invitationResendCooldownMinutes ?? 60) * MINUTE_MS;

    const invitation = await this.options.unitOfWork(async (repos) => {
      const existing = await repos.invitations.findById(scope, id);

      if (existing === null || existing.acceptedAt !== null || existing.revokedAt !== null) {
        // Accepted, revoked, never existed, or another workspace's. All four
        // are a 404: anything else confirms invitation ids to a caller.
        throw new AppError('not_found', 'Invitation not found', 404);
      }

      const resent = await repos.invitations.resendIfCooledDown(scope, id, {
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + ttlMs),
        resendableIfExpiringAtOrBefore: new Date(now.getTime() + ttlMs - cooldownMs),
      });

      if (resent === null) {
        throw new AppError(
          'rate_limited',
          'An invitation email was sent recently. Try again in a little while.',
          429,
        );
      }

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS_WORKSPACE.invitationResent,
        resourceType: 'workspace_invitation',
        resourceId: resent.id,
        // The address and the new expiry, never the token.
        after: { email: resent.email, role: resent.role, expiresAt: resent.expiresAt },
      });

      return resent;
    });

    await this.options.notifier.sendWorkspaceInvitation(
      invitation.email,
      input.workspaceName,
      token,
    );

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * What the invitation says, without accepting it (B5).
   *
   * Unauthenticated, because B5b renders for a visitor who has no account
   * yet. The token is the whole credential, which is why the lookup is by its
   * sha256 through a unique index — the stored value is a hash, so there is
   * no prefix to walk and no comparison whose duration depends on how much of
   * a guess was right.
   *
   * Expired, revoked, accepted and invented tokens all answer 404 with the
   * same sentence. Telling them apart would confirm to whoever is holding a
   * link that it was once real, and the page draws one "no longer valid"
   * state for all of them anyway.
   *
   * The invited address comes back. That is not a leak: the address is what
   * the token was mailed to, and B5b has to show which account the visitor is
   * about to create. Accepting still requires the signed-in address to match,
   * so a forwarded link reveals an address to someone the inviter already
   * trusted with it and grants them nothing.
   */
  async previewInvitation(token: string): Promise<InvitationPreview> {
    return this.options.unitOfWork(async (repos) => {
      const invitation = await repos.globalInvitations.previewByTokenHash(hashToken(token));

      if (invitation === null) {
        throw new AppError('not_found', 'This invitation is no longer valid', 404);
      }

      return {
        workspaceName: invitation.workspaceName,
        workspaceMonogram: workspaceMonogram(invitation.workspaceName),
        inviterName: invitation.inviterName,
        invitedAt: invitation.invitedAt,
        expiresAt: invitation.expiresAt,
        role: invitation.role,
        email: invitation.email,
      };
    });
  }

  /**
   * Creates the account the invitation is addressed to and joins the
   * workspace, in one transaction (B5b).
   *
   * docs/03 makes acceptance one transaction across the membership insert and
   * the invitation update; this adds the user to the same one. A half-done
   * version of this leaves either an account that owns nothing and cannot
   * reach the workspace it was created for, or a membership for a user row
   * that was rolled back.
   *
   * The address is the invitation's, never the client's. There is no email
   * field in the request for the same reason there is none on the form: the
   * token decides who this account is for.
   *
   * The address is not treated as verified. The invitation did arrive there,
   * but invitations get forwarded, and marking it verified would let whoever
   * was forwarded the link hold a confirmed account on somebody else's
   * address. They get the ordinary verification email instead.
   */
  async registerAndAcceptInvitation(
    token: string,
    input: { name: string; password: string },
  ): Promise<JoinedByInvitation> {
    // Hashing is deliberately outside the transaction: argon2id is slow by
    // design, and holding a transaction open across it would hold a
    // connection for the same hundreds of milliseconds.
    const passwordHash = await hashPassword(input.password);
    const verificationToken = generateToken();

    const joined = await this.options.unitOfWork(async (repos) => {
      const invitation = await repos.globalInvitations.findLiveByTokenHash(hashToken(token));

      if (invitation === null) {
        throw new AppError('not_found', 'This invitation is no longer valid', 404);
      }

      const existing = await repos.users.findByEmail(invitation.email);
      if (existing !== null) {
        // The same 409 registration gives, for the same reason: the person
        // has to be told to sign in instead, and B5b offers that link.
        throw new AppError(
          'conflict',
          'An account with that email already exists. Sign in to accept the invitation.',
          409,
        );
      }

      const userId = this.options.newId() as UserId;
      await repos.users.create({
        id: userId,
        email: invitation.email,
        name: input.name,
        passwordHash,
      });

      const scope = workspaceScope(invitation.workspaceId);

      // Guarded: zero rows means someone accepted or revoked it between the
      // lookup and here, and the account must not join on a dead invitation.
      if (!(await repos.invitations.markAccepted(scope, invitation.id))) {
        throw new AppError('conflict', 'This invitation has already been used', 409);
      }

      await repos.members.create(scope, {
        id: this.options.newId() as WorkspaceMemberId,
        userId,
        role: invitation.role,
      });

      await repos.userTokens.issue({
        id: this.options.newId(),
        userId,
        purpose: 'email_verification',
        tokenHash: hashToken(verificationToken),
        expiresAt: new Date(
          this.options.now().getTime() + (this.options.verificationTtlHours ?? 24) * HOUR_MS,
        ),
      });

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS.invitationAccepted,
        resourceType: 'workspace_member',
        resourceId: userId,
        after: { role: invitation.role, email: invitation.email, accountCreated: true },
        // The new account is the actor: nobody else was present, and the
        // ambient request context has no principal on an unauthenticated
        // route.
        actor: { type: 'user', id: userId },
      });

      return {
        userId,
        email: invitation.email,
        workspaceId: invitation.workspaceId,
        role: invitation.role as WorkspaceRole,
      };
    });

    // Outside the transaction: never hold one across a network call.
    await this.options.notifier.sendEmailVerification(joined.email, verificationToken);

    return joined;
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

      await this.auditWrite(repos, scope, {
        action: AUDIT_ACTIONS.invitationAccepted,
        resourceType: 'workspace_member',
        resourceId: acceptingUser.id,
        after: { role: invitation.role, email: acceptingUser.email },
      });

      return { workspaceId: invitation.workspaceId, role: invitation.role };
    });
  }

  /**
   * Writes one audit row inside the caller transaction.
   *
   * Same transaction as the action it records, so an action cannot commit
   * without its audit trail and an audit row cannot survive a rolled-back
   * action (docs/03, "Transaction boundaries").
   */
  private async auditWrite(
    repos: WorkspaceRepositories,
    scope: WorkspaceScope,
    entry: {
      action: string;
      resourceType: string;
      resourceId?: string;
      before?: unknown;
      after?: unknown;
      /**
       * Overrides the ambient actor. Needed by the unauthenticated join path,
       * where the request context holds no principal and the actor is the
       * account the same transaction is creating.
       */
      actor?: Actor;
    },
  ): Promise<void> {
    const { actor, ...rest } = entry;

    await repos.auditLogs.append(
      scope,
      buildAuditEntry({
        id: this.options.newId(),
        actor: actor ?? this.options.currentActor(),
        ...rest,
        ...(this.options.currentContext === undefined
          ? {}
          : { context: this.options.currentContext() }),
      }),
    );
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

/* ------------------------------------------------------------------ */
/* Reading people out of the global users table                        */
/* ------------------------------------------------------------------ */

/**
 * What `users` holds about the people named by a set of ids.
 *
 * The ids always come from rows already inside the caller's workspace — a
 * membership, an invitation's `invited_by`, the workspace's owner — so this
 * never widens what the caller can see. `users` carries no RLS because a
 * person is not owned by a tenant, which is exactly why the lookup has to be
 * anchored on ids that were themselves read under scope.
 *
 * Distinct ids only, and one pass: a six-seat workspace should not issue six
 * reads for the same admin who sent every invitation.
 */
async function peopleByUserId(
  repos: WorkspaceRepositories,
  userIds: readonly UserId[],
): Promise<Map<UserId, UserRow>> {
  const found = new Map<UserId, UserRow>();

  for (const userId of new Set(userIds)) {
    const user = await repos.users.findById(userId);
    if (user !== null) found.set(userId, user);
  }

  return found;
}

async function namesByUserId(
  repos: WorkspaceRepositories,
  userIds: readonly UserId[],
): Promise<Map<UserId, string>> {
  const people = await peopleByUserId(repos, userIds);
  return new Map([...people].map(([id, user]) => [id, user.name]));
}

async function ownerName(
  repos: WorkspaceRepositories,
  ownerUserId: UserId,
): Promise<string | undefined> {
  return (await repos.users.findById(ownerUserId))?.name;
}

function toDetailsView(
  workspace: { id: WorkspaceId; name: string; slug: string; timezone: string; createdAt: Date },
  createdByName: string | undefined,
): WorkspaceDetailsView {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    timezone: workspace.timezone,
    createdAt: workspace.createdAt.toISOString(),
    ...(createdByName === undefined ? {} : { createdByName }),
  };
}

/**
 * A membership row plus the person behind it.
 *
 * A missing user row is not an error: the membership is the record of who is
 * in the workspace, and it outlives a deleted account by however long the
 * deletion job takes. The row still draws, with the id in the name column,
 * rather than taking the whole table down.
 */
function toMemberView(
  member: { userId: UserId; role: WorkspaceRole; joinedAt: Date },
  user: UserRow | null | undefined,
  now: Date,
): MemberView {
  const lastLoginAt = user?.lastLoginAt ?? null;

  return {
    userId: member.userId,
    role: member.role,
    joinedAt: member.joinedAt,
    name: user?.name ?? member.userId,
    email: user?.email ?? '',
    ...(lastLoginAt === null ? {} : { lastActiveLabel: relativeLabel(lastLoginAt, now) }),
  };
}

/** Re-exported so routes can type their permission checks. */
export type { Permission };
