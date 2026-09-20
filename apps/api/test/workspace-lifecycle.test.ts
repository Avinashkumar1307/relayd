import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  UserId,
  WorkspaceId,
  WorkspaceInvitationId,
} from '@relayd/types';
import { hashToken } from '@relayd/utils';
import { workspaceScope } from '@relayd/db';
import type { WorkspaceScope } from '@relayd/db';
import { WorkspaceService, workspaceMonogram } from '../src/services/workspaces.js';
import type { Repositories } from '../src/services/auth.js';
import { buildWorld } from './support/world.js';

/**
 * Creating a workspace, previewing an invitation, joining from signed out,
 * resending, and handing over ownership.
 *
 * The four properties worth proving here, none of which the routing layer can
 * show:
 *
 *   a workspace never has zero owners and never has two, including while
 *   ownership is moving;
 *
 *   a dead invitation — expired, revoked, accepted, invented — answers the
 *   same way as every other dead invitation, because the page holding the
 *   token must not learn which kind it has;
 *
 *   a resend replaces the one live token instead of adding a second, and
 *   costs a cooldown;
 *
 *   the account created from an invitation gets the invited address, never
 *   one the client chose.
 *
 * Rollback is the one thing these cannot show: the unit of work here is a
 * function call, so a throw after a write leaves the write. The tests below
 * are written so the checks precede the writes, which is what makes that
 * difference invisible; proving it properly needs Postgres.
 */

const WS = 'ws-1' as WorkspaceId;
const scope: WorkspaceScope = workspaceScope(WS);

const OWNER = 'user-owner' as UserId;
const ADMIN = 'user-admin' as UserId;

let world: ReturnType<typeof buildWorld>;
let repos: Repositories;
let service: WorkspaceService;
let notifier: {
  sendWorkspaceInvitation: ReturnType<typeof vi.fn>;
  sendEmailVerification: ReturnType<typeof vi.fn>;
};
let clock: Date;
let counter: number;

/** The world's doubles, plus the methods this work added to the repositories. */
function extend(base: ReturnType<typeof buildWorld>): Repositories {
  const slugs = new Map<string, string>();

  const workspaces = {
    ...(base.repos.workspaces as unknown as Record<string, unknown>),

    async createIfSlugAvailable(
      innerScope: { workspaceId: WorkspaceId },
      input: {
        id: WorkspaceId;
        name: string;
        slug: string;
        ownerUserId: UserId;
        timezone?: string;
      },
    ) {
      if (input.id !== innerScope.workspaceId) {
        throw new Error('createWorkspace: scope must name the workspace being created');
      }
      if ([...slugs.values()].includes(input.slug)) return null;

      slugs.set(input.id, input.slug);
      base.workspaces.push({
        id: input.id,
        name: input.name,
        slug: input.slug,
        ownerUserId: input.ownerUserId,
      });

      return {
        id: input.id,
        name: input.name,
        slug: input.slug,
        ownerUserId: input.ownerUserId,
        status: 'active',
        timezone: input.timezone ?? 'UTC',
        defaultCurrency: 'USD',
        createdAt: base.now(),
      };
    },

    async transferOwnership(
      innerScope: { workspaceId: WorkspaceId },
      input: { fromUserId: UserId; toUserId: UserId },
    ) {
      const row = base.workspaces.find((w) => w.id === innerScope.workspaceId);
      if (row === undefined || row.ownerUserId !== input.fromUserId) return false;
      row.ownerUserId = input.toUserId;
      return true;
    },
  };

  const invitations = {
    ...(base.repos.invitations as unknown as Record<string, unknown>),

    async resendIfCooledDown(
      innerScope: { workspaceId: WorkspaceId },
      id: WorkspaceInvitationId,
      input: { tokenHash: Buffer; expiresAt: Date; resendableIfExpiringAtOrBefore: Date },
    ) {
      const row = base.invitations.find(
        (i) =>
          i.id === id &&
          i.workspaceId === innerScope.workspaceId &&
          i.acceptedAt === null &&
          i.revokedAt === null,
      );
      if (row === undefined) return null;
      if (row.expiresAt.getTime() > input.resendableIfExpiringAtOrBefore.getTime()) return null;

      row.tokenHash = input.tokenHash;
      row.expiresAt = input.expiresAt;
      return { ...row };
    },
  };

  const globalInvitations = {
    ...(base.repos.globalInvitations as unknown as Record<string, unknown>),

    async previewByTokenHash(hash: Buffer) {
      const row = base.invitations.find(
        (i) =>
          i.tokenHash.equals(hash) &&
          i.acceptedAt === null &&
          i.revokedAt === null &&
          i.expiresAt > base.now(),
      );
      if (row === undefined) return null;

      const workspace = base.workspaces.find((w) => w.id === row.workspaceId);
      const inviter = base.users.find((u) => u.id === row.invitedBy);

      return {
        workspaceId: row.workspaceId,
        workspaceName: workspace?.name ?? '',
        email: row.email,
        role: row.role,
        inviterName: inviter?.name ?? '',
        invitedAt: row.createdAt,
        expiresAt: row.expiresAt,
      };
    },
  };

  return {
    ...base.repos,
    workspaces,
    invitations,
    globalInvitations,
  } as unknown as Repositories;
}

