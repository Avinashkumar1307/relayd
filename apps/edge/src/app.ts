import express, { type Express } from 'express';
import { errorEnvelope, notFoundHandler } from './middleware/error-envelope.js';
import { requestId } from './middleware/request-id.js';
import { healthRoutes, type HealthDependencies } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { metrics } from './middleware/metrics.js';
import { billingWebhookRoutes, type BillingWebhookDependencies } from './routes/billing-webhook.js';
import { ingestRoutes, type IngestDependencies } from './routes/ingest.js';
import { trackingRoutes, type TrackingDependencies } from './routes/tracking.js';

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

  /**
   * Omitted the same way and for the same reason: a process without tracking
   * keys must 404 the pixel rather than serve one it cannot attribute.
   */
  tracking?: TrackingDependencies;

  /**
   * Stripe webhook ingest. Omitted the same way: a process with no signing
   * secret must 404 rather than accept events it cannot verify, because an
   * endpoint that answers 200 to anything is an endpoint Stripe keeps sending
   * to while nothing is recorded.
   */
  billingWebhook?: BillingWebhookDependencies;
}

export function createApp(deps: EdgeDependencies): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(requestId);
  // Before every router, including the ones mounted ahead of the body
  // parsers, so an ingest request that fails its signature check is still
  // counted. That count is the signal that a provider's secret was rotated
  // without telling us.
  app.use(metrics('edge'));

  app.use(healthRoutes(deps));
  app.use(metricsRoutes());

  // Before any JSON parser. Every signature scheme signs the bytes that were
  // sent, and re-serialising parsed JSON changes them (docs/06).
  if (deps.ingest !== undefined) app.use(ingestRoutes(deps.ingest));

  // Also before any body parser. One-click unsubscribe POSTs arrive with a
  // body the RFC does not define and we do not read, and parsing it would
  // only create a way to reject a valid unsubscribe.
  if (deps.tracking !== undefined) app.use(trackingRoutes(deps.tracking));

  // Also raw-body, also before any JSON parser, and for exactly the reason
  // above: Stripe signs the bytes it sent.
  if (deps.billingWebhook !== undefined) app.use(billingWebhookRoutes(deps.billingWebhook));

  app.use(notFoundHandler);
  app.use(errorEnvelope(deps.logger));

  return app;
}
