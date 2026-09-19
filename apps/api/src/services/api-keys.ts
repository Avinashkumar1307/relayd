import { generatePrefixedKey, hashToken } from '@relayd/utils';
import {
  AppError,
  PERMISSIONS,
  can,
  canApiKeyHold,
  partitionApiKeyScopes,
} from '@relayd/types';
import type { Permission, UserId, WorkspaceRole } from '@relayd/types';
import type { ApiKeyRepository, ApiKeyRow, AuditLogRepository, WorkspaceScope } from '@relayd/db';
import { buildAuditEntry, type Actor } from './audit.js';

/**
 * API keys (docs/03, docs/06; CLAUDE.md section 11).
 *
 * Three rules, and the first two are refusals:
 *
 *   **`billing:write` is never grantable.** Not to an owner's key, not on
 *   request, not by mistake. A leaked key must be able to spend the plan the
 *   workspace already has and never to change what it is paying — which is
 *   the difference between a bad month and a fraud case.
 *
 *   **A key never exceeds the role that minted it.** An editor cannot issue a
 *   key that launches campaigns if their role cannot, because otherwise the
 *   key is a privilege-escalation primitive that anybody with `api:write`
 *   holds.
 *
 *   **The key is shown once.** Only a sha256 is stored, so there is nothing
 *   to reveal later even to us. A key that could be read back out of the
 *   database is a key that leaks with a database backup.
 *
 * Asking for a scope that fails either refusal is an error rather than a
 * silent downgrade. Issuing a weaker key than was asked for means the
 * integrator discovers the difference at runtime, in production, against
 * whichever endpoint they happened to call first.
 */

/** The visible prefix. `live` because there is no test mode to distinguish from. */
const KEY_PREFIX = 'rk_live';

/** The longest life a key may be given, so an abandoned key eventually dies. */
export const MAX_KEY_LIFETIME_DAYS = 365;

export interface ApiKeyRepositories {
  apiKeys: ApiKeyRepository;
  auditLogs: AuditLogRepository;
}

export type ApiKeyUnitOfWork = <T>(fn: (repos: ApiKeyRepositories) => Promise<T>) => Promise<T>;

export interface ApiKeyServiceOptions {
  unitOfWork: ApiKeyUnitOfWork;
  newId: () => string;
  now?: () => Date;
  /** How many live keys a workspace may hold. Null is unlimited. */
  maxActiveKeys?: number | null;
}

export interface IssuedKey {
  /** Shown once, never stored, never recoverable. */
  key: string;
  row: PublicApiKey;
}

/** An API key as the API returns it. Never carries the key or its hash. */
export interface PublicApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const DEFAULT_MAX_ACTIVE_KEYS = 25;

