import { MIN_HEALTH, eligibleMembers, sharedConnections, type PoolMember } from '@relayd/campaigns';
import type { AuditLogRepository, SendingPoolRepository, WorkspaceScope } from '@relayd/db';
import { AppError } from '@relayd/types';
import type { SendingPoolId } from '@relayd/types';
import { buildAuditEntry, type Actor } from './audit.js';

/**
 * Sending pools.
 *
 * The only interesting method is `health`. Everything else is CRUD, and the
 * reason `health` exists is that the routing rules are otherwise invisible:
 * a campaign refuses to launch with `no_healthy_sender` and the customer has
 * no way to see which member is cooling down, which is below the floor, and —
 * the one that surprises people — which two members are drawing on the same
 * provider account and therefore the same quota.
 *
 * It answers with the router's own predicates rather than a second set, by
 * calling `eligibleMembers` and `sharedConnections` from the engine. A health
 * view that disagrees with the router is worse than none.
 */

export interface PoolRepositories {
  pools: SendingPoolRepository;
  auditLogs: AuditLogRepository;
}

export type PoolUnitOfWork = <T>(fn: (repos: PoolRepositories) => Promise<T>) => Promise<T>;

export interface PoolServiceOptions {
  unitOfWork: PoolUnitOfWork;
  newId: () => string;
  currentActor: () => Actor;
  now?: () => Date;
}

/**
 * A domain every member claims, so the router's domain filter passes and the
 * other predicates decide. Health is a property of the pool; whether a
 * particular sender may send a particular campaign additionally depends on
 * that campaign's From domain, which this view has no opinion about.
 */
const ANY_DOMAIN = '*any*';

export const AUDIT_ACTIONS_POOLS = {
  created: 'pool.created',
  updated: 'pool.updated',
  deleted: 'pool.deleted',
  memberAdded: 'pool.member_added',
  memberRemoved: 'pool.member_removed',
} as const;

export class PoolService {
  constructor(private readonly options: PoolServiceOptions) {}

  async list(scope: WorkspaceScope) {
    return this.options.unitOfWork((repos) => repos.pools.list(scope));
  }

  async get(scope: WorkspaceScope, id: SendingPoolId) {
    return this.options.unitOfWork(async (repos) => {
      const pool = await repos.pools.findById(scope, id);
      if (pool === null) throw new AppError('not_found', 'Sending pool not found', 404);

      return { pool, members: await repos.pools.listMembers(scope, id) };
    });
  }

  /**
   * What the router would make of this pool right now.
   *
   * `verifiedDomains` is deliberately not consulted here: eligibility for a
   * *particular* campaign depends on that campaign's From domain, and a health
   * view that showed every sender as ineligible because it had no domain in
   * mind would be read as a fault.
   */
  async health(scope: WorkspaceScope, id: SendingPoolId) {
    return this.options.unitOfWork(async (repos) => {
      const pool = await repos.pools.findById(scope, id);
      if (pool === null) throw new AppError('not_found', 'Sending pool not found', 404);

      const members = await repos.pools.listMembers(scope, id);
      const now = (this.options.now ?? (() => new Date()))();

      const asRouterSees: PoolMember[] = members.map((member) => ({
        senderAccountId: member.senderAccountId,
        providerConnectionId: member.providerConnectionId,
        enabled: member.enabled,
        status: member.status as PoolMember['status'],
        healthScore: member.healthScore,
        cooldownUntil: member.cooldownUntil,
        // Every member claims the sentinel, so the domain filter passes for
        // all of them and the other four predicates decide. Handing it an
        // empty list and an empty domain would filter out every member — the
        // first version of this did exactly that and reported a perfectly
        // healthy pool as having no usable senders.
        verifiedDomains: [ANY_DOMAIN],
        priority: member.priority,
        weight: member.weight,
        tokensRemaining: 0,
      }));

      const usable = eligibleMembers(asRouterSees, { fromDomain: ANY_DOMAIN, now });

      const shared = sharedConnections(asRouterSees);

      return {
        pool,
        strategy: pool.strategy,
        members: members.map((member) => ({
          ...member,
          belowHealthFloor: member.healthScore < MIN_HEALTH,
          // Named rather than inferred, because "this one shares a quota with
          // another member" is the fact customers most often get wrong.
          sharesProviderAccount: shared.includes(member.providerConnectionId),
        })),
        healthyCount: usable.length,
        sharedProviderAccounts: shared,
        /**
         * The launch-blocking condition, from the router's own answer rather
         * than a second copy of its predicates. A campaign on this pool moves
         * to `held` rather than failing — see docs/07, corrected.
         */
        wouldHold: usable.length === 0,
      };
    });
  }

