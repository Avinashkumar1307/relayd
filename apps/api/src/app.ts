import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { errorEnvelope, notFoundHandler } from './middleware/error-envelope.js';
import { requestId } from './middleware/request-id.js';
import { healthRoutes, type HealthDependencies } from './routes/health.js';
import { authRoutes, type AuthRouterOptions } from './routes/auth.js';
import {
  invitationRoutes,
  workspaceRoutes,
  type WorkspaceRouterOptions,
} from './routes/workspaces.js';
import { requestContext } from './middleware/authorize.js';

/**
 * Express 5, with the guard rails docs/01 asks for: thin route handlers, one
 * error middleware, request-scoped context via AsyncLocalStorage rather than
 * threading it through layers.
 *
 * docs/01 also calls for a single asyncHandler wrapper. That was an Express 4
 * necessity — Express 5 forwards a rejected promise from a handler to the
 * error middleware itself, which is all asyncHandler ever did. Adding one
 * here would be dead weight, so there is none; handlers still contain no
 * try/catch.
 */
export interface AppDependencies extends HealthDependencies {
  /**
   * Absent in tests that only exercise the probes, and in any process that has
   * no database to build repositories against.
   */
  auth?: AuthRouterOptions;
  /** Absent in probe-only tests and in any process without a database. */
  workspaces?: WorkspaceRouterOptions;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Express advertising its own version buys an attacker a free hint.
  app.disable('x-powered-by');

  app.use(requestId);
  // Opens the request-scoped context the auth middleware fills in.
  app.use(requestContext);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use(healthRoutes(deps));

  if (deps.auth !== undefined) {
    app.use('/api/v1/auth', authRoutes(deps.auth));
  }

  if (deps.workspaces !== undefined) {
    app.use('/api/v1/workspaces', workspaceRoutes(deps.workspaces));
    app.use('/api/v1/invitations', invitationRoutes(deps.workspaces));
  }

  app.use(notFoundHandler);
  app.use(errorEnvelope(deps.logger));

  return app;
}
