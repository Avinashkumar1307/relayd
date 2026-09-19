import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The correlation set carried by every log line, metric and span
 * (docs/10-infrastructure.md, "Observability").
 *
 * The acceptance test this exists for: given "my email to aisha@example.com
 * never arrived", one query on campaignRecipientId returns the send attempt,
 * the sender used, the provider message id, every provider webhook received
 * and the log lines from three services — in under a minute.
 */
export interface TraceContext {
  /** Per HTTP request, returned to the caller in every response. */
  requestId: string;
  /** W3C trace id, spans api → worker → provider. */
  traceId: string;
  workspaceId?: string;
  userId?: string;
  jobId?: string;
  campaignId?: string;
  campaignRecipientId?: string;
  providerId?: string;
  providerMessageId?: string;
  billingEventId?: string;
  paymentProviderEventId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  paymentId?: string;
  /** The API key a request authenticated with, never the key itself. */
  apiKeyId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** A fresh request id. Opaque to callers; do not parse it. */
export function newRequestId(): string {
  return randomUUID();
}

/** A fresh trace id: 16 bytes, lowercase hex, per W3C trace-context. */
export function newTraceId(): string {
  return randomUUID().replace(/-/gu, '');
}

/**
 * Runs `fn` with `context` as the ambient trace context. Everything logged
 * inside — including across awaits — carries these fields automatically.
 */
export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The ambient trace context, or undefined outside any traced scope. */
export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * Merges `fields` into the ambient trace context in place, so that identifiers
 * discovered mid-request (workspaceId after auth, campaignId after lookup)
 * appear on every subsequent log line without being threaded through calls.
 *
 * No-op outside a traced scope rather than throwing: losing a log field must
 * never be able to take down a request path.
 */
export function updateTraceContext(fields: Partial<Omit<TraceContext, 'requestId' | 'traceId'>>): void {
  const current = storage.getStore();
  if (current === undefined) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      Reflect.set(current, key, value);
    }
  }
}
