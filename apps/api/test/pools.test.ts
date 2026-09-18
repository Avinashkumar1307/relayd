import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@relayd/types';
import type { SendingPoolId } from '@relayd/types';
import type { WorkspaceScope } from '@relayd/db';
import { PoolService } from '../src/services/pools.js';
import type { PoolRepositories } from '../src/services/pools.js';

/**
 * Sending pools.
 *
 * The CRUD is uninteresting. `health` is not, because it is the only place a
 * customer can see why their campaign will not launch — and because it is the
 * only place the "two senders, one provider account" trap is visible before
 * they have already believed they tripled their capacity.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const POOL = 'p1' as SendingPoolId;
const NOW = new Date('2026-09-18T12:00:00.000Z');

const POOL_ROW = {
  id: POOL,
  workspaceId: 'ws-1',
  name: 'Transactional',
  strategy: 'round_robin' as const,
  isDefault: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function member(over: Record<string, unknown> = {}) {
  return {
    poolId: POOL,
    senderAccountId: 'sa-1',
    providerConnectionId: 'conn-1',
    weight: 1,
    priority: 1,
    enabled: true,
    status: 'active',
    healthScore: 100,
    cooldownUntil: null,
    ...over,
  };
}

function service(over: { pools?: Record<string, unknown> } = {}) {
  const audits: string[] = [];

  const repos: PoolRepositories = {
    pools: {
      async list() {
        return [POOL_ROW];
      },
      async findById() {
        return POOL_ROW;
      },
      async listMembers() {
        return [member()];
      },
      async create() {
        return POOL_ROW;
      },
      async update() {
        return POOL_ROW;
      },
      async remove() {
        return true;
      },
      async addMember() {
        /* nothing */
      },
      async removeMember() {
        return true;
      },
      ...over.pools,
    } as unknown as PoolRepositories['pools'],
    auditLogs: {
      async append(_scope: unknown, entry: { action: string }) {
        audits.push(entry.action);
      },
    } as unknown as PoolRepositories['auditLogs'],
  };

  return {
    service: new PoolService({
      unitOfWork: (fn) => fn(repos),
      newId: () => 'generated',
      currentActor: () => ({ type: 'user', id: 'u1' }),
      now: () => NOW,
    }),
    audits,
  };
}

describe('pool health', () => {
  it('counts a healthy member as usable', async () => {
    // The first version of this passed an empty verified-domain list and an
    // empty domain to the router's filter, so `[].includes('')` was false and
    // every member came back ineligible — a perfectly healthy pool reported
    // as having no usable senders.
    const { service: s } = service();

    const result = await s.health(SCOPE, POOL);

    expect(result.healthyCount).toBe(1);
    expect(result.wouldHold).toBe(false);
  });

  it('does not count a disabled member', async () => {
    const { service: s } = service({
      pools: { async listMembers() { return [member({ enabled: false })]; } },
    });

    expect((await s.health(SCOPE, POOL)).healthyCount).toBe(0);
  });

  it('does not count a member below the health floor', async () => {
    const { service: s } = service({
      pools: { async listMembers() { return [member({ healthScore: 10 })]; } },
    });

    const result = await s.health(SCOPE, POOL);

    expect(result.healthyCount).toBe(0);
    expect(result.members[0]?.belowHealthFloor).toBe(true);
  });

  it('does not count a member still cooling down', async () => {
    // The column exists on sender_accounts and the router filters on it, so
    // a health view that ignored it would disagree with the router.
    const { service: s } = service({
      pools: {
        async listMembers() {
          return [member({ cooldownUntil: new Date(NOW.getTime() + 60_000) })];
        },
      },
    });

    expect((await s.health(SCOPE, POOL)).healthyCount).toBe(0);
  });

  it('counts one whose cooldown has expired', async () => {
    const { service: s } = service({
      pools: {
        async listMembers() {
          return [member({ cooldownUntil: new Date(NOW.getTime() - 1) })];
        },
      },
    });

    expect((await s.health(SCOPE, POOL)).healthyCount).toBe(1);
  });

  it('says the pool would hold when nothing is usable', async () => {
    // A campaign on this pool moves to `held`, not to `failed` — failing a
    // half-sent campaign is almost always the wrong call.
    const { service: s } = service({
      pools: { async listMembers() { return [member({ status: 'paused' })]; } },
    });

    expect((await s.health(SCOPE, POOL)).wouldHold).toBe(true);
  });

  it('names the members that share a provider account', async () => {
    // The fact customers most often get wrong: two senders on one SES account
    // draw on one quota, so the pool has not doubled anything.
    const { service: s } = service({
      pools: {
        async listMembers() {
          return [
            member({ senderAccountId: 'sa-1', providerConnectionId: 'conn-1' }),
            member({ senderAccountId: 'sa-2', providerConnectionId: 'conn-1' }),
            member({ senderAccountId: 'sa-3', providerConnectionId: 'conn-2' }),
          ];
        },
      },
    });

    const result = await s.health(SCOPE, POOL);

    expect(result.sharedProviderAccounts).toEqual(['conn-1']);
    expect(result.members.map((m) => m.sharesProviderAccount)).toEqual([true, true, false]);
  });

  it('flags nothing for a pool of genuinely separate accounts', async () => {
    const { service: s } = service({
      pools: {
        async listMembers() {
          return [
            member({ senderAccountId: 'sa-1', providerConnectionId: 'conn-1' }),
            member({ senderAccountId: 'sa-2', providerConnectionId: 'conn-2' }),
          ];
        },
      },
    });

    expect((await s.health(SCOPE, POOL)).sharedProviderAccounts).toEqual([]);
  });

  it('404s an unknown pool', async () => {
    const { service: s } = service({ pools: { async findById() { return null; } } });
    await expect(s.health(SCOPE, POOL)).rejects.toThrow(AppError);
  });
});

