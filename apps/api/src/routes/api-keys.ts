import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError, PERMISSIONS } from '@relayd/types';
import type { GlobalMembershipRepository } from '@relayd/db';
import { requireScope, requireWorkspaceContext, requirePrincipal } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import { refuseApiKey } from '../middleware/api-key-auth.js';
import { MAX_KEY_LIFETIME_DAYS, type ApiKeyService } from '../services/api-keys.js';
import type { TokenService } from '../services/tokens.js';

/**
 * API key management (docs/03, CLAUDE.md section 11).
 *
 * Every route here refuses an API key, whatever its scopes. A key that could
 * mint another key makes revocation a game of whack-a-mole: revoke the leaked
 * one and the key it quietly created keeps working. Key management is a thing
 * a person does, signed in, and `refuseApiKey` says so in one place rather
 * than being remembered per route.
 *
 * `apikey:write` gates all three. There is no `apikey:read` in the matrix and
 * this file does not invent one: the list carries prefixes, scopes and
 * last-used times, which is a map of what a workspace has integrated, and
 * that belongs with the people who can change it rather than with everyone
 * who can read a contact.
 *
 * Note that `apikey:write` is deliberately *not* added to the set a key may
 * never hold. The route guard is the stronger statement — it refuses a key on
 * these paths whatever its scopes, so there is no scope list to get wrong.
 */

export interface ApiKeyRouterOptions {
  apiKeys: ApiKeyService;
  tokens: TokenService;
  memberships: GlobalMembershipRepository;
}

const issueSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
  /**
   * Bounded, and defaulted by the service rather than here. A key with no
   * expiry is one nobody revokes because nobody remembers it exists.
   */
  expiresInDays: z.number().int().min(1).max(MAX_KEY_LIFETIME_DAYS).optional(),
});

export function apiKeyRoutes(options: ApiKeyRouterOptions): Router {
  const router = Router();
  const { apiKeys } = options;

  const auth = authenticate(options.tokens);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const noKeys = refuseApiKey();

  const manage = [auth, workspace, noKeys, requirePermission('apikey:write')] as const;

  router.get('/api-keys', ...manage, async (_req: Request, res: Response) => {
    res.json({ data: await apiKeys.list(requireScope()) });
  });

  /**
   * The scopes this caller may grant.
   *
   * Their own role intersected with what a key may ever hold, so the UI can
   * render the checkboxes that will actually work rather than offering
   * `billing:write` and letting the POST refuse it.
   */
  router.get('/api-keys/scopes', ...manage, (_req: Request, res: Response) => {
    res.json({ data: { scopes: apiKeys.grantableScopes(requireWorkspaceContext().role) } });
  });

  /**
   * Issues a key. 201 with the key in the body, exactly once.
   *
   * Cache-Control: no-store, because the one thing that must not happen to a
   * one-time reveal is a proxy keeping a copy.
   */
  router.post('/api-keys', ...manage, async (req: Request, res: Response) => {
    const parsed = issueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        'validation_failed',
        'Invalid API key request',
        400,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const principal = requirePrincipal();
    const { expiresInDays, ...rest } = parsed.data;

    const issued = await apiKeys.issue(requireScope(), {
      ...rest,
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
      actor: { userId: principal.userId, role: requireWorkspaceContext().role },
    });

    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      data: {
        ...issued.row,
        // The only response that ever carries this. Named so the client
        // cannot mistake it for something it can fetch again.
        keyShownOnce: issued.key,
      },
    });
  });

  router.delete('/api-keys/:id', ...manage, async (req: Request, res: Response) => {
    const principal = requirePrincipal();

    const result = await apiKeys.revoke(requireScope(), {
      keyId: String(req.params['id'] ?? ''),
      actor: { userId: principal.userId },
    });

    // 200 rather than 204: the body says whether this call was the one that
    // revoked it, which is what a client retrying an uncertain request needs.
    res.json({ data: result });
  });

  return router;
}
