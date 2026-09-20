import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserId, WorkspaceId, WorkspaceInvitationId } from '@relayd/types';
import { workspaceScope } from '@relayd/db';
import { newRequestId, newTraceId, runWithTrace } from '@relayd/logger';
import { AUDIT_ACTIONS } from '../src/services/audit.js';
import { WorkspaceService } from '../src/services/workspaces.js';
import { buildWorld } from './support/world.js';

const WS = 'ws-1' as WorkspaceId;
const scope = workspaceScope(WS);
const OWNER = 'user-owner' as UserId;
const ADMIN = 'user-admin' as UserId;

let world: ReturnType<typeof buildWorld>;
let service: WorkspaceService;
let sentTokens: string[];

beforeEach(() => {
  world = buildWorld();
  sentTokens = [];
  let counter = 0;

  const notifier = {
    sendWorkspaceInvitation: vi.fn<(to: string, ws: string, token: string) => Promise<void>>(
      async (_to, _ws, token) => {
        sentTokens.push(token);
      },
    ),
    sendEmailVerification: vi.fn(async () => undefined),
  };

  service = new WorkspaceService({
    unitOfWork: async (fn) => fn(world.repos),
    notifier,
    newId: () => `gen-${++counter}`,
    now: world.now,
    currentActor: () => ({ type: 'user', id: OWNER }),
    currentContext: () => ({ ip: '203.0.113.7', userAgent: 'Mozilla/5.0' }),
  });

  world.workspaces.push({ id: WS, name: 'Acme', slug: 'acme', ownerUserId: OWNER });
  world.members.push({ workspaceId: WS, userId: OWNER, role: 'owner', joinedAt: world.now() });
  world.members.push({ workspaceId: WS, userId: ADMIN, role: 'admin', joinedAt: world.now() });
});

const actions = () => world.auditEntries.map((e) => e['action']);

describe('every mutating workspace action is audited', () => {
  it('records a workspace update with before and after', async () => {
    await service.updateDetails(scope, { name: 'Acme Inc' });

    const entry = world.auditEntries[0];
    expect(entry?.['action']).toBe(AUDIT_ACTIONS.workspaceUpdated);
    expect(entry?.['before']).toMatchObject({ name: 'Acme' });
    expect(entry?.['after']).toMatchObject({ name: 'Acme Inc' });
  });

  it('records a role change with the old and new role', async () => {
    await service.changeMemberRole(scope, ADMIN, 'viewer');

    const entry = world.auditEntries[0];
    expect(entry?.['action']).toBe(AUDIT_ACTIONS.memberRoleChanged);
    expect(entry?.['before']).toEqual({ role: 'admin' });
    expect(entry?.['after']).toEqual({ role: 'viewer' });
    expect(entry?.['resourceId']).toBe(ADMIN);
  });

  it('records a member removal with the role they held', async () => {
    await service.removeMember(scope, ADMIN);
    expect(world.auditEntries[0]?.['action']).toBe(AUDIT_ACTIONS.memberRemoved);
    expect(world.auditEntries[0]?.['before']).toEqual({ role: 'admin' });
  });

  it('records invitation created, revoked and accepted', async () => {
    await service.invite(scope, {
      email: 'new@example.com',
      role: 'editor',
      invitedBy: OWNER,
      workspaceName: 'Acme',
    });
    expect(actions()).toContain(AUDIT_ACTIONS.invitationCreated);

    const id = world.invitations[0]?.id as WorkspaceInvitationId;
    await service.revokeInvitation(scope, id);
    expect(actions()).toContain(AUDIT_ACTIONS.invitationRevoked);

    await service.invite(scope, {
      email: 'other@example.com',
      role: 'viewer',
      invitedBy: OWNER,
      workspaceName: 'Acme',
    });
    await service.acceptInvitation(sentTokens[1] ?? '', {
      id: 'user-new' as UserId,
      email: 'other@example.com',
    });
    expect(actions()).toContain(AUDIT_ACTIONS.invitationAccepted);
  });

  it('records a workspace deletion', async () => {
    await service.softDelete(scope);
    expect(world.auditEntries[0]?.['action']).toBe(AUDIT_ACTIONS.workspaceDeleted);
  });

  it('writes nothing when the action fails', async () => {
    // The audit row lives in the same transaction as the action, so a refused
    // action must leave no trace of having succeeded.
    await expect(service.changeMemberRole(scope, 'nobody' as UserId, 'admin')).rejects.toThrow();
    expect(world.auditEntries).toHaveLength(0);
  });

  it('writes nothing when the last-owner guard refuses', async () => {
    world.members.splice(1, 1); // leave only the owner
    await expect(service.removeMember(scope, OWNER)).rejects.toThrow();
    expect(world.auditEntries).toHaveLength(0);
  });
});

describe('audit row contents', () => {
  it('records the actor', async () => {
    await service.updateDetails(scope, { name: 'X' });
    expect(world.auditEntries[0]).toMatchObject({ actorType: 'user', actorId: OWNER });
  });

  it('records the workspace it happened in', async () => {
    await service.updateDetails(scope, { name: 'X' });
    expect(world.auditEntries[0]?.workspaceId).toBe(WS);
  });

  it('records ip and user agent', async () => {
    await service.updateDetails(scope, { name: 'X' });
    expect(world.auditEntries[0]).toMatchObject({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('ties the row to the request that caused it', async () => {
    // docs/10: one query on the correlation set should reach the log lines and
    // the response for the same action.
    const requestId = newRequestId();
    await runWithTrace({ requestId, traceId: newTraceId() }, async () => {
      await service.updateDetails(scope, { name: 'X' });
    });

    expect(world.auditEntries[0]?.['requestId']).toBe(requestId);
  });

  it('NEVER records the invitation token', async () => {
    // The audit trail is widely readable inside a workspace; a token in it
    // would be a standing invitation to impersonate the invitee.
    await service.invite(scope, {
      email: 'new@example.com',
      role: 'editor',
      invitedBy: OWNER,
      workspaceName: 'Acme',
    });

    const serialised = JSON.stringify(world.auditEntries);
    for (const sent of sentTokens) {
      expect(serialised).not.toContain(sent);
    }
    // It does record who was invited and as what, which is the auditable part.
    expect(world.auditEntries[0]?.['after']).toEqual({
      email: 'new@example.com',
      role: 'editor',
    });
  });
});