describe('adding a member', () => {
  it('warns about a shared account at the moment it is added', async () => {
    // This is the only moment the customer will read such a warning: it is
    // when they believe they have increased their capacity.
    const { service: s } = service({
      pools: {
        async listMembers() {
          return [
            member({ senderAccountId: 'sa-1', providerConnectionId: 'conn-1' }),
            member({ senderAccountId: 'sa-2', providerConnectionId: 'conn-1' }),
          ];
        },
      },
    });

    const result = await s.addMember(SCOPE, POOL, {
      senderAccountId: 'sa-2',
      weight: 1,
      priority: 1,
    });

    expect(result.sharedProviderAccounts).toEqual(['conn-1']);
  });

  it('404s when the pool does not exist', async () => {
    const add = vi.fn();
    const { service: s } = service({
      pools: { async findById() { return null; }, addMember: add },
    });

    await expect(
      s.addMember(SCOPE, POOL, { senderAccountId: 'sa-1', weight: 1, priority: 1 }),
    ).rejects.toThrow(AppError);

    expect(add).not.toHaveBeenCalled();
  });

  it('audits the addition', async () => {
    const { service: s, audits } = service();
    await s.addMember(SCOPE, POOL, { senderAccountId: 'sa-1', weight: 1, priority: 1 });
    expect(audits).toContain('pool.member_added');
  });
});

describe('removing a pool', () => {
  it('turns a foreign-key refusal into a 409', async () => {
    // A pool a campaign still names is ON DELETE RESTRICT. Left alone that
    // arrives as a Postgres error three layers up as a 500.
    const { service: s } = service({
      pools: {
        async remove() {
          throw new Error('violates foreign key constraint "fk_campaign_pool"');
        },
      },
    });

    await expect(s.remove(SCOPE, POOL)).rejects.toMatchObject({ status: 409 });
  });

  it('404s a pool that was not there', async () => {
    const { service: s } = service({ pools: { async remove() { return false; } } });
    await expect(s.remove(SCOPE, POOL)).rejects.toMatchObject({ status: 404 });
  });

  it('does not turn its own 404 into a 409', async () => {
    // The catch is for database errors. Swallowing the AppError it just threw
    // would report a missing pool as a conflict.
    const { service: s } = service({ pools: { async remove() { return false; } } });
    await expect(s.remove(SCOPE, POOL)).rejects.toMatchObject({ code: 'not_found' });
  });
});
