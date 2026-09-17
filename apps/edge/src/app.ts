import express, { type Express } from 'express';
import { errorEnvelope, notFoundHandler } from './middleware/error-envelope.js';
import { requestId } from './middleware/request-id.js';
import { healthRoutes, type HealthDependencies } from './routes/health.js';
import { ingestRoutes, type IngestDependencies } from './routes/ingest.js';

/**
 * The public, unauthenticated surface: tracking pixel, click redirect,
 * unsubscribe, provider webhook ingest, Stripe webhook ingest. Those routes
 * arrive in Phases 3, 6 and 8; Phase 0 ships the process and its probes.
 *
 * This is a separate app from api because it is unauthenticated,
 * internet-facing, unpredictable in volume and must not be able to take down
 * the dashboard (docs/01). It imports nothing from apps/api and nothing from
 * the layer-5 domain packages — a test enforces both.
 *
 * Its job at steady state is to accept and enqueue in under 200 ms and let a
 * worker do the rest (CLAUDE.md section 3: "Writes to queue only").
 */
export interface EdgeDependencies extends HealthDependencies {
  /**
   * Omitted in Phase 0-style boots that only want the probes. When absent the
   * ingest route is simply not mounted, so a misconfigured process 404s
   * rather than accepting events it cannot verify.
   */
  ingest?: IngestDependencies;
}

export function createApp(deps: EdgeDependencies): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(requestId);

  app.use(healthRoutes(deps));

  // Before any JSON parser. Every signature scheme signs the bytes that were
  // sent, and re-serialising parsed JSON changes them (docs/06).
  if (deps.ingest !== undefined) app.use(ingestRoutes(deps.ingest));

  app.use(notFoundHandler);
  app.use(errorEnvelope(deps.logger));

  return app;
}
