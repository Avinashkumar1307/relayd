import { MIN_HEALTH, eligibleMembers, sharedConnections, type PoolMember } from '@relayd/campaigns';
import type {
  AuditLogRepository,
  EligibleSenderRow,
  SendingPoolRepository,
  WorkspaceScope,
} from '@relayd/db';
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

  /**
   * The senders a pool may contain, with their connection's headroom (H1b).
   *
   * `GET /senders` already lists sender rows; this exists because the
   * drawer's combined-headroom panel is three numbers that are **not** on a
   * sender row — the connection's label, its rate and what it has left
   * today — and a browser that fetched senders and connections separately
   * would have to join them itself and would get the shared-quota
   * arithmetic wrong.
   *
   * Every connection figure is repeated on every sender that draws on it,
   * unchanged. That is what lets `combineHeadroom` in the browser group by
   * `providerConnectionId` and count each connection once, which is the
   * whole rule docs/07 spends a page on: a pool is not a way to exceed a
   * provider account's quota.
   */
  async eligibleSenders(scope: WorkspaceScope): Promise<EligibleSenderView[]> {
    const now = (this.options.now ?? (() => new Date()))();
    const day = now.toISOString().slice(0, 10);

    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.pools.listEligibleSenders(scope, { day });

      return rows.map((row) => {
        const blockedReason = blockedReasonFor(row);

        return {
          id: row.senderAccountId,
          email: row.fromEmail,
          monogram: MONOGRAM[row.providerType] ?? row.providerType.slice(0, 4).toUpperCase(),
          providerConnectionId: row.providerConnectionId,
          connectionLabel: connectionLabel(row),
          perSecond: perSecondOf(row.quotaSnapshot),
          remainingToday: remainingTodayOf(row.quotaSnapshot, row.sentToday),
          // Null rather than absent: the browser's type is
          // `blockedReason?: string | null`, and a row that is fine says so.
          blockedReason,
        };
      });
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

/** One row of H1b's member list, as the browser's `EligibleSender` is shaped. */
export interface EligibleSenderView {
  id: string;
  email: string;
  monogram: string;
  providerConnectionId: string;
  connectionLabel: string;
  perSecond: number;
  remainingToday: number;
  blockedReason: string | null;
}

/**
 * The letters in the 16px tile.
 *
 * Here rather than shared with the browser's `PROVIDER_INFO` because that
 * table is a marketing catalogue — blurbs, pitches, what a customer gives
 * up — and none of it belongs in a server response. Only the monogram does,
 * and it is four short strings.
 */
const MONOGRAM: Readonly<Record<string, string>> = {
  ses: 'SES',
  sendgrid: 'SG',
  mailgun: 'MG',
  brevo: 'BR',
  smtp: 'SMTP',
  google: 'GW',
};

/** "Amazon SES · eu-west-1", built from the connection's own non-secret config. */
function connectionLabel(row: EligibleSenderRow): string {
  const detail = configDetail(row.config);
  return detail === null ? row.connectionName : `${row.connectionName} · ${detail}`;
}

/**
 * The one identifying thing in a connection's config.
 *
 * Allow-listed rather than "print whatever is there": `config` is documented
 * as non-secret by review and not by the database (0006), so a label built
 * from every key is one bad write away from putting a password on screen.
 */
function configDetail(config: Record<string, unknown>): string | null {
  for (const key of ['region', 'domain', 'host'] as const) {
    const value = config[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }

  return null;
}

/**
 * The connection's send rate, as the provider last reported it.
 *
 * Zero when unknown, which the drawer renders as an em dash. Inventing a
 * default here would put a number on the combined-rate panel that the rate
 * limiter does not agree with.
 */
function perSecondOf(quota: Record<string, unknown> | null): number {
  const raw = quota?.['maxSendRate'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * What the connection can still accept today.
 *
 * `max24Hour` minus what `provider_stats` recorded for the UTC day, floored
 * at zero. Preferred over the provider's own `sentLast24Hours` because that
 * figure is a rolling window snapshotted at verification time and can be
 * hours stale, whereas the rollup is ours and is written as we send.
 */
function remainingTodayOf(quota: Record<string, unknown> | null, sentToday: number): number {
  const limit = quota?.['max24Hour'];
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return 0;

  return Math.max(0, Math.trunc(limit) - Math.max(0, Math.trunc(sentToday)));
}

/**
 * Why this sender cannot be pooled, in the order a customer would fix them.
 *
 * An unverified identity first, because it is both the commonest and the one
 * that produces the most confusing failure later: the pool accepts the
 * sender, the campaign launches, and every message is rejected by the
 * provider.
 */
function blockedReasonFor(row: EligibleSenderRow): string | null {
  if (row.identityStatus !== 'verified') {
    return row.identityStatus === 'pending' ? 'Pending DNS' : `Identity ${row.identityStatus}`;
  }

  if (row.connectionStatus === 'revoked' || row.connectionStatus === 'disabled') {
    return `Connection ${row.connectionStatus}`;
  }

  if (row.connectionStatus === 'error') return 'Connection needs attention';

  if (row.senderStatus !== 'active') return `Sender ${row.senderStatus.replace(/_/gu, ' ')}`;

  return null;
}
