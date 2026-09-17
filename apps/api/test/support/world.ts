import type { SessionId, UserId, WorkspaceId, WorkspaceInvitationId } from '@relayd/types';
import type { Repositories } from '../../src/services/auth.js';

/**
 * In-memory doubles, faithful on the parts that matter: every guarded update
 * returns whether it matched, because the service's correctness depends on
 * distinguishing "changed it" from "someone else already did".
 */
interface FakeUser {
  id: UserId;
  email: string;
  name: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  status: 'active' | 'suspended' | 'deleted';
  lastLoginAt: Date | null;
  createdAt: Date;
}

interface FakeSession {
  id: SessionId;
  userId: UserId;
  refreshTokenHash: Buffer;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  userAgent: string | null;
  ip: string | null;
  replacedBy: SessionId | null;
}

interface FakeInvitation {
  id: WorkspaceInvitationId;
  workspaceId: WorkspaceId;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  tokenHash: Buffer;
  invitedBy: UserId;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface FakeToken {
  id: string;
  userId: UserId;
  purpose: 'email_verification' | 'password_reset';
  tokenHash: Buffer;
  expiresAt: Date;
  consumedAt: Date | null;
}

export function buildWorld() {
  const users: FakeUser[] = [];
  const sessions: FakeSession[] = [];
  const tokens: FakeToken[] = [];
  const workspaces: { id: WorkspaceId; name: string; ownerUserId: UserId }[] = [];
  const members: { workspaceId: WorkspaceId; userId: UserId; role: string; joinedAt: Date }[] = [];
  const invitations: FakeInvitation[] = [];
  const now = () => new Date('2026-09-17T12:00:00Z');

  const repos: Repositories = {
    users: {
      async create(input: { id: UserId; email: string; name: string; passwordHash: string }) {
        const row: FakeUser = {
          id: input.id,
          email: input.email,
          name: input.name,
          passwordHash: input.passwordHash,
          emailVerifiedAt: null,
          status: 'active',
          lastLoginAt: null,
          createdAt: now(),
        };
        users.push(row);
        return row;
      },
      async findByEmail(email: string) {
        return users.find((u) => u.email === email && u.status !== 'deleted') ?? null;
      },
      async findById(id: UserId) {
        return users.find((u) => u.id === id && u.status !== 'deleted') ?? null;
      },
      async markEmailVerified(id: UserId) {
        const u = users.find((x) => x.id === id);
        if (u === undefined) return false;
        u.emailVerifiedAt = now();
        return true;
      },
      async updatePasswordHash(id: UserId, hash: string) {
        const u = users.find((x) => x.id === id);
        if (u === undefined) return false;
        u.passwordHash = hash;
        return true;
      },
      async recordLogin(id: UserId) {
        const u = users.find((x) => x.id === id);
        if (u !== undefined) u.lastLoginAt = now();
      },
    } as unknown as Repositories['users'],

    sessions: {
      async create(input: {
        id: SessionId;
        userId: UserId;
        refreshTokenHash: Buffer;
        familyId: string;
        expiresAt: Date;
        userAgent?: string;
        ip?: string;
      }) {
        const row: FakeSession = {
          id: input.id,
          userId: input.userId,
          refreshTokenHash: input.refreshTokenHash,
          familyId: input.familyId,
          expiresAt: input.expiresAt,
          revokedAt: null,
          createdAt: now(),
          userAgent: input.userAgent ?? null,
          ip: input.ip ?? null,
          replacedBy: null,
        };
        sessions.push(row);
        return row;
      },
      async findByRefreshTokenHash(hash: Buffer) {
        return sessions.find((s) => s.refreshTokenHash.equals(hash)) ?? null;
      },
      async listActiveForUser(userId: UserId) {
        return sessions.filter(
          (s) => s.userId === userId && s.revokedAt === null && s.expiresAt > now(),
        );
      },
      async revoke(id: SessionId) {
        const s = sessions.find((x) => x.id === id && x.revokedAt === null);
        if (s === undefined) return false;
        s.revokedAt = now();
        return true;
      },
      async revokeFamily(familyId: string) {
        const hit = sessions.filter((s) => s.familyId === familyId && s.revokedAt === null);
        for (const s of hit) s.revokedAt = now();
        return hit.length;
      },
      async revokeAllForUser(userId: UserId) {
        const hit = sessions.filter((s) => s.userId === userId && s.revokedAt === null);
        for (const s of hit) s.revokedAt = now();
        return hit.length;
      },
      async markReplacedBy(id: SessionId, successor: SessionId) {
        const s = sessions.find((x) => x.id === id);
        if (s !== undefined) {
          s.revokedAt = now();
          s.replacedBy = successor;
        }
      },
    } as unknown as Repositories['sessions'],

    userTokens: {
      async issue(input: Omit<FakeToken, 'consumedAt'>) {
        tokens.push({ ...input, consumedAt: null });
      },
      async findLive(hash: Buffer, purpose: string) {
        return (
          tokens.find(
            (t) =>
              t.tokenHash.equals(hash) &&
              t.purpose === purpose &&
              t.consumedAt === null &&
              t.expiresAt > now(),
          ) ?? null
        );
      },
      async consume(id: string) {
        const t = tokens.find((x) => x.id === id && x.consumedAt === null);
        if (t === undefined) return false;
        t.consumedAt = now();
        return true;
      },
      async consumeAllFor(userId: UserId, purpose: string) {
        const hit = tokens.filter(
          (t) => t.userId === userId && t.purpose === purpose && t.consumedAt === null,
        );
        for (const t of hit) t.consumedAt = now();
        return hit.length;
      },
    } as unknown as Repositories['userTokens'],

    memberships: {
      async listForUser(userId: UserId) {
        return members
          .filter((m) => m.userId === userId)
          .map((m) => ({
            workspaceId: m.workspaceId,
            workspaceName: '',
            workspaceSlug: '',
            role: m.role,
          }));
      },
    } as unknown as Repositories['memberships'],

    workspaces: {
      async create(_scope: unknown, input: { id: WorkspaceId; name: string; ownerUserId: UserId }) {
        workspaces.push({ id: input.id, name: input.name, ownerUserId: input.ownerUserId });
        return { id: input.id } as never;
      },
      async findCurrent(scope: { workspaceId: WorkspaceId }) {
        return workspaces.find((w) => w.id === scope.workspaceId) ?? null;
      },
      async findById(scope: { workspaceId: WorkspaceId }, id: WorkspaceId) {
        return workspaces.find((w) => w.id === id && w.id === scope.workspaceId) ?? null;
      },
      async updateDetails(
        scope: { workspaceId: WorkspaceId },
        patch: { name?: string; timezone?: string },
      ) {
        const w = workspaces.find((x) => x.id === scope.workspaceId);
        if (w === undefined) return null;
        if (patch.name !== undefined) w.name = patch.name;
        return w;
      },
      async softDelete(scope: { workspaceId: WorkspaceId }) {
        const index = workspaces.findIndex((w) => w.id === scope.workspaceId);
        if (index === -1) return false;
        workspaces.splice(index, 1);
        return true;
      },
    } as unknown as Repositories['workspaces'],

    members: {
      async create(scope: { workspaceId: WorkspaceId }, input: { id: string; userId: UserId; role: string }) {
        const row = { workspaceId: scope.workspaceId, userId: input.userId, role: input.role, joinedAt: now() };
        members.push(row);
        return row as never;
      },
      async findByUser(scope: { workspaceId: WorkspaceId }, userId: UserId) {
        return (
          members.find((m) => m.workspaceId === scope.workspaceId && m.userId === userId) ?? null
        );
      },
      async list(scope: { workspaceId: WorkspaceId }) {
        return members.filter((m) => m.workspaceId === scope.workspaceId);
      },
      async countByRole(scope: { workspaceId: WorkspaceId }, role: string) {
        return members.filter((m) => m.workspaceId === scope.workspaceId && m.role === role)
          .length;
      },
      async updateRole(scope: { workspaceId: WorkspaceId }, userId: UserId, role: string) {
        const m = members.find(
          (x) => x.workspaceId === scope.workspaceId && x.userId === userId,
        );
        if (m === undefined) return null;
        m.role = role;
        return m;
      },
      async remove(scope: { workspaceId: WorkspaceId }, userId: UserId) {
        const index = members.findIndex(
          (x) => x.workspaceId === scope.workspaceId && x.userId === userId,
        );
        if (index === -1) return false;
        members.splice(index, 1);
        return true;
      },
    } as unknown as Repositories['members'],

    invitations: {
      async create(
        scope: { workspaceId: WorkspaceId },
        input: {
          id: WorkspaceInvitationId;
          email: string;
          role: 'admin' | 'editor' | 'viewer';
          tokenHash: Buffer;
          invitedBy: UserId;
          expiresAt: Date;
        },
      ) {
        const row: FakeInvitation = {
          id: input.id,
          workspaceId: scope.workspaceId,
          email: input.email,
          role: input.role,
          tokenHash: input.tokenHash,
          invitedBy: input.invitedBy,
          expiresAt: input.expiresAt,
          acceptedAt: null,
          revokedAt: null,
          createdAt: now(),
        };
        invitations.push(row);
        return row;
      },
      async findById(scope: { workspaceId: WorkspaceId }, id: WorkspaceInvitationId) {
        return (
          invitations.find((i) => i.id === id && i.workspaceId === scope.workspaceId) ?? null
        );
      },
      async listPending(scope: { workspaceId: WorkspaceId }) {
        return invitations.filter(
          (i) =>
            i.workspaceId === scope.workspaceId && i.acceptedAt === null && i.revokedAt === null,
        );
      },
      async revoke(scope: { workspaceId: WorkspaceId }, id: WorkspaceInvitationId) {
        const i = invitations.find(
          (x) =>
            x.id === id &&
            x.workspaceId === scope.workspaceId &&
            x.acceptedAt === null &&
            x.revokedAt === null,
        );
        if (i === undefined) return false;
        i.revokedAt = now();
        return true;
      },
      async markAccepted(scope: { workspaceId: WorkspaceId }, id: WorkspaceInvitationId) {
        const i = invitations.find(
          (x) =>
            x.id === id &&
            x.workspaceId === scope.workspaceId &&
            x.acceptedAt === null &&
            x.revokedAt === null,
        );
        if (i === undefined) return false;
        i.acceptedAt = now();
        return true;
      },
    } as unknown as Repositories['invitations'],

    globalInvitations: {
      async findLiveByTokenHash(hash: Buffer) {
        const i = invitations.find(
          (x) =>
            x.tokenHash.equals(hash) &&
            x.acceptedAt === null &&
            x.revokedAt === null &&
            x.expiresAt > now(),
        );
        if (i === undefined) return null;
        const ws = workspaces.find((w) => w.id === i.workspaceId);
        return {
          id: i.id,
          workspaceId: i.workspaceId,
          workspaceName: ws?.name ?? '',
          email: i.email,
          role: i.role,
        };
      },
    } as unknown as Repositories['globalInvitations'],

  };

  return { users, sessions, tokens, workspaces, members, invitations, repos, now };
}

