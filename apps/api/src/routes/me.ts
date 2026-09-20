import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '@relayd/types';
import type { SessionId } from '@relayd/types';
import {
  changePasswordSchema,
  startEmailChangeSchema,
  updateProfileSchema,
} from '@relayd/validation';
import { requirePrincipal } from '../context.js';
import { authenticate } from '../middleware/authorize.js';
import { validateBody } from '../middleware/validate.js';
import type { ProfileService } from '../services/profile.js';
import type { TokenService } from '../services/tokens.js';

/**
 * `/me` — the signed-in person, across every workspace (design frame J5).
 *
 * ## Why there is no workspace middleware on this router
 *
 * Nothing here is workspace-scoped, so nothing here is gated by a workspace
 * role or by a suspended workspace. A person whose only workspace is past due
 * must still be able to change their own password; making that depend on a
 * billing state would be a lockout with no way out.
 *
 * ## Why API keys cannot reach it
 *
 * `authenticate` is wired WITHOUT the key path, so a key-shaped credential
 * falls through to JWT verification and is refused there — never accepted
 * slowly. This is not belt and braces: an API key belongs to a workspace and
 * has no person behind it, so "change my password" has no meaning for one, and
 * a key that could rotate its minter's credentials would be a privilege
 * escalation out of its own scope.
 *
 * The caller's identity comes from the verified token on every route
 * (`requirePrincipal`) and never from the path or the body. The one path
 * parameter, a session id, is checked against the caller's own live sessions
 * in the service and answers 404 when it is not theirs.
 */

const sessionIdSchema = z.string().uuid();

export interface MeRouterOptions {
  profile: ProfileService;
  tokens: TokenService;
}

export function meRoutes(options: MeRouterOptions): Router {
  const router = Router();
  const { profile } = options;

  // No apiKeys argument. See the note above.
  const auth = authenticate(options.tokens);

  router.get('/me', auth, async (_req: Request, res: Response) => {
    res.json({ data: await profile.get(requirePrincipal().userId) });
  });

  router.patch(
    '/me',
    auth,
    validateBody(updateProfileSchema),
    async (req: Request, res: Response) => {
      const { name } = req.body as { name: string };
      res.json({ data: await profile.updateName(requirePrincipal().userId, name) });
    },
  );

  router.post(
    '/me/password',
    auth,
    validateBody(changePasswordSchema),
    async (req: Request, res: Response) => {
      const principal = requirePrincipal();
      const body = req.body as { currentPassword: string; newPassword: string };

      const result = await profile.changePassword({
        userId: principal.userId,
        // From the token, not the body: the session being kept alive must be
        // the one making the request.
        sessionId: principal.sessionId as SessionId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });

      res.json({ data: { changed: true, otherSessionsRevoked: result.otherSessionsRevoked } });
    },
  );

  router.post(
    '/me/email-change',
    auth,
    validateBody(startEmailChangeSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { newEmail: string; currentPassword: string };

      const result = await profile.startEmailChange({
        userId: requirePrincipal().userId,
        newEmail: body.newEmail,
        currentPassword: body.currentPassword,
      });

      // 202: the address has not changed yet and will not until the link in
      // the new inbox is clicked. 200 would say it was done.
      res.status(202).json({ data: result });
    },
  );

  router.get('/me/sessions', auth, async (_req: Request, res: Response) => {
    const principal = requirePrincipal();
    res.json({
      data: await profile.listSessions(principal.userId, principal.sessionId as SessionId),
    });
  });

  router.delete('/me/sessions/:id', auth, async (req: Request, res: Response) => {
    const parsed = sessionIdSchema.safeParse(req.params['id']);
    if (!parsed.success) {
      // A malformed id and somebody else's id are the same answer, so a bad
      // shape cannot be used to tell "no such session" from "not yours".
      throw new AppError('not_found', 'Session not found', 404);
    }

    await profile.revokeSession(requirePrincipal().userId, parsed.data as SessionId);
    res.status(204).send();
  });

  router.delete('/me/sessions', auth, async (_req: Request, res: Response) => {
    const principal = requirePrincipal();
    await profile.revokeOtherSessions(principal.userId, principal.sessionId as SessionId);
    res.status(204).send();
  });

  return router;
}
