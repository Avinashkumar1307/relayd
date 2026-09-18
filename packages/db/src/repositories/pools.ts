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
             sa.provider_connection_id AS "providerConnectionId",
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