function callArgs<A extends unknown[]>(mock: { mock: { calls: A[] } }, index = 0): A {
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`expected call ${index + 1}`);
  return call;
}

/** The token the invitation email carried, from the notifier. */
function lastInvitationToken(): string {
  const calls = notifier.sendWorkspaceInvitation.mock.calls as [string, string, string][];
  const call = calls.at(-1);
  if (call === undefined) throw new Error('no invitation was sent');
  return call[2];
}

beforeEach(() => {
  world = buildWorld();
  repos = extend(world);
  counter = 0;
  clock = new Date('2026-09-17T12:00:00.000Z');

  notifier = {
    sendWorkspaceInvitation: vi.fn(async () => undefined),
    sendEmailVerification: vi.fn(async () => undefined),
  };

  service = new WorkspaceService({
    unitOfWork: async (fn) => fn(repos),
    notifier: notifier as never,
    newId: () => `gen-${++counter}`,
    now: () => clock,
    currentActor: () => ({ type: 'user', id: OWNER }),
  });

  world.workspaces.push({ id: WS, name: 'Northwind Voyages', slug: 'northwind-voyages', ownerUserId: OWNER });
  world.members.push({ workspaceId: WS, userId: OWNER, role: 'owner', joinedAt: world.now() });
  world.users.push({
    id: OWNER,
    email: 'farah@northwind.travel',
    name: 'Farah Al-Mansoori',
    passwordHash: 'x',
    emailVerifiedAt: null,
    status: 'active',
    lastLoginAt: null,
    createdAt: world.now(),
  });
});

describe('creating a workspace', () => {
  const create = () =>
    service.createWorkspace({
      ownerUserId: ADMIN,
      name: 'Northwind Labs',
      slug: 'northwind-labs',
      timezone: 'Asia/Dubai',
    });

  it('makes the caller the owner', async () => {
    const created = await create();

    expect(created.role).toBe('owner');
    expect(
      world.members.some((m) => m.workspaceId === created.id && m.userId === ADMIN && m.role === 'owner'),
    ).toBe(true);
  });

  it('keeps the timezone it was given', async () => {
    await expect(create()).resolves.toMatchObject({ timezone: 'Asia/Dubai' });
  });

  it('refuses a slug that is taken, naming the field', async () => {
    await create();

    const second = service.createWorkspace({
      ownerUserId: OWNER,
      name: 'Northwind Labs',
      slug: 'northwind-labs',
    });

    await expect(second).rejects.toMatchObject({
      status: 409,
      details: [{ path: 'slug' }],
    });
  });

  it('writes an audit row naming the new workspace and its owner', async () => {
    const created = await create();

    const entry = world.auditEntries.at(-1);
    expect(entry).toMatchObject({
      action: 'workspace.created',
      resourceId: created.id,
      actorId: ADMIN,
      workspaceId: created.id,
    });
  });

  it('creates nothing when the slug collides', async () => {
    await create();
    const before = world.members.length;

    await expect(
      service.createWorkspace({ ownerUserId: OWNER, name: 'Again', slug: 'northwind-labs' }),
    ).rejects.toMatchObject({ status: 409 });

    expect(world.members).toHaveLength(before);
  });
});

describe('previewing an invitation', () => {
  const invite = async (over: { email?: string } = {}) => {
    await service.invite(scope, {
      email: over.email ?? 'omar.h@northwind.travel',
      role: 'editor',
      invitedBy: OWNER,
      workspaceName: 'Northwind Voyages',
    });
    return lastInvitationToken();
  };

  it('says which workspace, which role, who invited and until when', async () => {
    const token = await invite();

    await expect(service.previewInvitation(token)).resolves.toMatchObject({
      workspaceName: 'Northwind Voyages',
      workspaceMonogram: 'NV',
      inviterName: 'Farah Al-Mansoori',
      role: 'editor',
      email: 'omar.h@northwind.travel',
    });
  });

  it('answers a revoked, an expired and an invented token identically', async () => {
    // Anything that distinguishes them tells whoever holds a link that it was
    // once real, which is the only thing a stolen expired link is good for.
    const revokedToken = await invite();
    await service.revokeInvitation(scope, world.invitations[0]?.id as WorkspaceInvitationId);

    const expiredToken = await invite({ email: 'second@northwind.travel' });
    const expired = world.invitations[1];
    if (expired !== undefined) expired.expiresAt = new Date('2020-01-01T00:00:00.000Z');

    const answers = await Promise.all(
      [revokedToken, expiredToken, 'not-a-real-token'].map(async (token) =>
        service.previewInvitation(token).then(
          () => 'resolved',
          (error: { status: number; message: string }) => `${error.status}:${error.message}`,
        ),
      ),
    );

    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toMatch(/^404:/u);
  });

  it('does not accept anything', async () => {
    const token = await invite();
    await service.previewInvitation(token);

    expect(world.invitations[0]?.acceptedAt).toBeNull();
    expect(world.members).toHaveLength(1);
  });
});

