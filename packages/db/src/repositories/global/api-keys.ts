import { eq } from 'drizzle-orm';
import type { UserId, WorkspaceId } from '@relayd/types';
import { apiKeys } from '../../schema/platform.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * Resolving an API key is the query that *decides* which workspace a request
 * belongs to, so it cannot be scoped to one — there is no workspace until it
 * returns. The provider-ingest twin of this is
 * `GlobalEndpointTokenRepository`, and the membership lookup is the third.
 *
 * The lookup is by hash rather than by prefix, which is what the sha256
 * decision bought (docs/16, 2026-09-19): one index probe, no candidate set,
 * no KDF on a path an unauthenticated caller can make us run.
 *
 * Narrow on purpose. It returns what the auth layer needs to establish scope
 * and check a permission, and nothing else: no workspace content, no counts,
 * no sibling keys.
 */

export interface ApiKeyResolution {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  scopes: string[];
  /** Set means revoked, and the request is refused as revoked rather than as unknown. */
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdBy: UserId | null;
  lastUsedAt: Date | null;
}

/**
 * How stale `last_used_at` may be before a request writes it.
 *
 * Writing it on every request turns the busiest read path in the system into
 * a write path, and the column is only ever read by a human wondering whether
 * a key is still in use — for which a minute of staleness is invisible.
 */
export const LAST_USED_STALENESS_MS = 60_000;

export class GlobalApiKeyRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Resolves a key hash to exactly one key.
   *
   * "Exactly one" is the unique index on `key_hash`. Returns revoked and
   * expired keys too: the caller decides what to say about them, and a
   * revoked key reported as "not found" sends an integrator looking for a
   * typo instead of at their own revocation log.
   */
  async resolve(keyHash: Buffer): Promise<ApiKeyResolution | null> {
    const [row] = await this.db
      .select({
        id: apiKeys.id,
        workspaceId: apiKeys.workspaceId,
        name: apiKeys.name,
        scopes: apiKeys.scopes,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
        createdBy: apiKeys.createdBy,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    if (row === undefined) return null;

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      scopes: row.scopes,
      revokedAt: row.revokedAt,
      expiresAt: row.expiresAt,
      createdBy: row.createdBy as UserId | null,
      lastUsedAt: row.lastUsedAt,
    };
  }

  /**
   * Records that a key was used, at most once per staleness window.
   *
   * Fire and forget from the caller's point of view: a failure here must not
   * fail the request it is describing.
   */
  async touch(keyId: string, now: Date): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(eq(apiKeys.id, keyId));
  }
}

/** Whether `last_used_at` is stale enough to be worth a write. */
export function shouldTouch(lastUsedAt: Date | null, now: Date): boolean {
  if (lastUsedAt === null) return true;
  return now.getTime() - lastUsedAt.getTime() >= LAST_USED_STALENESS_MS;
}
