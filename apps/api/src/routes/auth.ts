import { Router, type Request, type Response } from 'express';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@relayd/validation';
import { AppError } from '@relayd/types';
import { updateTraceContext } from '@relayd/logger';
import type { AuthService, AuthTokens, SessionContext } from '../services/auth.js';
import { validateBody } from '../middleware/validate.js';

/**
 * The /auth routes from docs/03.
 *
 * Handlers are thin: parse, call one service method, serialise one response
 * (CLAUDE.md section 6.1). No try/catch — Express 5 forwards rejections to the
 * error middleware.
 */

const REFRESH_COOKIE = 'relayd_refresh';

export interface AuthRouterOptions {
  auth: AuthService;
  /** Secure cookies require HTTPS; off in local development only. */
  secureCookies: boolean;
  refreshTtlDays: number;
}

/**
 * The refresh token goes in an HttpOnly cookie and the access token in the
 * body (docs/06 s15: "Refresh in HttpOnly Secure SameSite=Lax cookie; access
 * token in memory only, never localStorage").
 *
 * HttpOnly is what stops an XSS from reading the long-lived credential. The
 * access token is deliberately NOT a cookie: it is held in memory by the SPA
 * and dies with the tab.
 */
function sendTokens(
  res: Response,
  tokens: AuthTokens,
  options: AuthRouterOptions,
  status = 200,
): void {
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: options.refreshTtlDays * 24 * 60 * 60 * 1000,
  });

  res.status(status).json({
    data: { accessToken: tokens.accessToken, sessionId: tokens.sessionId },
  });
}

function sessionContext(req: Request): SessionContext {
  const userAgent = req.get('user-agent');
  return {
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(req.ip === undefined ? {} : { ip: req.ip }),
  };
}

function readRefreshCookie(req: Request): string {
  const cookies = req.cookies as Record<string, string> | undefined;
  const token = cookies?.[REFRESH_COOKIE];
  if (typeof token !== 'string' || token.length === 0) {
    throw new AppError('unauthenticated', 'No refresh token supplied', 401);
  }
  return token;
}

export function authRoutes(options: AuthRouterOptions): Router {
  const router = Router();
  const { auth } = options;

  router.post('/register', validateBody(registerSchema), async (req: Request, res: Response) => {
    const tokens = await auth.register(req.body, sessionContext(req));
    updateTraceContext({ userId: tokens.sessionId });
    sendTokens(res, tokens, options, 201);
  });

  router.post('/login', validateBody(loginSchema), async (req: Request, res: Response) => {
    const { email, password } = req.body as { email: string; password: string };
    sendTokens(res, await auth.login(email, password, sessionContext(req)), options);
  });

  router.post('/refresh', async (req: Request, res: Response) => {
    const tokens = await auth.refresh(readRefreshCookie(req), sessionContext(req));
    sendTokens(res, tokens, options);
  });

  router.post('/logout', async (req: Request, res: Response) => {
    const cookies = req.cookies as Record<string, string> | undefined;
    const token = cookies?.[REFRESH_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      await auth.logout(token);
    }
    // Clearing the cookie must happen whether or not a session was found, so
    // a stale cookie cannot linger after the server has forgotten it.
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    res.status(204).send();
  });

  router.post(
    '/verify-email',
    validateBody(verifyEmailSchema),
    async (req: Request, res: Response) => {
      await auth.verifyEmail((req.body as { token: string }).token);
      res.status(200).json({ data: { verified: true } });
    },
  );

  /**
   * Always 202, whether or not the address exists. Telling the caller
   * otherwise turns this into an account-enumeration oracle (docs/06).
   */
  router.post(
    '/forgot-password',
    validateBody(forgotPasswordSchema),
    async (req: Request, res: Response) => {
      await auth.requestPasswordReset((req.body as { email: string }).email);
      res.status(202).json({
        data: { message: 'If that address has an account, a reset link is on its way.' },
      });
    },
  );

  router.post(
    '/reset-password',
    validateBody(resetPasswordSchema),
    async (req: Request, res: Response) => {
      const { token, password } = req.body as { token: string; password: string };
      await auth.resetPassword(token, password);
      // Every session was revoked, so the old cookie is dead.
      res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
      res.status(200).json({ data: { reset: true } });
    },
  );

  return router;
}