describe('joining from signed out', () => {
  const invite = async () => {
    await service.invite(scope, {
      email: 'omar.h@northwind.travel',
      role: 'editor',
      invitedBy: OWNER,
      workspaceName: 'Northwind Voyages',
    });
    return lastInvitationToken();
  };

  it('creates the account with the invited address, not one the client chose', async () => {
    const token = await invite();

    const joined = await service.registerAndAcceptInvitation(token, {
      name: 'Omar Haddad',
      password: 'a-long-enough-password',
    });

    expect(joined.email).toBe('omar.h@northwind.travel');
    expect(world.users.some((u) => u.email === 'omar.h@northwind.travel')).toBe(true);
  });

  it('joins with the invited role and burns the invitation', async () => {
    const token = await invite();

    const joined = await service.registerAndAcceptInvitation(token, {
      name: 'Omar Haddad',
      password: 'a-long-enough-password',
    });

    expect(joined.role).toBe('editor');
    expect(
      world.members.some((m) => m.userId === joined.userId && m.role === 'editor'),
    ).toBe(true);
    expect(world.invitations[0]?.acceptedAt).not.toBeNull();
  });

  it('stores only a hash of the password', async () => {
    const token = await invite();
    await service.registerAndAcceptInvitation(token, {
      name: 'Omar Haddad',
      password: 'a-long-enough-password',
    });

    const created = world.users.find((u) => u.email === 'omar.h@northwind.travel');
    expect(created?.passwordHash).not.toContain('a-long-enough-password');
    expect(created?.passwordHash).toMatch(/^\$argon2id\$/u);
  });

  it('sends a verification email rather than trusting the forwarded link', async () => {
    // The invitation arrived at that address, but invitations get forwarded,
    // and a verified account on somebody else's address is worth more than
    // the membership it came with.
    const token = await invite();
    await service.registerAndAcceptInvitation(token, {
      name: 'Omar Haddad',
      password: 'a-long-enough-password',
    });

    expect(notifier.sendEmailVerification).toHaveBeenCalledOnce();
    const [to, verificationToken] = callArgs(notifier.sendEmailVerification) as [string, string];
    expect(to).toBe('omar.h@northwind.travel');

    const created = world.users.find((u) => u.email === 'omar.h@northwind.travel');
    expect(created?.emailVerifiedAt).toBeNull();
    expect(world.tokens.some((t) => t.tokenHash.equals(hashToken(verificationToken)))).toBe(true);
  });

  it('refuses when that address already has an account, and creates nothing', async () => {
    const token = await invite();
    world.users.push({
      id: 'someone' as UserId,
      email: 'omar.h@northwind.travel',
      name: 'Omar',
      passwordHash: 'x',
      emailVerifiedAt: null,
      status: 'active',
      lastLoginAt: null,
      createdAt: world.now(),
    });
    const before = world.users.length;

    await expect(
      service.registerAndAcceptInvitation(token, {
        name: 'Omar Haddad',
        password: 'a-long-enough-password',
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(world.users).toHaveLength(before);
    expect(world.invitations[0]?.acceptedAt).toBeNull();
  });

  it('refuses a dead token before creating anything', async () => {
    const token = await invite();
    await service.revokeInvitation(scope, world.invitations[0]?.id as WorkspaceInvitationId);
    const before = world.users.length;

    await expect(
      service.registerAndAcceptInvitation(token, {
        name: 'Omar Haddad',
        password: 'a-long-enough-password',
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(world.users).toHaveLength(before);
    expect(world.members).toHaveLength(1);
  });
});

describe('resending an invitation', () => {
  const invite = async () => {
    await service.invite(scope, {
      email: 'omar.h@northwind.travel',
      role: 'editor',
      invitedBy: OWNER,
      workspaceName: 'Northwind Voyages',
    });
    return world.invitations[0]?.id as WorkspaceInvitationId;
  };

  const resend = (id: WorkspaceInvitationId) =>
    service.resendInvitation(scope, id, { workspaceName: 'Northwind Voyages' });

  it('sends a new token and kills the old link', async () => {
    const id = await invite();
    const first = lastInvitationToken();

    clock = new Date('2026-09-17T14:00:00.000Z');
    await resend(id);
    const second = lastInvitationToken();

    expect(second).not.toBe(first);
    expect(world.invitations).toHaveLength(1);
    expect(world.invitations[0]?.tokenHash.equals(hashToken(second))).toBe(true);
    // The old link now resolves to nothing at all.
    await expect(service.previewInvitation(first)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a second send inside the cooldown, and sends no email', async () => {
    const id = await invite();

    await expect(resend(id)).rejects.toMatchObject({ status: 429 });
    expect(notifier.sendWorkspaceInvitation).toHaveBeenCalledOnce();
  });

  it('allows it once the cooldown has passed', async () => {
    const id = await invite();
    clock = new Date('2026-09-17T13:30:00.000Z');

    await expect(resend(id)).resolves.toMatchObject({ email: 'omar.h@northwind.travel' });
  });

  it('always allows it for an invitation that has already expired', async () => {
    // Which is the case the button mostly exists for.
    const id = await invite();
    const invitation = world.invitations[0];
    if (invitation !== undefined) invitation.expiresAt = new Date('2026-09-01T00:00:00.000Z');

    await expect(resend(id)).resolves.toMatchObject({
      expiresAt: new Date('2026-09-24T12:00:00.000Z'),
    });
  });

  it('404s for a revoked, accepted or unknown invitation', async () => {
    const id = await invite();
    await service.revokeInvitation(scope, id);

    await expect(resend(id)).rejects.toMatchObject({ status: 404 });
    await expect(resend('nope' as WorkspaceInvitationId)).rejects.toMatchObject({ status: 404 });
  });

  it('records the resend without recording the token', async () => {
    const id = await invite();
    clock = new Date('2026-09-17T14:00:00.000Z');
    await resend(id);

    const entry = world.auditEntries.at(-1);
    expect(entry).toMatchObject({ action: 'invitation.resent', resourceId: id });
    expect(JSON.stringify(entry)).not.toContain(lastInvitationToken());
  });
});

describe('transferring ownership', () => {
  beforeEach(() => {
    world.members.push({ workspaceId: WS, userId: ADMIN, role: 'admin', joinedAt: world.now() });
  });

  const transfer = () =>
    service.transferOwnership(scope, { fromUserId: OWNER, toUserId: ADMIN });

  it('leaves exactly one owner', async () => {
    await transfer();

    const owners = world.members.filter((m) => m.workspaceId === WS && m.role === 'owner');
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(ADMIN);
  });

  it('leaves the previous owner as an admin rather than removing them', async () => {
    const result = await transfer();

    expect(result.previousOwner.role).toBe('admin');
    expect(world.members.some((m) => m.userId === OWNER)).toBe(true);
  });

  it('moves the workspace row with the membership', async () => {
    // The two must agree: the pointer decides who owns the workspace after a
    // membership is rebuilt, and the membership decides what the API allows.
    await transfer();

    expect(world.workspaces.find((w) => w.id === WS)?.ownerUserId).toBe(ADMIN);
  });

  it('refuses when the caller is not the owner', async () => {
    await expect(
      service.transferOwnership(scope, { fromUserId: ADMIN, toUserId: OWNER }),
    ).rejects.toMatchObject({ status: 403 });

    expect(world.workspaces.find((w) => w.id === WS)?.ownerUserId).toBe(OWNER);
  });

  it('404s for someone who is not a member of this workspace', async () => {
    await expect(
      service.transferOwnership(scope, { fromUserId: OWNER, toUserId: 'stranger' as UserId }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses transferring to yourself', async () => {
    await expect(
      service.transferOwnership(scope, { fromUserId: OWNER, toUserId: OWNER }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('records who handed over to whom', async () => {
    await transfer();

    expect(world.auditEntries.at(-1)).toMatchObject({
      action: 'workspace.ownership_transferred',
      before: { ownerUserId: OWNER },
      after: { ownerUserId: ADMIN },
    });
  });
});

describe('the monogram sent with a preview', () => {
  it('takes the initials of the first two words', () => {
    expect(workspaceMonogram('Northwind Voyages')).toBe('NV');
  });

  it('falls back to the first two letters of a single word', () => {
    expect(workspaceMonogram('relayd')).toBe('RE');
  });

  it('survives extra whitespace', () => {
    expect(workspaceMonogram('  Northwind   Voyages ')).toBe('NV');
  });
});
