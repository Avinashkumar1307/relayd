import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserId, WorkspaceId, WorkspaceInvitationId, WorkspaceMemberId } from '@relayd/types';
import { hashToken } from '@relayd/utils';
import { workspaceScope } from '@relayd/db';
import { WorkspaceService } from '../src/services/workspaces.js';
import { buildWorld } from './support/world.js';

const WS = 'ws-1' as WorkspaceId;
const scope = workspaceScope(WS);

const OWNER = 'user-owner' as UserId;
const ADMIN = 'user-admin' as UserId;

let world: ReturnType<typeof buildWorld>;
let service: WorkspaceService;
let notifier: { sendWorkspaceInvitation: ReturnType<typeof vi.fn> };
let counter: number;

function callArgs<A extends unknown[]>(mock: { mock: { calls: A[] } }, index = 0): A {
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`expected call ${index + 1}`);
  return call;
}

beforeEach(() => {
  world = buildWorld();
  counter = 0;
  notifier = {
    sendWorkspaceInvitation: vi.fn<(to: string, ws: string, token: string) => Promise<void>>(
      async () => undefined,
    ),
  };

  service = new WorkspaceService({
    unitOfWork: async (fn) => fn(world.repos),
    notifier: notifier as never,
    newId: () => `gen-${++counter}`,
    now: world.now,
  });

  world.workspaces.push({ id: WS, name: 'Acme', ownerUserId: OWNER });
  world.members.push({ workspaceId: WS, userId: OWNER, role: 'owner', joinedAt: world.now() });
});

