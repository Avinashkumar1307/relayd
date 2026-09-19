import * as Sentry from '@sentry/node';
import { beforeSend } from './sentry.js';
import { getTraceContext } from './trace.js';

/**
 * Sentry initialisation (docs/10 "Observability"; INVARIANTS R22, F22).
 *
 * The scrubbing is in `sentry.ts` and is tested on its own. This file is the
 * wiring: what gets tagged, what gets sampled, and what never leaves.
 *
 * ## Three rules this encodes
 *
 * **`beforeSend` is not optional.** It is set here, in the one initialiser,
 * rather than left to each entrypoint. An entrypoint that forgot it would
 * ship provider errors — nodemailer attaches the connection URL with the
 * password to its errors — to a third party, and nothing about the running
 * system would look wrong.
 *
 * **`workspaceId` is a tag; PII is not.** docs/10: "`workspaceId` as a tag,
 * never PII". A recipient's email address is the single most common thing to
 * reach for when debugging a send, and it is exactly what must not be here.
 *
 * **`sendDefaultPii` stays off.** Its default is already false, and it is set
 * explicitly because a future SDK major changing that default would be a
 * silent leak, and because a reader should not have to know the default to
 * know the answer.
 */

export interface SentryOptions {
  dsn?: string | undefined;
  environment: string;
  /** The process type: api, edge, worker, scheduler. */
  process: string;
  /** The image digest or commit sha, so an error points at an artifact. */
  release?: string | undefined;
  tracesSampleRate?: number;
}

/**
 * docs/10: "Tracing | OpenTelemetry, sampled 5%, 100% on errors and all
 * billing operations."
 */
export const DEFAULT_TRACES_SAMPLE_RATE = 0.05;

/** Transaction names that are always sampled, whatever the rate. */
const ALWAYS_SAMPLED = [/^POST \/ingest\/v1\/stripe/u, /\/billing\b/u, /^billing-/u];

export function shouldAlwaysSample(name: string | undefined): boolean {
  if (name === undefined) return false;
  return ALWAYS_SAMPLED.some((pattern) => pattern.test(name));
}

/**
 * Builds the sampler docs/10 describes.
 *
 * Separate from `initSentry` and exported so it can be tested without
 * starting an SDK: a sampler that quietly returns 0 for everything would
 * make the whole billing-tracing requirement vacuous, and there is no way to
 * observe that from outside once Sentry is holding it.
 */
export function tracesSampler(rate: number) {
  return (context: { name?: string; parentSampled?: boolean }): number => {
    if (shouldAlwaysSample(context.name)) return 1;

    // Honour an upstream decision so a trace is not half-recorded: if the
    // api sampled a request in, the worker job it enqueues should be in too.
    if (context.parentSampled !== undefined) return context.parentSampled ? 1 : 0;

    return rate;
  };
}

let started = false;

/**
 * Starts Sentry. Safe to call when no DSN is configured — it does nothing,
 * which is what local development and the test suite want.
 *
 * Returns whether it started, so an entrypoint can log the difference
 * between "error reporting is on" and "error reporting is off because
 * nobody set a DSN", which are otherwise indistinguishable until the first
 * incident.
 */
export function initSentry(options: SentryOptions): boolean {
  if (started) return true;
  if (options.dsn === undefined || options.dsn === '') return false;

  const rate = options.tracesSampleRate ?? DEFAULT_TRACES_SAMPLE_RATE;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    ...(options.release === undefined ? {} : { release: options.release }),

    sendDefaultPii: false,
    beforeSend,
    // Breadcrumbs are the quiet leak: a fetch breadcrumb carries the URL,
    // and a Secrets Manager URL carries a path that names a workspace and a
    // connection. They go through the same scrubber as everything else.
    beforeBreadcrumb: (breadcrumb) => beforeSend(breadcrumb),

    tracesSampler: tracesSampler(rate),

    initialScope: {
      tags: { process: options.process },
    },
  });

  started = true;
  return true;
}

/**
 * Copies the current trace context onto the Sentry scope.
 *
 * Call this where a request or a job begins, after the trace context is
 * established. Only the id fields go across — the correlation set is ids by
 * construction (docs/10), which is what makes it safe to send.
 */
export function tagFromTraceContext(): void {
  const context = getTraceContext();
  if (context === undefined) return;

  Sentry.getCurrentScope().setTags({
    requestId: context.requestId,
    traceId: context.traceId,
    ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
    ...(context.campaignId === undefined ? {} : { campaignId: context.campaignId }),
    ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
  });
}

/** Records an exception. A no-op when Sentry never started. */
export function captureError(error: unknown): void {
  if (!started) return;
  Sentry.captureException(error);
}

/**
 * Flushes pending events, for shutdown.
 *
 * A worker receiving SIGTERM has a drain window (CLAUDE.md Phase 0:
 * "graceful-shutdown harness"), and the errors that matter most are the ones
 * thrown on the way down. Without a flush they are buffered in a process
 * that is about to stop existing.
 */
export async function flushSentry(timeoutMs = 2_000): Promise<boolean> {
  if (!started) return true;
  return Sentry.flush(timeoutMs);
}

/** Tests only. */
export function resetSentryForTests(): void {
  started = false;
}
