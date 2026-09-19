import { and, desc, eq, isNull } from 'drizzle-orm';
import type { UserId, WorkspaceId } from '@relayd/types';
import { apiKeys } from '../schema/platform.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * API keys, from inside a workspace.
 *
 * Everything here is management: issue, list, revoke. The *authentication*
 * lookup is `GlobalApiKeyRepository`, because it runs before a workspace is
 * known and therefore cannot be scoped to one.
 *
 * `key_hash` never leaves this file, and no method here returns it. A key is
 * shown once, at issue, from the value the caller generated — the database
 * only ever holds something that proves a guess right, never something that
 * can be replayed.
 */

export interface ApiKeyRow {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  /** The visible part, e.g. `rk_live_a1b2c3d4`. Never the key. */
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdBy: UserId | null;
  createdAt: Date;
}

export class ApiKeyRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: {
      id: string;
      name: string;
      keyPrefix: string;
      keyHash: Buffer;
      scopes: readonly string[];
      expiresAt?: Date;
      createdBy?: UserId;
    },
  ): Promise<ApiKeyRow> {
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        name: input.name,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        scopes: [...input.scopes],
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      })
      .returning();

    if (row === undefined) throw new Error('createApiKey: insert returned no row');
    return toRow(row);
  }

  /**
   * A workspace's keys, revoked ones included.
   *
   * Revoked keys stay in the list because "was this key revoked, and when"
   * is the question somebody asks after a leak, and a list that hides them
   * answers it with silence.
   */
  async list(scope: WorkspaceScope): Promise<ApiKeyRow[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, scope.workspaceId))
      .orderBy(desc(apiKeys.createdAt));

    return rows.map(toRow);
  }

  async find(scope: WorkspaceScope, keyId: string): Promise<ApiKeyRow | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.workspaceId, scope.workspaceId), eq(apiKeys.id, keyId)))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  /**
   * Revokes a key.
   *
   * Guarded on `revoked_at IS NULL`, so revoking twice returns false rather
   * than rewriting the timestamp — the first revocation is the one that
   * matters and the one an incident timeline needs.
   */
  async revoke(
    scope: WorkspaceScope,
    input: { keyId: string; revokedBy: UserId; at: Date },
  ): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: input.at, revokedBy: input.revokedBy })
      .where(
        and(
          eq(apiKeys.workspaceId, scope.workspaceId),
          eq(apiKeys.id, input.keyId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });

    return rows.length > 0;
  }

  /** Live keys, for the entitlement check that caps how many a plan allows. */
  async countActive(scope: WorkspaceScope): Promise<number> {
    const rows = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.workspaceId, scope.workspaceId), isNull(apiKeys.revokedAt)));

    return rows.length;
  }
}

function toRow(row: typeof apiKeys.$inferSelect): ApiKeyRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy as UserId | null,
    createdAt: row.createdAt,
  };
}
