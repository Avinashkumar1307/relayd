import { and, eq, sql } from 'drizzle-orm';
import type { SendingPoolId, WorkspaceId } from '@relayd/types';
import { sendingPoolMembers, sendingPools } from '../schema/campaigns.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Sending pools and their members.
 *
 * The one thing this file must not make easy is the thing docs/07 spends a
 * page forbidding: a pool as a way to exceed one provider account's quota.
 * The rate limiter enforces it by keying buckets on `provider_connection_id`,
 * but a customer who adds the same SES account three times should be told so
 * rather than left to discover their capacity did not triple. `listMembers`
 * therefore returns the connection id with every member, and
 * `sharedConnections` in the routing engine turns that into the warning.
 */

export interface SendingPoolRow {
  id: SendingPoolId;
  workspaceId: WorkspaceId;
  name: string;
  strategy: 'round_robin' | 'weighted' | 'failover' | 'least_loaded';
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PoolMemberRow {
  poolId: SendingPoolId;
  senderAccountId: string;
  /** The bucket key. Two members may legitimately share one. */
  providerConnectionId: string;
  weight: number;
  priority: number;
  enabled: boolean;
  status: string;
  healthScore: number;
  /** Selected because the router filters on it — see `eligibleMembers`. */
  cooldownUntil: Date | null;
}

export class SendingPoolRepository {
  constructor(private readonly db: Executor) {}

  async list(scope: WorkspaceScope): Promise<SendingPoolRow[]> {
    const rows = await this.db
      .select()
      .from(sendingPools)
      .where(eq(sendingPools.workspaceId, scope.workspaceId))
      .orderBy(sendingPools.name);

    return rows as unknown as SendingPoolRow[];
  }

  async findById(scope: WorkspaceScope, id: SendingPoolId): Promise<SendingPoolRow | null> {
    const [row] = await this.db
      .select()
      .from(sendingPools)
      .where(and(eq(sendingPools.id, id), eq(sendingPools.workspaceId, scope.workspaceId)))
      .limit(1);

    return (row as unknown as SendingPoolRow | undefined) ?? null;
  }

  async create(
    scope: WorkspaceScope,
    input: { id: SendingPoolId; name: string; strategy: SendingPoolRow['strategy'] },
  ): Promise<SendingPoolRow> {
    const [row] = await this.db
      .insert(sendingPools)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        name: input.name,
        strategy: input.strategy,
      })
      .returning();

