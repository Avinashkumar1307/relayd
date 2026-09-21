import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { AppError, WORKSPACE_ROLES } from '@relayd/types';
import type { UserId, WorkspaceInvitationId, WorkspaceRole } from '@relayd/types';
import type { GlobalMembershipRepository } from '@relayd/db';
import {
  createWorkspaceSchema,
  emailSchema,
  registerViaInvitationSchema,
  transferOwnershipSchema,
} from '@relayd/validation';
import {
  requirePrincipal,
  requireScope,
  requireWorkspaceContext,
  tryGetApiKeyPrincipal,
} from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import type { ApiKeyAuthOptions } from '../middleware/api-key-auth.js';
import {
  ipRateKey,
  rateLimit,
  RATE_LIMITS,
  type RateLimitStore,
} from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import type { SessionContext } from '../services/auth.js';
import type { TokenService } from '../services/tokens.js';
import type { WorkspaceService } from '../services/workspaces.js';

/**
 * Workspace routes.
 *
 * Every one of these sits behind authenticate → requireWorkspace →
 * requirePermission, in that order. The order is the security property: a
 * non-member is turned away by requireWorkspace with a 404 before any
 * permission is consulted, so 403 is only ever reachable by someone who is
 * already inside (docs/06 section 15).
 *
 * The workspace comes from the X-Workspace-Id header, never from the path, so
 * there is no id in a URL to tamper with and every route reads the same
 * resolved scope.
 */

const updateWorkspaceSchema = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

const changeRoleSchema = z.object({ role: z.enum(WORKSPACE_ROLES) }).strict();

const inviteSchema = z
  .object({
    email: emailSchema,
    // Owner is absent deliberately: ownership transfers, it is not emailed.
    role: z.enum(['admin', 'editor', 'viewer']),
  })
  .strict();

const acceptInvitationSchema = z.object({ token: z.string().min(1).max(512) }).strict();

/**
 * Signs in the account the signed-out join path just created, exactly as
 * `POST /auth/register` does: issue the session, set the refresh cookie,
 * write the body.
 *
 * It is a callback rather than an `AuthService` reference because the refresh
 * cookie's name, path and flags are defined in `routes/auth.ts` and must stay
 * defined in one place — a second copy of them here is a second thing to get
 * wrong the day `secure` or `sameSite` changes.
 */
export type SignInNewAccount = (
  res: Response,
  credentials: { email: string; password: string },
  context: SessionContext,
) => Promise<void>;

export interface WorkspaceRouterOptions {
  workspaces: WorkspaceService;
  tokens: TokenService;
  /**
   * Accepts API keys as well as session tokens when wired.
   *
   * Absent in a deployment or a test that has no key store, and then a
   * key-shaped credential falls through to JWT verification and is refused
   * there — never accepted slowly.
   */
  apiKeys?: ApiKeyAuthOptions;
  memberships: GlobalMembershipRepository;
  /** Resolves the caller's email, needed to match an invitation. */
  lookupUserEmail: (userId: UserId) => Promise<string | null>;
  /**
   * Signs the new account in on the signed-out join path.
   *
   * Absent in a deployment that has not wired it, and then the account and
   * the membership are still created and the response says where they landed
   * — the client has to sign in rather than arriving signed in.
   */
  signInNewAccount?: SignInNewAccount;
  /**
   * Backs the per-IP limit on the two unauthenticated invitation routes.
   *
   * Absent in tests that do not exercise it. Those routes take a bearer token
   * in a URL from anyone at all, which is the one place in this router where
   * an anonymous caller can make us do work.
   */
  rateLimitStore?: RateLimitStore;
}

/**
 * Ownership transfer is the owner's alone, and no API key may do it.
 *
 * There is no permission in the matrix for it — docs/06 has no row — so this
 * reads the role directly rather than inventing one. Only reachable after
 * `requireWorkspace`, so the caller is already known to be a member and a 403
 * tells them nothing they did not know.
 */
function requireOwner(_req: Request, _res: Response, next: NextFunction): void {
  if (tryGetApiKeyPrincipal() !== undefined) {
    next(
      new AppError(
        'insufficient_permission',
        'Ownership can only be transferred by a signed-in owner, not by an API key',
        403,
      ),
    );
    return;
  }

  if (requireWorkspaceContext().role !== 'owner') {
    next(
      new AppError('insufficient_permission', 'Only the owner can transfer ownership', 403),
    );
    return;
  }

  next();
}

/** The user agent and address an audit row and a session record carry. */
function sessionContext(req: Request): SessionContext {
  const userAgent = req.get('user-agent');
  return {
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(req.ip === undefined ? {} : { ip: req.ip }),
  };
}