  async create(scope: WorkspaceScope, input: { name: string; strategy: 'round_robin' }) {
    return this.options.unitOfWork(async (repos) => {
      const id = this.options.newId() as SendingPoolId;
      const pool = await repos.pools.create(scope, { id, name: input.name, strategy: input.strategy });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_POOLS.created,
        resourceId: id,
        after: { name: input.name, strategy: input.strategy },
      });

      return pool;
    });
  }

  async update(
    scope: WorkspaceScope,
    id: SendingPoolId,
    input: { name?: string; strategy?: 'round_robin' },
  ) {
    return this.options.unitOfWork(async (repos) => {
      const pool = await repos.pools.update(scope, id, input);
      if (pool === null) throw new AppError('not_found', 'Sending pool not found', 404);

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_POOLS.updated,
        resourceId: id,
        after: input,
      });

      return pool;
    });
  }

  /**
   * Deletes a pool.
   *
   * The composite foreign key from `campaigns` is `ON DELETE RESTRICT`, so a
   * pool a campaign still names cannot be removed. That refusal arrives as a
   * database error, and this turns it into an answer the caller can act on.
   */
  async remove(scope: WorkspaceScope, id: SendingPoolId) {
    return this.options.unitOfWork(async (repos) => {
      try {
        const removed = await repos.pools.remove(scope, id);
        if (!removed) throw new AppError('not_found', 'Sending pool not found', 404);
      } catch (error) {
        if (error instanceof AppError) throw error;

        throw new AppError(
          'conflict',
          'This pool is still used by a campaign and cannot be deleted',
          409,
        );
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_POOLS.deleted,
        resourceId: id,
      });
    });
  }

  async addMember(
    scope: WorkspaceScope,
    poolId: SendingPoolId,
    input: { senderAccountId: string; weight: number; priority: number },
  ) {
    return this.options.unitOfWork(async (repos) => {
      const pool = await repos.pools.findById(scope, poolId);
      if (pool === null) throw new AppError('not_found', 'Sending pool not found', 404);

      await repos.pools.addMember(scope, { poolId, ...input });

      const members = await repos.pools.listMembers(scope, poolId);
      const shared = sharedConnections(
        members.map((m) => ({ providerConnectionId: m.providerConnectionId }) as PoolMember),
      );

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_POOLS.memberAdded,
        resourceId: poolId,
        after: { senderAccountId: input.senderAccountId },
      });

      return {
        members,
        /**
         * Returned on the add rather than left to a later health check: this
         * is the moment the customer believes they have increased capacity,
         * and it is the only moment they will read a warning about it.
         */
        sharedProviderAccounts: shared,
      };
    });
  }

  async removeMember(scope: WorkspaceScope, poolId: SendingPoolId, senderAccountId: string) {
    return this.options.unitOfWork(async (repos) => {
      const removed = await repos.pools.removeMember(scope, { poolId, senderAccountId });
      if (!removed) throw new AppError('not_found', 'That sender is not in this pool', 404);

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_POOLS.memberRemoved,
        resourceId: poolId,
        after: { senderAccountId },
      });
    });
  }

  private async audit(
    repos: PoolRepositories,
    scope: WorkspaceScope,
    entry: { action: string; resourceId: string; after?: unknown },
  ): Promise<void> {
    await repos.auditLogs.append(
      scope,
      buildAuditEntry({
        id: this.options.newId(),
        actor: this.options.currentActor(),
        resourceType: 'sending_pool',
        ...entry,
      }),
    );
  }
}
