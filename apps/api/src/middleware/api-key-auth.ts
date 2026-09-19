import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, PERMISSIONS, canApiKeyHold } from '@relayd/types';
import type { Permission, WorkspaceId } from '@relayd/types';
import { workspaceScope } from '@relayd/db';
import type { GlobalApiKeyRepository } from '@relayd/db';
import { hashToken } from '@relayd/utils';
import { updateTraceContext } from '@relayd/logger';
import { setApiKeyPrincipal, setWorkspaceContext, tryGetApiKeyPrincipal } from '../context.js';

/**
 * API key authentication (docs/03, docs/06; CLAUDE.md section 11).
 *
 * A key is not a session. It has no user, no refresh, no MFA and no role — it
 * has a workspace and a scope list, and that is deliberately all. What
 * follows from that:
 *
 *   **The workspace comes from the key, never the header.** A key is bound to
 *   one workspace at issue. `X-Workspace-Id` is optional and, if sent, must
 *   match — sending a different one is a mistake worth reporting rather than
 *   a header worth ignoring.
 *
 *   **`billing:write` is re-checked here**, not only at issue. The forbidden
 *   set can grow, and a key minted before a permission was forbidden must
 *   stop carrying it the moment it is. Checking only at issue would make the
 *   rule true for new keys and false for exactly the old ones nobody is
 *   watching.
 *
 *   **Revocation is immediate.** The row is read on every request and
 *   `revoked_at` is checked on the row we just read. There is no cache, so
 *   there is no window.
 *
 * Every failure is the same 401 with the same message, except revocation and
 * expiry, which say so. Distinguishing "no such key" from "bad signature"
 * would tell an attacker which half of a guess to keep; telling the holder of
 * a real key that it was revoked tells them nothing they could not learn by
 * looking at their own dashboard, and saves a support ticket.
 */

const BEARER = 'Bearer ';
const KEY_PREFIX = 'rk_live_';
const WORKSPACE_HEADER = 'x-workspace-id';

/** A key is `rk_live_` plus 43 base64url characters. Bounded before any query. */
const KEY_SHAPE = /^rk_live_[A-Za-z0-9_-]{32,64}$/u;

/** Whether an Authorization header carries an API key rather than a session token. */
export function isApiKeyCredential(header: string | undefined): boolean {
  if (header === undefined || !header.startsWith(BEARER)) return false;
  return header.slice(BEARER.length).startsWith(KEY_PREFIX);
}

export interface ApiKeyAuthOptions {
  apiKeys: GlobalApiKeyRepository;
  now?: () => Date;
  /** Records use, at most once per staleness window. Failures are swallowed. */
  touch?: (keyId: string, now: Date) => Promise<void>;
  shouldTouch?: (lastUsedAt: Date | null, now: Date) => boolean;
}

/**
 * Authenticates an API key and establishes its workspace.
 *
 * Does the work of `authenticate` and `requireWorkspace` together, because
 * for a key they are the same question: the credential *is* the workspace
 * binding, and there is no membership to look up.
 */
export function authenticateApiKey(options: ApiKeyAuthOptions): RequestHandler {
  const now = options.now ?? (() => new Date());

  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization');

    if (header === undefined || !header.startsWith(BEARER)) {
      next(new AppError('unauthenticated', 'Authentication required', 401));
      return;
    }

    const credential = header.slice(BEARER.length);

    // Shape first, so a scanner spraying garbage costs a regex rather than a
    // hash and an index probe.
    if (!KEY_SHAPE.test(credential)) {
      next(new AppError('invalid_api_key', 'Invalid API key', 401));
      return;
    }

    const resolved = await options.apiKeys.resolve(hashToken(credential));

    if (resolved === null) {
      next(new AppError('invalid_api_key', 'Invalid API key', 401));
      return;
    }

    const at = now();

    if (resolved.revokedAt !== null) {
      // Said plainly. The holder of a revoked key learns nothing they could
      // not read on their own dashboard, and "invalid" would send them
      // hunting for a typo.
      next(new AppError('invalid_api_key', 'This API key has been revoked', 401));
      return;
    }

    if (resolved.expiresAt !== null && resolved.expiresAt.getTime() <= at.getTime()) {
      next(new AppError('invalid_api_key', 'This API key has expired', 401));
      return;
    }

    const requested = req.get(WORKSPACE_HEADER);
    if (requested !== undefined && requested.length > 0 && requested !== resolved.workspaceId) {
      // Not a 404. The caller holds a valid credential for a workspace and
      // asked about a different one; that is a mistake in their client, and
      // reporting it as "not found" sends them looking in the wrong place.
      next(
        new AppError(
          'validation_failed',
          'This key belongs to a different workspace',
          400,
        ),
      );
      return;
    }

    const scopes = usableScopes(resolved.scopes);

    setApiKeyPrincipal({
      keyId: resolved.id,
      workspaceId: resolved.workspaceId,
      name: resolved.name,
      scopes,
    });

    setWorkspaceContext({
      scope: workspaceScope(resolved.workspaceId as WorkspaceId),
      // A key has no role. `viewer` is the floor, so any code that reaches
      // for the role rather than the scopes gets the least it could have —
      // and `requireScopeOrPermission` below never consults it.
      role: 'viewer',
      permissions: scopes,
    });

    updateTraceContext({ workspaceId: resolved.workspaceId, apiKeyId: resolved.id });

    // Fire and forget. A failure recording that a key was used must not fail
    // the request it describes.
    if (options.touch !== undefined && (options.shouldTouch?.(resolved.lastUsedAt, at) ?? false)) {
      void options.touch(resolved.id, at).catch(() => undefined);
    }

    next();
  };
}

/**
 * The scopes a key may actually exercise right now.
 *
 * Two filters, and both matter. A stored scope that is no longer a known
 * permission is dropped, because a renamed permission must not keep working
 * under its old name. And `canApiKeyHold` is re-applied, because the
 * forbidden set can grow after a key is minted.
 */
export function usableScopes(stored: readonly string[]): Permission[] {
  const known = new Set<string>(PERMISSIONS);

  return stored.filter(
    (scope): scope is Permission => known.has(scope) && canApiKeyHold(scope as Permission),
  );
}

/**
 * Requires a scope of the key, or the equivalent permission of a user.
 *
 * One middleware for both credentials so a route cannot accidentally be
 * reachable by a key and not by a person, or the reverse. A key is checked
 * against its scopes; a user falls through to the role matrix.
 */
export function requireScopeOrPermission(
  permission: Permission,
  userCheck: RequestHandler,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const apiKey = tryGetApiKeyPrincipal();

    if (apiKey === undefined) {
      userCheck(req, res, next);
      return;
    }

    if (!apiKey.scopes.includes(permission)) {
      next(
        new AppError(
          'insufficient_permission',
          `This API key does not have ${permission}`,
          403,
        ),
      );
      return;
    }

    next();
  };
}

/**
 * Refuses a request made with an API key.
 *
 * For the routes a key must never reach whatever its scopes say — billing
 * writes, key management itself. A key that could mint another key would make
 * revocation a game of whack-a-mole.
 */
export function refuseApiKey(): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction) => {
    if (tryGetApiKeyPrincipal() !== undefined) {
      next(
        new AppError(
          'insufficient_permission',
          'This endpoint cannot be used with an API key',
          403,
        ),
      );
      return;
    }

    next();
  };
}