/**
 * A per-IP limit for the routes anyone can call, or nothing when no store is
 * wired. Ten a minute, docs/06's budget for unauthenticated auth routes.
 */
function anonymousLimit(store: RateLimitStore | undefined, prefix: string): RequestHandler[] {
  return store === undefined
    ? []
    : [rateLimit({ store, rule: RATE_LIMITS.auth, keyFor: ipRateKey(prefix) })];
}

export function workspaceRoutes(options: WorkspaceRouterOptions): Router {
  const router = Router();
  const { workspaces } = options;

  const auth = authenticate(options.tokens, options.apiKeys);
  const workspace = requireWorkspace({ memberships: options.memberships });

  /**
   * Creates a workspace and makes the caller its owner (B6a).
   *
   * Authenticated but NOT workspace-scoped: there is no workspace to resolve
   * yet, and requiring one would make the second workspace impossible to
   * create from the first.
   *
   * An API key cannot do this. A key is bound to one workspace and there is
   * no user behind it to own a new one, so it is refused explicitly rather
   * than left to fail further in as a missing principal.
   */
  router.post(
    '/',
    auth,
    validateBody(createWorkspaceSchema),
    async (req: Request, res: Response) => {
      if (tryGetApiKeyPrincipal() !== undefined) {
        throw new AppError(
          'insufficient_permission',
          'An API key belongs to one workspace and cannot create another',
          403,
        );
      }

      const principal = requirePrincipal();
      const body = req.body as { name: string; slug: string; timezone?: string };

      const created = await workspaces.createWorkspace({
        ownerUserId: principal.userId,
        name: body.name,
        slug: body.slug,
        ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
      });

      // The caller's access token does not carry the new workspace in wsIds;
      // the client refreshes to pick it up, as it does after accepting an
      // invitation.
      res.status(201).json({ data: created });
    },
  );

  router.get('/current', auth, workspace, requirePermission('workspace:read'), async (_req, res) => {
    res.json({
      data: {
        ...(await workspaces.details(requireScope())),
        // The caller's own role, so the UI can gate without a second request.
        // Not part of the workspace: it is a property of who is asking, which
        // is why it is added here and not in the service.
        role: requireWorkspaceContext().role,
      },
    });
  });

  router.patch(
    '/current',
    auth,
    workspace,
    requirePermission('workspace:update'),
    validateBody(updateWorkspaceSchema),
    async (req: Request, res: Response) => {
      const updated = await workspaces.updateDetails(requireScope(), req.body as never);
      // Deliberately the same body GET answers with, role included: J1 writes
      // the response back into the record the page is rendering from, and a
      // narrower one would blank the workspace id, the slug and the read-only
      // card the moment somebody renamed the workspace.
      res.json({ data: { ...updated, role: requireWorkspaceContext().role } });
    },
  );

  router.delete(
    '/current',
    auth,
    workspace,
    requirePermission('workspace:delete'),
    async (_req, res) => {
      await workspaces.softDelete(requireScope());
      res.status(204).send();
    },
  );

  router.get(
    '/current/members',
    auth,
    workspace,
    requirePermission('workspace:read'),
    async (_req, res) => {
      res.json({ data: await workspaces.listMembers(requireScope()) });
    },
  );

  router.patch(
    '/current/members/:userId',
    auth,
    workspace,
    requirePermission('member:invite'),
    validateBody(changeRoleSchema),
    async (req: Request, res: Response) => {
      const updated = await workspaces.changeMemberRole(
        requireScope(),
        req.params['userId'] as UserId,
        (req.body as { role: WorkspaceRole }).role,
      );
      res.json({ data: updated });
    },
  );

  router.delete(
    '/current/members/:userId',
    auth,
    workspace,
    requirePermission('member:remove'),
    async (req: Request, res: Response) => {
      await workspaces.removeMember(requireScope(), req.params['userId'] as UserId);
      res.status(204).send();
    },
  );

  router.get(
    '/current/invitations',
    auth,
    workspace,
    requirePermission('member:invite'),
    async (_req, res) => {
      // The service already answers exactly J2a's row — id, address, role,
      // expiry and who sent it — and never the token hash, so there is
      // nothing here to strip.
      res.json({ data: await workspaces.listInvitations(requireScope()) });
    },
  );

  router.post(
    '/current/invitations',
    auth,
    workspace,
    requirePermission('member:invite'),
    validateBody(inviteSchema),
    async (req: Request, res: Response) => {
      const principal = requirePrincipal();
      const current = await workspaces.get(requireScope());
      const body = req.body as { email: string; role: 'admin' | 'editor' | 'viewer' };

      const created = await workspaces.invite(requireScope(), {
        email: body.email,
        role: body.role,
        invitedBy: principal.userId,
        workspaceName: current.name,
      });

      // The token is emailed, never returned: an API response is logged,
      // proxied and stored in ways an inbox is not.
      res.status(201).json({ data: created });
    },
  );

  router.delete(
    '/current/invitations/:id',
    auth,
    workspace,
    requirePermission('member:invite'),
    async (req: Request, res: Response) => {
      await workspaces.revokeInvitation(
        requireScope(),
        req.params['id'] as WorkspaceInvitationId,
      );
      res.status(204).send();
    },
  );

  /**
   * Sends the invitation again (J2's "Resend").
   *
   * No body: everything it needs is the invitation it names. The cooldown
   * that keeps this from becoming a mail-bombing button lives in the service,
   * against the invitation row, so two tabs cannot each spend it.
   */
  router.post(
    '/current/invitations/:id/resend',
    auth,
    workspace,
    requirePermission('member:invite'),
    async (req: Request, res: Response) => {
      const current = await workspaces.get(requireScope());

      const resent = await workspaces.resendInvitation(
        requireScope(),
        req.params['id'] as WorkspaceInvitationId,
        { workspaceName: current.name },
      );

      // The token is emailed, never returned.
      res.json({ data: resent });
    },
  );

  /**
   * Hands ownership to another member (J2).
   *
   * Owner-only, and the service re-reads the caller's membership inside the
   * transaction rather than trusting the role the middleware resolved a few
   * milliseconds earlier.
   */
  router.post(
    '/current/transfer-ownership',
    auth,
    workspace,
    requireOwner,
    validateBody(transferOwnershipSchema),
    async (req: Request, res: Response) => {
      const principal = requirePrincipal();

      const result = await workspaces.transferOwnership(requireScope(), {
        fromUserId: principal.userId,
        toUserId: (req.body as { userId: string }).userId as UserId,
      });

      res.json({ data: result });
    },
  );

  return router;
}

