import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, can, permissionsFor } from '@relayd/types';
import type { Permission, WorkspaceId } from '@relayd/types';
import { workspaceScope } from '@relayd/db';
import type { GlobalMembershipRepository } from '@relayd/db';
import { updateTraceContext } from '@relayd/logger';
import {
  runWithRequestContext,
  setPrincipal,
  setWorkspaceContext,
  tryGetApiKeyPrincipal,
  tryGetPrincipal,
  tryGetWorkspaceContext,
} from '../context.js';
import { authenticateApiKey, isApiKeyCredential, type ApiKeyAuthOptions } from './api-key-auth.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Layers one and two of the four in docs/06 section 15.
 *
 * L1 resolves the principal and their membership. L2 checks the permission
 * matrix. L3 is the WorkspaceScope-typed repository and L4 is Postgres RLS;
 * all four must fail before workspace A reads workspace B.
 */

const WORKSPACE_HEADER = 'x-workspace-id';

/** Opens the request-scoped context. Must run before any of the others. */
export function requestContext(_req: Request, _res: Response, next: NextFunction): void {
  runWithRequestContext(() => {
    next();
  });
}

/**
 * Verifies the bearer token and records the principal.
 *
 * Every failure is the same 401 with the same message. Distinguishing
 * "expired" from "malformed" from "wrong signature" tells an attacker which
 * part of a forged token to fix next.
 */
export function authenticate(tokens: TokenService, apiKeys?: ApiKeyAuthOptions): RequestHandler {
  // Built once rather than per request: the key path is the same middleware
  // either way, and constructing it inside the handler would rebuild a
  // closure on every call for no reason.
  const keyPath = apiKeys === undefined ? null : authenticateApiKey(apiKeys);

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization');

    if (header === undefined || !header.startsWith('Bearer ')) {
      next(new AppError('unauthenticated', 'Authentication required', 401));
      return;
    }

    // `rk_live_` is the fork. A session token and an API key are different
    // credentials answering to different rules, and deciding by shape here
    // means every route gets both without knowing about either.
    //
    // When no key options are wired, a key-shaped credential falls through to
    // JWT verification and is refused there — a deployment without the key
    // path must not accept keys, not even slowly.
    if (keyPath !== null && isApiKeyCredential(header)) {
      keyPath(req, res, next);
      return;
    }

    try {
      const claims = await tokens.verifyAccessToken(header.slice('Bearer '.length));
      setPrincipal({
        userId: claims.sub,
        sessionId: claims.sid,
        workspaceIds: claims.wsIds,
        tokenVersion: claims.ver,
      });
      updateTraceContext({ userId: claims.sub });
      next();
    } catch {
      next(new AppError('unauthenticated', 'Authentication required', 401));
    }
  };
}

export interface WorkspaceMiddlewareOptions {
  /**
   * Resolves membership. Cross-tenant by necessity: the question is which
   * workspace the caller may enter, so the answer cannot be scoped to one.
   */
  memberships: GlobalMembershipRepository;
}

/**
 * Resolves the workspace from the X-Workspace-Id header and the caller's
 * membership of it.
 *
 * A caller who is not a member gets 404, never 403. docs/06: "A request with
 * no resolvable membership gets 404, not 403 — never confirm a workspace
 * exists to a non-member." 403 means "you are a member and this is above your
 * role", which is information only a member is entitled to.
 *
 * Membership is re-read from the database on every request rather than
 * trusted from the token's wsIds claim. A 15-minute access token outlives a
 * role change or a removal; treating its claims as authorization would make
 * every revocation take up to fifteen minutes to bite.
 */
export function requireWorkspace(options: WorkspaceMiddlewareOptions): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // An API key already resolved its workspace, from the key itself. There
    // is no membership to look up: a key belongs to one workspace and has no
    // user behind it whose role could have changed.
    if (tryGetApiKeyPrincipal() !== undefined) {
      next();
      return;
    }

    const principal = tryGetPrincipal();
    if (principal === undefined) {
      next(new AppError('unauthenticated', 'Authentication required', 401));
      return;
    }

    const header = req.get(WORKSPACE_HEADER);
    if (header === undefined || header.length === 0) {
      next(new AppError('validation_failed', `${WORKSPACE_HEADER} header is required`, 400));
      return;
    }

    const membership = await options.memberships.findMembership(
      principal.userId,
      header as WorkspaceId,
    );

    if (membership === null) {
      // Also the answer for a workspace id that does not exist, is deleted, or
      // is malformed. All four are indistinguishable from outside, which is
      // the point.
      next(new AppError('not_found', 'Not found', 404));
      return;
    }

    setWorkspaceContext({
      scope: workspaceScope(membership.workspaceId),
      role: membership.role,
      permissions: permissionsFor(membership.role),
    });
    updateTraceContext({ workspaceId: membership.workspaceId });
    next();
  };
}

/**
 * Requires a permission of the caller's role in the resolved workspace.
 *
 * Only reachable after requireWorkspace, so the caller is known to be a
 * member. A member lacking the permission gets 403 — at this point their
 * membership is not a secret from them.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction) => {
    const apiKey = tryGetApiKeyPrincipal();

    if (apiKey !== undefined) {
      // A key is checked against its scopes, never against a role. It has no
      // role, and the floor one it is given for the sake of the context type
      // must never be what authorises anything.
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
      return;
    }

    const workspace = tryGetWorkspaceContext();

    if (workspace === undefined) {
      next(
        new AppError(
          'internal_error',
          'requirePermission used without requireWorkspace',
          500,
        ),
      );
      return;
    }

    if (!can(workspace.role, permission)) {
      next(
        new AppError(
          'insufficient_permission',
          `This action requires ${permission}`,
          403,
        ),
      );
      return;
    }

    next();
  };
}