describe('members', () => {
  it('lists them', async () => {
    world.members.push({ workspaceId: WS, userId: ADMIN, role: 'admin', joinedAt: world.now() });
    expect(await service.listMembers(scope)).toHaveLength(2);
  });

  it('changes a role', async () => {
    world.members.push({ workspaceId: WS, userId: ADMIN, role: 'admin', joinedAt: world.now() });
    const updated = await service.changeMemberRole(scope, ADMIN, 'viewer');
    expect(updated.role).toBe('viewer');
  });

  it('404s for a member who is not here', async () => {
    await expect(
      service.changeMemberRole(scope, 'stranger' as UserId, 'admin'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('REFUSES to demote the last owner', async () => {
    // A workspace with no owner has nobody who can manage billing or delete
    // it, and no way back without operator intervention.
    await expect(service.changeMemberRole(scope, OWNER, 'admin')).rejects.toMatchObject({
      status: 422,
    });
    expect(world.members.find((m) => m.userId === OWNER)?.role).toBe('owner');
  });

  it('REFUSES to remove the last owner', async () => {
    await expect(service.removeMember(scope, OWNER)).rejects.toMatchObject({ status: 422 });
    expect(world.members).toHaveLength(1);
  });

  it('allows demoting an owner once a second owner exists', async () => {
    world.members.push({ workspaceId: WS, userId: ADMIN, role: 'owner', joinedAt: world.now() });
    await expect(service.changeMemberRole(scope, OWNER, 'admin')).resolves.toMatchObject({
      role: 'admin',
    });
  });

  it('removes an ordinary member', async () => {
    world.members.push({ workspaceId: WS, userId: ADMIN, role: 'admin', joinedAt: world.now() });
    await service.removeMember(scope, ADMIN);
    expect(world.members).toHaveLength(1);
  });
});

describe('invitations', () => {
  const invite = () =>
    service.invite(scope, {
      email: 'new@example.com',
      role: 'editor',
      invitedBy: OWNER,
      workspaceName: 'Acme',
    });

  it('creates one and emails the token', async () => {
    const created = await invite();
    expect(created.email).toBe('new@example.com');
    expect(notifier.sendWorkspaceInvitation).toHaveBeenCalledOnce();
  });

  it('stores only a hash of the token', async () => {
    await invite();
    const [, , token] = callArgs(notifier.sendWorkspaceInvitation) as [string, string, string];
    expect(world.invitations[0]?.tokenHash.equals(hashToken(token))).toBe(true);
    expect(JSON.stringify(world.invitations)).not.toContain(token);
  });

  it('refuses to invite someone who is already a member', async () => {
    world.users.push({
      id: ADMIN,
      email: 'already@example.com',
      name: 'Already',
      passwordHash: 'x',
      emailVerifiedAt: null,
      status: 'active',
      lastLoginAt: null,
      createdAt: world.now(),
    });
    world.members.push({ workspaceId: WS, userId: ADMIN, role: 'admin', joinedAt: world.now() });

    await expect(
      service.invite(scope, {
        email: 'already@example.com',
        role: 'editor',
        invitedBy: OWNER,
        workspaceName: 'Acme',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('lists only pending ones', async () => {
    await invite();
    expect(await service.listInvitations(scope)).toHaveLength(1);

    const id = world.invitations[0]?.id as WorkspaceInvitationId;
    await service.revokeInvitation(scope, id);
    expect(await service.listInvitations(scope)).toHaveLength(0);
  });

  it('404s revoking one that is already gone', async () => {
    await invite();
    const id = world.invitations[0]?.id as WorkspaceInvitationId;
    await service.revokeInvitation(scope, id);
    await expect(service.revokeInvitation(scope, id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('accepting an invitation', () => {
  const acceptingUser = { id: 'user-new' as UserId, email: 'new@example.com' };

  const sendInvite = async (): Promise<string> => {
    await service.invite(scope, {
      email: 'new@example.com',
      role: 'editor',
      invitedBy: OWNER,
      workspaceName: 'Acme',
    });
    const [, , token] = callArgs(notifier.sendWorkspaceInvitation) as [string, string, string];
    return token;
  };

  it('creates the membership with the invited role', async () => {
    const token = await sendInvite();
    const result = await service.acceptInvitation(token, acceptingUser);

    expect(result).toEqual({ workspaceId: WS, role: 'editor' });
    expect(world.members.some((m) => m.userId === acceptingUser.id && m.role === 'editor')).toBe(
      true,
    );
  });

  it('REFUSES a forwarded invitation accepted by a different address', async () => {
    // The token is a strong credential, but invitations get forwarded. Without
    // this the audit trail records the invitee while someone else got in.
    const token = await sendInvite();
    await expect(
      service.acceptInvitation(token, { id: 'someone' as UserId, email: 'other@example.com' }),
    ).rejects.toMatchObject({ status: 403 });

    expect(world.members).toHaveLength(1);
  });

  it('matches the address case-insensitively', async () => {
    const token = await sendInvite();
    await expect(
      service.acceptInvitation(token, { id: acceptingUser.id, email: 'NEW@Example.com' }),
    ).resolves.toMatchObject({ role: 'editor' });
  });

  it('cannot be used twice', async () => {
    const token = await sendInvite();
    await service.acceptInvitation(token, acceptingUser);
    await expect(service.acceptInvitation(token, acceptingUser)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('is a no-op for someone who is already a member, and burns the link', async () => {
    const token = await sendInvite();
    world.members.push({
      workspaceId: WS,
      userId: acceptingUser.id,
      role: 'viewer',
      joinedAt: world.now(),
    });

    const result = await service.acceptInvitation(token, acceptingUser);

    // Keeps their existing role rather than silently downgrading or
    // duplicating the membership.
    expect(result.role).toBe('viewer');
    expect(world.members.filter((m) => m.userId === acceptingUser.id)).toHaveLength(1);
    expect(world.invitations[0]?.acceptedAt).not.toBeNull();
  });

  it('404s on a revoked invitation', async () => {
    const token = await sendInvite();
    await service.revokeInvitation(scope, world.invitations[0]?.id as WorkspaceInvitationId);
    await expect(service.acceptInvitation(token, acceptingUser)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('404s on an expired invitation', async () => {
    const token = await sendInvite();
    const invitation = world.invitations[0];
    if (invitation !== undefined) invitation.expiresAt = new Date('2020-01-01T00:00:00Z');
    await expect(service.acceptInvitation(token, acceptingUser)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('404s on a made-up token', async () => {
    await expect(service.acceptInvitation('nonsense', acceptingUser)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('workspace details', () => {
  it('reads the current workspace', async () => {
    const found = await service.get(scope);
    expect(found.id).toBe(WS);
  });

  it('updates name and timezone', async () => {
    const updated = await service.updateDetails(scope, { name: 'Acme Inc', timezone: 'Asia/Dubai' });
    expect(updated.name).toBe('Acme Inc');
  });

  it('soft deletes', async () => {
    await expect(service.softDelete(scope)).resolves.toBeUndefined();
  });
});

/** Unused import guard: MemberId type is part of the public surface. */
export type _MemberId = WorkspaceMemberId;
