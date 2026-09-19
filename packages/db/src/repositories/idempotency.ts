import { and, eq, lt } from 'drizzle-orm';
import { idempotencyKeys } from '../schema/platform.js';
import type { IdempotencyStatus } from '../schema/platform.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Idempotency keys (docs/03 "Idempotency implementation").
 *
 * The row is claimed *before* the work starts, with `ON CONFLICT DO NOTHING`,
 * so two concurrent requests carrying the same key cannot both run. Whoever
 * loses the insert reads the winner's row and either waits or replays it.
 *
 * `request_hash` is what makes the replay safe. A key reused with a different
 * body is `409 idempotency_key_reuse` rather than a silent replay of a
 * response that answers a question nobody asked — which is the failure that
 * turns "retry my contact import" into "here is the campaign you launched
 * yesterday".
 */

export interface IdempotencyRecord {
  key: string;
  endpoint: string;
  requestHash: Buffer;
  status: IdempotencyStatus;
  responseCode: number | null;
  responseBody: unknown;
  lockedAt: Date | null;
  expiresAt: Date;
}

/**
 * How long a claim may sit `in_progress` before another request may take it.
 *
 * A crashed request must not lock a key for the full 24 hours: the caller
 * retries, gets `request_in_progress` forever, and has no way out that does
 * not involve support. Thirty seconds is comfortably past the longest
 * synchronous handler and comfortably short of a person giving up.
 */
export const IDEMPOTENCY_LOCK_MS = 30_000;

/** docs/03: honoured for 24 hours. */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

export class IdempotencyRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Claims a key, or reports the row that already holds it.
   *
   * One statement. A read followed by an insert is a race in which two
   * requests both see nothing and both proceed, which is the precise thing
   * an idempotency key exists to prevent.
   */
  async claim(
    scope: WorkspaceScope,
    input: {
      key: string;
      endpoint: string;
      requestHash: Buffer;
      now: Date;
      ttlMs?: number;
    },
  ): Promise<{ claimed: boolean; existing: IdempotencyRecord | null }> {
    const ttl = input.ttlMs ?? IDEMPOTENCY_TTL_MS;

    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({
        workspaceId: scope.workspaceId,
        key: input.key,
        endpoint: input.endpoint,
        requestHash: input.requestHash,
        status: 'in_progress',
        lockedAt: input.now,
        expiresAt: new Date(input.now.getTime() + ttl),
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length > 0) return { claimed: true, existing: null };

    return { claimed: false, existing: await this.find(scope, input) };
  }

  async find(
    scope: WorkspaceScope,
    input: { key: string; endpoint: string },
  ): Promise<IdempotencyRecord | null> {
    const [row] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, scope.workspaceId),
          eq(idempotencyKeys.key, input.key),
          eq(idempotencyKeys.endpoint, input.endpoint),
        ),
      )
      .limit(1);

    if (row === undefined) return null;

    return {
      key: row.key,
      endpoint: row.endpoint,
      requestHash: row.requestHash,
      status: row.status,
      responseCode: row.responseCode,
      responseBody: row.responseBody,
      lockedAt: row.lockedAt,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Takes over a claim whose holder appears to have died.
   *
   * Guarded on the lock still being old, so two requests racing to reclaim
   * the same stale key produce exactly one winner. The request hash is
   * rewritten too: the new holder is a different request and its body is what
   * a later replay must match.
   */
  async reclaim(
    scope: WorkspaceScope,
    input: {
      key: string;
      endpoint: string;
      requestHash: Buffer;
      now: Date;
      lockMs?: number;
      ttlMs?: number;
    },
  ): Promise<boolean> {
    const lockMs = input.lockMs ?? IDEMPOTENCY_LOCK_MS;
    const cutoff = new Date(input.now.getTime() - lockMs);

    const rows = await this.db
      .update(idempotencyKeys)
      .set({
        requestHash: input.requestHash,
        lockedAt: input.now,
        expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? IDEMPOTENCY_TTL_MS)),
      })
      .where(
        and(
          eq(idempotencyKeys.workspaceId, scope.workspaceId),
          eq(idempotencyKeys.key, input.key),
          eq(idempotencyKeys.endpoint, input.endpoint),
          eq(idempotencyKeys.status, 'in_progress'),
          lt(idempotencyKeys.lockedAt, cutoff),
        ),
      )
      .returning({ key: idempotencyKeys.key });

    return rows.length > 0;
  }

  /**
   * Records the response, so a later request with the same key replays it.
   *
   * Guarded on `in_progress`, so a reclaimed key is not completed by the
   * request that lost it — the slow handler finally returning must not
   * overwrite the answer the retry already gave the caller.
   */
  async complete(
    scope: WorkspaceScope,
    input: {
      key: string;
      endpoint: string;
      responseCode: number;
      responseBody: unknown;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(idempotencyKeys)
      .set({
        status: 'completed',
        responseCode: input.responseCode,
        responseBody: input.responseBody,
        lockedAt: null,
      })
      .where(
        and(
          eq(idempotencyKeys.workspaceId, scope.workspaceId),
          eq(idempotencyKeys.key, input.key),
          eq(idempotencyKeys.endpoint, input.endpoint),
          eq(idempotencyKeys.status, 'in_progress'),
        ),
      )
      .returning({ key: idempotencyKeys.key });

    return rows.length > 0;
  }

  /**
   * Releases a claim whose request failed.
   *
   * Deleted rather than marked, so the caller may retry immediately with the
   * same key. Storing a failure and replaying it would make a transient 502
   * permanent for twenty-four hours.
   */
  async release(scope: WorkspaceScope, input: { key: string; endpoint: string }): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, scope.workspaceId),
          eq(idempotencyKeys.key, input.key),
          eq(idempotencyKeys.endpoint, input.endpoint),
          eq(idempotencyKeys.status, 'in_progress'),
        ),
      );
  }

  /** Housekeeping. Expired rows are worth nothing and index everything. */
  async deleteExpired(scope: WorkspaceScope, now: Date): Promise<number> {
    const rows = await this.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, scope.workspaceId),
          lt(idempotencyKeys.expiresAt, now),
        ),
      )
      .returning({ key: idempotencyKeys.key });

    return rows.length;
  }
}
