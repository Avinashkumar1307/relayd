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
  purpose: 'email_verification' | 'password_reset' | 'email_change';
  tokenHash: Buffer;
  expiresAt: Date;
  consumedAt: Date | null;
  /** Set on email_change rows only, matching the CHECK in migration 0019. */
  newEmail: string | null;
  createdAt: Date;
}

/**
 * @param clock The world's clock. Defaults to the frozen instant the existing
 *   suites are written against; a caller that needs to watch a cooldown
 *   expire passes its own and moves it, so the rows this world writes and the
 *   service reading them agree about what "now" is.
 */
export function buildWorld(clock: () => Date = () => new Date('2026-09-17T12:00:00Z')) {
  const users: FakeUser[] = [];
  const sessions: FakeSession[] = [];
  const tokens: FakeToken[] = [];
  /**
   * `timezone`, `status` and `createdAt` are optional so the dozen existing
   * suites that push `{ id, name, slug, ownerUserId }` keep compiling; the
   * fake fills them in on the way out, which is what a real row would do.
   */
  const workspaces: {
    id: WorkspaceId;
    name: string;
    slug: string;
    ownerUserId: UserId;
    timezone?: string;
    status?: 'active' | 'past_due' | 'suspended' | 'cancelled' | 'deleted';
    createdAt?: Date;
  }[] = [];
  const members: { workspaceId: WorkspaceId; userId: UserId; role: string; joinedAt: Date }[] = [];
  const invitations: FakeInvitation[] = [];
  const auditEntries: (Record<string, unknown> & { workspaceId: WorkspaceId })[] = [];
  const now = clock;

  /** A pushed workspace as a `WorkspaceRow`: every column the real one has. */
  const hydrate = (w: (typeof workspaces)[number]) => ({
    ...w,
    status: w.status ?? ('active' as const),
    timezone: w.timezone ?? 'UTC',
    defaultCurrency: 'USD',
    createdAt: w.createdAt ?? now(),
  });

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
      async updateName(id: UserId, name: string) {
        const u = users.find((x) => x.id === id && x.status !== 'deleted');
        if (u === undefined) return null;
        u.name = name;
        return u;
      },
      /**
       * Reports `taken` the way the partial unique index does, so a test can
       * exercise the race the service is written to survive.
       */
      async updateEmail(id: UserId, email: string) {
        const u = users.find((x) => x.id === id && x.status !== 'deleted');
        if (u === undefined) return 'not_found';
        if (users.some((x) => x.id !== id && x.email === email && x.status !== 'deleted')) {
          return 'taken';
        }
        u.email = email;
        u.emailVerifiedAt = now();
        return 'updated';
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
      async revokeAllForUserExcept(userId: UserId, keep: SessionId) {
        const hit = sessions.filter(
          (s) => s.userId === userId && s.id !== keep && s.revokedAt === null,
        );
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
      async issue(input: Omit<FakeToken, 'consumedAt' | 'newEmail' | 'createdAt'> & { newEmail?: string }) {
        tokens.push({
          ...input,
          newEmail: input.newEmail ?? null,
          consumedAt: null,
          // Advanced by a millisecond per row so "the latest one" is well
          // defined under the world's frozen clock.
          createdAt: new Date(now().getTime() + tokens.length),
        });
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
      async findLiveByHash(hash: Buffer) {
        return (
          tokens.find(
            (t) => t.tokenHash.equals(hash) && t.consumedAt === null && t.expiresAt > now(),
          ) ?? null
        );
      },
      async lastIssuedAt(userId: UserId, purpose: string) {
        const matching = tokens
          .filter((t) => t.userId === userId && t.purpose === purpose)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matching[0]?.createdAt ?? null;
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
          .map((m) => {
            const ws = workspaces.find((w) => w.id === m.workspaceId);
            return {
              workspaceId: m.workspaceId,
              workspaceName: ws?.name ?? '',
              workspaceSlug: ws?.slug ?? '',
              role: m.role,
            };
          });
      },
    } as unknown as Repositories['memberships'],

    workspaces: {
      async create(
        _scope: unknown,
        input: {
          id: WorkspaceId;
          name: string;
          slug: string;
          ownerUserId: UserId;
          timezone?: string;
        },
      ) {
        workspaces.push({
          id: input.id,
          name: input.name,
          slug: input.slug,
          ownerUserId: input.ownerUserId,
          timezone: input.timezone ?? 'UTC',
          status: 'active',
          createdAt: now(),
        });
        return { id: input.id } as never;
      },
      async createIfSlugAvailable(
        scope: { workspaceId: WorkspaceId },
        input: {
          id: WorkspaceId;
          name: string;
          slug: string;
          ownerUserId: UserId;
          timezone?: string;
        },
      ) {
        // The partial unique index, as the service sees it: a taken slug is
        // null, not a throw.
        if (workspaces.some((w) => w.slug === input.slug)) return null;
        const row = {
          id: input.id,
          name: input.name,
          slug: input.slug,
          ownerUserId: input.ownerUserId,
          timezone: input.timezone ?? 'UTC',
          status: 'active' as const,
          createdAt: now(),
        };
        workspaces.push(row);
        void scope;
        return { ...row, defaultCurrency: 'USD' };
      },
      async findCurrent(scope: { workspaceId: WorkspaceId }) {
        const w = workspaces.find((x) => x.id === scope.workspaceId);
        return w === undefined ? null : hydrate(w);
      },
      async findById(scope: { workspaceId: WorkspaceId }, id: WorkspaceId) {
        const w = workspaces.find((x) => x.id === id && x.id === scope.workspaceId);
        return w === undefined ? null : hydrate(w);
      },
      async updateDetails(
        scope: { workspaceId: WorkspaceId },
        patch: { name?: string; timezone?: string },
      ) {
        const w = workspaces.find((x) => x.id === scope.workspaceId);
        if (w === undefined) return null;
        if (patch.name !== undefined) w.name = patch.name;
        if (patch.timezone !== undefined) w.timezone = patch.timezone;
        return hydrate(w);
      },
      async transferOwnership(
        scope: { workspaceId: WorkspaceId },
        input: { fromUserId: UserId; toUserId: UserId },
      ) {
        const w = workspaces.find(
          (x) => x.id === scope.workspaceId && x.ownerUserId === input.fromUserId,
        );
        if (w === undefined) return false;
        w.ownerUserId = input.toUserId;
        return true;
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
        const m = members.find(
          (x) => x.workspaceId === scope.workspaceId && x.userId === userId,
        );
        return m === undefined ? null : { ...m };
      },
      async list(scope: { workspaceId: WorkspaceId }) {
        return members
          .filter((m) => m.workspaceId === scope.workspaceId)
          .map((m) => ({ ...m }));
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
        return { ...m };
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

    auditLogs: {
      async append(scope: { workspaceId: WorkspaceId }, entry: Record<string, unknown>) {
        auditEntries.push({ ...entry, workspaceId: scope.workspaceId, occurredAt: now() });
      },
      async list(scope: { workspaceId: WorkspaceId }) {
        return auditEntries.filter((e) => e.workspaceId === scope.workspaceId);
      },
    } as unknown as Repositories['auditLogs'],

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

  return { users, sessions, tokens, workspaces, members, invitations, auditEntries, repos, now };
}