    if (row === undefined) throw new Error('createPool: insert returned no row');
    return row as unknown as SendingPoolRow;
  }

  async update(
    scope: WorkspaceScope,
    id: SendingPoolId,
    input: { name?: string; strategy?: SendingPoolRow['strategy'] },
  ): Promise<SendingPoolRow | null> {
    const [row] = await this.db
      .update(sendingPools)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
        updatedAt: new Date(),
      })
      .where(and(eq(sendingPools.id, id), eq(sendingPools.workspaceId, scope.workspaceId)))
      .returning();

    return (row as unknown as SendingPoolRow | undefined) ?? null;
  }

  async remove(scope: WorkspaceScope, id: SendingPoolId): Promise<boolean> {
    const rows = await this.db
      .delete(sendingPools)
      .where(and(eq(sendingPools.id, id), eq(sendingPools.workspaceId, scope.workspaceId)))
      .returning({ id: sendingPools.id });

    return rows.length > 0;
  }

  /**
   * Members with everything the router needs to choose between them.
   *
   * Joined to `sender_accounts` for the health score and the connection id
   * rather than read separately, because the router's filter and the shared
   * -bucket warning both need all of it and a second round trip per pool
   * would be per dispatch page.
   */
  async listMembers(scope: WorkspaceScope, poolId: SendingPoolId): Promise<PoolMemberRow[]> {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT m.pool_id            AS "poolId",
             m.sender_account_id  AS "senderAccountId",
             -- sender_accounts names this column provider_id (0006). It was
             -- written here as provider_connection_id, which is the name it
             -- has on campaign_recipients, and no unit test could catch it
             -- because the fake executor never resolves a column.
             sa.provider_id      AS "providerConnectionId",
             m.weight, m.priority, m.enabled,
             sa.status, sa.health_score AS "healthScore",
             sa.cooldown_until AS "cooldownUntil"
        FROM sending_pool_members m
        JOIN sender_accounts sa
          ON sa.id = m.sender_account_id AND sa.workspace_id = m.workspace_id
       WHERE m.workspace_id = ${scope.workspaceId}
         AND m.pool_id = ${poolId}
       ORDER BY m.priority, sa.health_score DESC
    `);

    return rows as unknown as PoolMemberRow[];
  }

  /**
   * Adds a sender, or updates its weight and priority if it is already there.
   *
   * Upsert rather than insert-or-409: adding a sender that is already in the
   * pool is what a customer does when they meant to change its weight, and
   * the primary key on `(pool_id, sender_account_id)` makes the intent
   * unambiguous.
   */
  async addMember(
    scope: WorkspaceScope,
    input: { poolId: SendingPoolId; senderAccountId: string; weight: number; priority: number },
  ): Promise<void> {
    await this.db
      .insert(sendingPoolMembers)
      .values({
        workspaceId: scope.workspaceId,
        poolId: input.poolId,
        senderAccountId: input.senderAccountId as never,
        weight: input.weight,
        priority: input.priority,
      })
      .onConflictDoUpdate({
        target: [sendingPoolMembers.poolId, sendingPoolMembers.senderAccountId],
        set: { weight: input.weight, priority: input.priority, enabled: true },
      });
  }

  /**
   * Every sender a pool could contain, with its connection's own numbers.
   *
   * The connection columns repeat on every sender that draws on the same
   * connection, and that repetition is the point: H1b groups by
   * `providerConnectionId` and counts each connection once, which is how the
   * drawer avoids telling a customer that two SES senders doubled their
   * capacity. The rate limiter keys its buckets on the same column, so the
   * browser and the send path are reading the same fact.
   *
   * `sentToday` comes from `provider_stats` for the UTC day rather than from
   * `sender_daily_usage`, for the same reason: quota is a property of the
   * connection, and summing per-sender usage would count a shared bucket
   * twice.
   */
  async listEligibleSenders(
    scope: WorkspaceScope,
    input: { day: string },
  ): Promise<EligibleSenderRow[]> {
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT sa.id                     AS "senderAccountId",
             sa.from_email             AS "fromEmail",
             sa.status                 AS "senderStatus",
             sa.provider_id            AS "providerConnectionId",
             pc.provider_type          AS "providerType",
             pc.name                   AS "connectionName",
             pc.status                 AS "connectionStatus",
             pc.config                 AS "config",
             pc.quota_snapshot         AS "quotaSnapshot",
             si.verification_status    AS "identityStatus",
             si.value                  AS "identityValue",
             coalesce(ps.sent, 0)::int AS "sentToday"
        FROM sender_accounts sa
        JOIN provider_connections pc
          ON pc.id = sa.provider_id AND pc.workspace_id = sa.workspace_id
        JOIN sender_identities si
          ON si.id = sa.identity_id AND si.workspace_id = sa.workspace_id
        LEFT JOIN provider_stats ps
          ON ps.provider_connection_id = pc.id
         AND ps.workspace_id = pc.workspace_id
         AND ps.day = ${input.day}::date
       WHERE sa.workspace_id = ${scope.workspaceId}
       ORDER BY pc.name, sa.from_email
    `);

    return rows.map(toEligibleSender);
  }

  async removeMember(
    scope: WorkspaceScope,
    input: { poolId: SendingPoolId; senderAccountId: string },
  ): Promise<boolean> {
    const rows = await this.db
      .delete(sendingPoolMembers)
      .where(
        and(
          eq(sendingPoolMembers.workspaceId, scope.workspaceId),
          eq(sendingPoolMembers.poolId, input.poolId),
          eq(sendingPoolMembers.senderAccountId, input.senderAccountId as never),
        ),
      )
      .returning({ poolId: sendingPoolMembers.poolId });

    return rows.length > 0;
  }
}

/**
 * One candidate for pool membership, as H1b's member list draws it.
 *
 * The connection fields are properties of the connection, not of this
 * sender. `perSecond` in particular is what the whole connection allows,
 * never this sender's share of it — a pool does not divide a quota, and
 * showing a divided number would suggest it did.
 */
export interface EligibleSenderRow {
  senderAccountId: string;
  fromEmail: string;
  senderStatus: string;
  providerConnectionId: string;
  providerType: string;
  connectionName: string;
  connectionStatus: string;
  /** Non-secret connection settings: region, host, port. Never a credential. */
  config: Record<string, unknown>;
  /** What the provider last told us about its own limits, or null. */
  quotaSnapshot: Record<string, unknown> | null;
  identityStatus: string;
  identityValue: string;
  /** The connection's sends today, UTC. Shared by every sender on it. */
  sentToday: number;
}

function toEligibleSender(row: Record<string, unknown>): EligibleSenderRow {
  return {
    senderAccountId: String(row['senderAccountId']),
    fromEmail: String(row['fromEmail']),
    senderStatus: String(row['senderStatus']),
    providerConnectionId: String(row['providerConnectionId']),
    providerType: String(row['providerType']),
    connectionName: String(row['connectionName']),
    connectionStatus: String(row['connectionStatus']),
    config: (row['config'] as Record<string, unknown> | null) ?? {},
    quotaSnapshot: (row['quotaSnapshot'] as Record<string, unknown> | null) ?? null,
    identityStatus: String(row['identityStatus']),
    identityValue: String(row['identityValue']),
    sentToday: Number(row['sentToday'] ?? 0),
  };
}
