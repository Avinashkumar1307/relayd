import { Router, type Request, type Response } from 'express';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@relayd/validation';
import { AppError } from '@relayd/types';
import type { UserId } from '@relayd/types';
import { updateTraceContext } from '@relayd/logger';
import type { AuthService, AuthTokens, SessionContext } from '../services/auth.js';
import { validateBody } from '../middleware/validate.js';
import type { TokenService } from '../services/tokens.js';

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
  /**
   * Verifies access tokens for the two routes that read one.
   *
   * Optional because every other route here is unauthenticated by definition
   * — logging in is what produces a token — and a deployment or a test with
   * no key pair must still be able to serve them. `GET /auth/session` is
   * mounted only when this is present; `POST /auth/resend-verification`
   * works either way and simply cannot identify a signed-in caller without
   * it.
   */
  tokens?: TokenService;
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
    data: {
      accessToken: tokens.accessToken,
      sessionId: tokens.sessionId,
      // Who signed in and where they can go, on the same response that
      // established the session. The SPA needs both to draw its first frame —
      // the shell's user row and the workspace switcher — and a separate
      // "who am I" call would cost a round trip on every load and leave a
      // window in which the app holds a token and no name to render.
      user: tokens.user,
      memberships: tokens.memberships,
    },
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

/**
 * The user id from a bearer token, or null.
 *
 * Null rather than a throw: the two callers differ on what an absent or
 * invalid token means. `/auth/session` has nothing to answer without one;
 * resend-verification treats it as "the caller is not signed in" and falls
 * back to the address in the body. Neither wants a 401 raised from in here.
 *
 * `authenticate` is not reused because this is not a gate — it does not
 * populate the request context, and nothing downstream may treat its result
 * as authorization for anything but identifying the subject of these two
 * reads.
 */
async function readBearer(req: Request, tokens: TokenService): Promise<UserId | null> {
  const header = req.get('authorization');
  if (header === undefined || !header.startsWith('Bearer ')) return null;

  try {
    const claims = await tokens.verifyAccessToken(header.slice('Bearer '.length));
    return claims.sub;
  } catch {
    return null;
  }
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

  /**
   * Who is signed in, without rotating the refresh cookie.
   *
   * The session payload also rides on register, login and refresh, which is
   * how the SPA gets it with no extra request. This route is for a caller
   * that already holds a valid access token and wants to re-read the answer —
   * after accepting an invitation, say. Asking `/auth/refresh` for that works
   * and costs a rotation of the long-lived credential, which is a real price
   * to pay for a read.
   */
  if (options.tokens !== undefined) {
    const verifier = options.tokens;

    router.get('/session', async (req: Request, res: Response) => {
      const userId = await readBearer(req, verifier);
      if (userId === null) {
        throw new AppError('unauthenticated', 'Authentication required', 401);
      }
      res.json({ data: await auth.session(userId) });
    });
  }

  router.post(
    '/verify-email',
    validateBody(verifyEmailSchema),
    async (req: Request, res: Response) => {
      const result = await auth.verifyEmail((req.body as { token: string }).token);
      res.status(200).json({ data: result });
    },
  );

  /**
   * Sends the verification link again (B3a's "Resend").
   *
   * Always 202, for the same reason forgot-password always is: answering
   * differently for an address that exists turns this into an enumeration
   * oracle, and this one would also confirm whether that account is verified.
   * The throttle lives in the service and is durable — the client's
   * 30-second countdown is a courtesy, not a control.
   *
   * The address may come from the body (B3a reached from a link) or from a
   * bearer token (B3a reached while signed in). Neither is trusted to be
   * present: with neither, the request is a well-formed no-op and still 202s.
   */
  router.post(
    '/resend-verification',
    validateBody(resendVerificationSchema),
    async (req: Request, res: Response) => {
      const { email } = req.body as { email?: string };
      const userId =
        options.tokens === undefined ? null : await readBearer(req, options.tokens);

      await auth.resendEmailVerification({
        // The token wins when both are present: it is the claim that was
        // verified, and a signed-in caller must not be able to aim somebody
        // else's verification email by putting another address in the body.
        ...(userId === null ? {} : { userId }),
        ...(userId !== null || email === undefined ? {} : { email }),
      });

      res.status(202).json({
        data: { message: 'If that address needs verifying, a new link is on its way.' },
      });
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