/**
 * Accepting an invitation is authenticated but NOT workspace-scoped: the
 * caller is not a member yet, so requireWorkspace would 404 them out of the
 * workspace they were invited to.
 */
export function invitationRoutes(options: WorkspaceRouterOptions): Router {
  const router = Router();

  router.post(
    '/accept',
    authenticate(options.tokens, options.apiKeys),
    validateBody(acceptInvitationSchema),
    async (req: Request, res: Response) => {
      const principal = requirePrincipal();
      const email = await options.lookupUserEmail(principal.userId);

      if (email === null) {
        res.status(404).json({ data: null });
        return;
      }

      const result = await options.workspaces.acceptInvitation(
        (req.body as { token: string }).token,
        { id: principal.userId, email },
      );

      res.json({ data: result });
    },
  );

  /**
   * Creates the invited account and joins the workspace, in one transaction
   * (B5b, the signed-out half).
   *
   * Unauthenticated by necessity: the whole point is that the visitor has no
   * account yet. The address is the invitation's, so the body carries a name
   * and a password and nothing else — an email field here would be a way to
   * register under someone else's invitation.
   */
  router.post(
    '/:token/register',
    ...anonymousLimit(options.rateLimitStore, 'invite'),
    validateBody(registerViaInvitationSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { name: string; password: string };

      const joined = await options.workspaces.registerAndAcceptInvitation(
        req.params['token'] as string,
        body,
      );

      if (options.signInNewAccount !== undefined) {
        // Same envelope and the same refresh cookie as POST /auth/register,
        // so the client can adopt the session it just created rather than
        // sending someone who has typed a password once to a sign-in form.
        await options.signInNewAccount(
          res,
          { email: joined.email, password: body.password },
          sessionContext(req),
        );
        return;
      }

      res.status(201).json({
        data: { workspaceId: joined.workspaceId, role: joined.role, email: joined.email },
      });
    },
  );

  /**
   * What the invitation says, without accepting it (B5).
   *
   * Declared last. `/accept` is also one segment, and although a GET cannot
   * shadow that POST today, Express matches in declaration order and this
   * order is the one that stays correct if either ever gains a sibling.
   */
  router.get(
    '/:token',
    ...anonymousLimit(options.rateLimitStore, 'invite'),
    async (req: Request, res: Response) => {
      const preview = await options.workspaces.previewInvitation(req.params['token'] as string);
      res.json({ data: preview });
    },
  );

  return router;
}
