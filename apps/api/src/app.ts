import express, { type Express } from 'express';
import { errorEnvelope, notFoundHandler } from './middleware/error-envelope.js';
import { requestId } from './middleware/request-id.js';
import { healthRoutes, type HealthDependencies } from './routes/health.js';

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
export function createApp(deps: HealthDependencies): Express {
  const app = express();

  // Express advertising its own version buys an attacker a free hint.
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRoutes(deps));

  app.use(notFoundHandler);
  app.use(errorEnvelope(deps.logger));

  return app;
}