export class ApiKeyService {
  constructor(private readonly options: ApiKeyServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Issues a key, returning it once.
   *
   * The id and the secret are generated here rather than by the database, so
   * the value handed back is the value that was hashed — there is no window
   * in which we hold a key we could not reproduce and no path that reads one
   * back out.
   */
  async issue(
    scope: WorkspaceScope,
    input: {
      name: string;
      scopes: readonly string[];
      expiresInDays?: number;
      actor: { userId: UserId; role: WorkspaceRole };
    },
  ): Promise<IssuedKey> {
    const requested = normaliseScopes(input.scopes);

    // Refusal one: never grantable to any key.
    const { refused: forbidden } = partitionApiKeyScopes(requested);
    if (forbidden.length > 0) {
      throw new AppError(
        'insufficient_permission',
        `An API key can never hold ${forbidden.join(', ')}`,
        403,
        forbidden.map((scope_) => ({
          path: scope_,
          message: 'This permission cannot be attached to an API key',
        })),
      );
    }

    // Refusal two: never more than the minting role holds.
    const beyond = requested.filter((permission) => !can(input.actor.role, permission));
    if (beyond.length > 0) {
      throw new AppError(
        'insufficient_permission',
        `Your role cannot grant ${beyond.join(', ')}`,
        403,
        beyond.map((scope_) => ({
          path: scope_,
          message: 'Your own role does not hold this permission',
        })),
      );
    }

    if (requested.length === 0) {
      // A key with no scopes authenticates and can do nothing, which reads as
      // a broken key rather than as a deliberate one.
      throw new AppError('validation_failed', 'A key needs at least one scope', 400);
    }

    const expiresAt = expiryFor(this.now(), input.expiresInDays);
    const { key, lookup } = generatePrefixedKey(KEY_PREFIX);
    const id = this.options.newId();

    return this.options.unitOfWork(async (repos) => {
      const cap = this.options.maxActiveKeys === undefined
        ? DEFAULT_MAX_ACTIVE_KEYS
        : this.options.maxActiveKeys;

      if (cap !== null && (await repos.apiKeys.countActive(scope)) >= cap) {
        throw new AppError(
          'limit_reached',
          `This workspace already has ${cap} active keys. Revoke one first.`,
          402,
        );
      }

      const row = await repos.apiKeys.create(scope, {
        id,
        name: input.name,
        keyPrefix: lookup,
        keyHash: hashToken(key),
        scopes: requested,
        ...(expiresAt === null ? {} : { expiresAt }),
        createdBy: input.actor.userId,
      });

      await repos.auditLogs.append(
        scope,
        buildAuditEntry({
          id: this.options.newId(),
          actor: { type: 'user', id: input.actor.userId } satisfies Actor,
          action: 'api_key.issued',
          resourceType: 'api_key',
          resourceId: id,
          // The scopes and the name, never the key. An audit log that carried
          // the credential would be a second place it leaks from.
          after: { name: input.name, scopes: requested, expiresAt },
        }),
      );

      return { key, row: toPublic(row) };
    });
  }

  async list(scope: WorkspaceScope): Promise<PublicApiKey[]> {
    return this.options.unitOfWork(async (repos) =>
      (await repos.apiKeys.list(scope)).map(toPublic),
    );
  }

  /**
   * Revokes a key.
   *
   * Immediate: the auth path checks `revoked_at` on the row it just read, so
   * there is no cache to invalidate and no window in which a revoked key
   * still works.
   */
  async revoke(
    scope: WorkspaceScope,
    input: { keyId: string; actor: { userId: UserId } },
  ): Promise<{ revoked: boolean }> {
    return this.options.unitOfWork(async (repos) => {
      const existing = await repos.apiKeys.find(scope, input.keyId);
      if (existing === null) throw new AppError('not_found', 'Not found', 404);

      const revoked = await repos.apiKeys.revoke(scope, {
        keyId: input.keyId,
        revokedBy: input.actor.userId,
        at: this.now(),
      });

      if (revoked) {
        await repos.auditLogs.append(
          scope,
          buildAuditEntry({
            id: this.options.newId(),
            actor: { type: 'user', id: input.actor.userId },
            action: 'api_key.revoked',
            resourceType: 'api_key',
            resourceId: input.keyId,
            before: { name: existing.name, scopes: existing.scopes },
          }),
        );
      }

      // False means it was already revoked. Not an error: revoking twice is
      // what somebody does when they are not sure the first one worked, and
      // the answer they need is "it is revoked".
      return { revoked };
    });
  }

  /** The scopes a given role may grant, for the UI's checkbox list. */
  grantableScopes(role: WorkspaceRole): Permission[] {
    return PERMISSIONS.filter(
      (permission) => canApiKeyHold(permission) && can(role, permission),
    );
  }
}

/** Deduplicated, and only values that are actually permissions. */
function normaliseScopes(scopes: readonly string[]): Permission[] {
  const known = new Set<string>(PERMISSIONS);
  const seen = new Set<string>();
  const out: Permission[] = [];

  for (const scope of scopes) {
    if (!known.has(scope) || seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope as Permission);
  }

  return out;
}

/**
 * When a key expires, bounded.
 *
 * Undefined means the caller did not ask, and gets the maximum rather than
 * never: a key with no expiry is one nobody revokes because nobody remembers
 * it exists.
 */
export function expiryFor(now: Date, days: number | undefined): Date | null {
  const requested = days ?? MAX_KEY_LIFETIME_DAYS;
  if (!Number.isFinite(requested) || requested <= 0) return null;

  const bounded = Math.min(MAX_KEY_LIFETIME_DAYS, Math.floor(requested));
  return new Date(now.getTime() + bounded * 86_400_000);
}

function toPublic(row: ApiKeyRow): PublicApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
