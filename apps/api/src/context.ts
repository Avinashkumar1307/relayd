import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '@relayd/types';
import type { Permission, UserId, WorkspaceRole } from '@relayd/types';
import type { WorkspaceScope } from '@relayd/db';

/**
 * Request-scoped context, per docs/01: "Request-scoped context (requestId,
 * userId, workspaceId, actor) via AsyncLocalStorage, never passed manually
 * through 6 layers."
 *
 * Established once per request and filled in as the middleware chain learns
 * more: the principal after authentication, the workspace after membership is
 * resolved. Reading it before the corresponding middleware has run throws
 * rather than returning undefined, so a route that forgot to require a
 * workspace fails loudly instead of quietly acting unscoped.
 */

export interface Principal {
  userId: UserId;
  sessionId: string;
  /** Workspaces the token was minted for. Not authorization on its own. */
  workspaceIds: readonly string[];
  tokenVersion: number;
}

export interface WorkspaceContext {
  scope: WorkspaceScope;
  role: WorkspaceRole;
  permissions: readonly Permission[];
}

interface MutableRequestContext {
  principal?: Principal;
  workspace?: WorkspaceContext;
}

const storage = new AsyncLocalStorage<MutableRequestContext>();

/** Opens a context for one request. */
export function runWithRequestContext<T>(fn: () => T): T {
  return storage.run({}, fn);
}

export function setPrincipal(principal: Principal): void {
  const context = storage.getStore();
  if (context !== undefined) context.principal = principal;
}

export function setWorkspaceContext(workspace: WorkspaceContext): void {
  const context = storage.getStore();
  if (context !== undefined) context.workspace = workspace;
}

/** The authenticated principal, or undefined on an unauthenticated route. */
export function tryGetPrincipal(): Principal | undefined {
  return storage.getStore()?.principal;
}

/**
 * The authenticated principal, or a 401.
 *
 * Throws rather than returning undefined so a handler cannot accidentally
 * treat "nobody is logged in" as a valid caller.
 */
export function requirePrincipal(): Principal {
  const principal = tryGetPrincipal();
  if (principal === undefined) {
    throw new AppError('unauthenticated', 'Authentication required', 401);
  }
  return principal;
}

/** The resolved workspace, or undefined if no workspace middleware ran. */
export function tryGetWorkspaceContext(): WorkspaceContext | undefined {
  return storage.getStore()?.workspace;
}

/**
 * The resolved workspace, or an internal error.
 *
 * A handler reaching this without the workspace middleware having run is a
 * routing mistake, not a client error — so it is a 500, deliberately. The
 * alternative, defaulting to some workspace, is how cross-tenant leaks happen.
 */
export function requireWorkspaceContext(): WorkspaceContext {
  const workspace = storage.getStore()?.workspace;
  if (workspace === undefined) {
    throw new AppError(
      'internal_error',
      'Route requires a workspace but no workspace middleware ran',
      500,
    );
  }
  return workspace;
}

export function requireScope(): WorkspaceScope {
  return requireWorkspaceContext().scope;
}
