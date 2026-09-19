import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { WORKSPACE_ROLES } from '@relayd/types';
import type { UserId, WorkspaceInvitationId, WorkspaceRole } from '@relayd/types';
import type { GlobalMembershipRepository } from '@relayd/db';
import { emailSchema } from '@relayd/validation';
import { requirePrincipal, requireScope, requireWorkspaceContext } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import type { ApiKeyAuthOptions } from '../middleware/api-key-auth.js';
import { validateBody } from '../middleware/validate.js';
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
}

export function workspaceRoutes(options: WorkspaceRouterOptions): Router {
  const router = Router();
  const { workspaces } = options;

  const auth = authenticate(options.tokens, options.apiKeys);
  const workspace = requireWorkspace({ memberships: options.memberships });

  router.get('/current', auth, workspace, requirePermission('workspace:read'), async (_req, res) => {
    const found = await workspaces.get(requireScope());
    res.json({
      data: {
        id: found.id,
        name: found.name,
        slug: found.slug,
        timezone: found.timezone,
        // The caller's own role, so the UI can gate without a second request.
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
      res.json({ data: { id: updated.id, name: updated.name, timezone: updated.timezone } });
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
      const pending = await workspaces.listInvitations(requireScope());
      res.json({
        data: pending.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
        })),
      });
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

  return router;
}
