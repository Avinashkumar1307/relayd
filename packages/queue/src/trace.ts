import { getTraceContext, runWithTrace, type TraceContext } from '@relayd/logger';

/**
 * Carrying the trace context across the queue boundary (docs/10
 * "Observability").
 *
 * docs/10, exactly: "Propagated via `AsyncLocalStorage` in-process and via
 * the job payload's `_trace` field across the queue boundary."
 *
 * `AsyncLocalStorage` reaches as far as the process does. The moment a job
 * is written to Redis the context is gone — a worker picking it up half a
 * second later starts with nothing, and the acceptance test docs/10 sets
 * ("my email to aisha@example.com never arrived" answered by one query, in
 * under a minute) fails at exactly the interesting hop, because the send
 * itself is the part that happened in the worker.
 *
 * So the context travels inside the payload. `_trace` is underscored because
 * it is not part of any job's own data: a consumer reads its typed fields and
 * ignores this one, and the one place that looks at it is `resumeTrace`.
 *
 * ## What is carried, and what is not
 *
 * Only the ids. The correlation set in docs/10 is ids by construction, which
 * is what makes it safe to write into a job payload that sits in Redis, gets
 * logged on failure, and appears in a dead-letter dump. An email address in
 * here would be PII at rest in a system with no retention policy.
 */

/** The field name. Underscored so it cannot collide with a job's own data. */
export const TRACE_FIELD = '_trace';

export type Traced<T> = T & { [TRACE_FIELD]?: TraceContext };

/**
 * Attaches the current trace context to a job payload.
 *
 * Call this when enqueueing. Outside a trace — a scheduler tick, a test —
 * the payload is returned unchanged rather than given an empty context, so a
 * consumer can tell "no trace was running" from "a trace was running and
 * carried nothing".
 */
export function withTrace<T extends object>(payload: T): Traced<T> {
  const context = getTraceContext();
  if (context === undefined) return payload;

  return { ...payload, [TRACE_FIELD]: context };
}

/**
 * Runs a consumer inside the trace the producer was in.
 *
 * `jobId` is always overwritten with the one actually processing, because
 * the producer's `jobId` — if it had one, having itself been a job — belongs
 * to the parent, and two jobs sharing an id in the logs is worse than the
 * child having none.
 *
 * When the payload carries no trace, a fresh context is started rather than
 * running untraced. A job with no ids at all is the one that cannot be
 * followed later, and that is precisely the job that turns out to matter.
 */
export async function resumeTrace<T extends object, R>(
  payload: Traced<T>,
  jobId: string,
  fn: () => Promise<R>,
  newIds: () => { requestId: string; traceId: string },
): Promise<R> {
  const carried = payload[TRACE_FIELD];

  const context: TraceContext =
    carried === undefined ? { ...newIds(), jobId } : { ...carried, jobId };

  return runWithTrace(context, fn);
}

/**
 * The payload as a consumer should read it: its own fields, without `_trace`.
 *
 * Not cosmetic. A consumer that validates its payload with a Zod schema —
 * which every consumer does — would reject an unrecognised key under
 * `.strict()`, and a job that fails validation because of the field added to
 * make it traceable is a bad trade.
 */
export function withoutTrace<T extends object>(payload: Traced<T>): T {
  if (!(TRACE_FIELD in payload)) return payload as T;

  const { [TRACE_FIELD]: _ignored, ...rest } = payload;
  return rest as unknown as T;
}
