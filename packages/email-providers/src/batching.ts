/**
 * Batch size, and what a batch failure means (INVARIANTS R31, finding F31).
 *
 * The trace F31 describes: a `sendBatch` of 500 times out after the provider
 * accepted 400 of them. The job retries. Four hundred people get the email
 * twice, and nothing in the system can tell that it happened.
 *
 * Two rules come out of that, and they are different rules.
 *
 * **The cap.** A batch is at most 100 messages, whatever the adapter says it
 * can take. The cap is not a performance tuning knob — it is the bound on how
 * many people one ambiguous response can affect. An adapter that advertises
 * 1,000 is advertising the size of its own request limit, which is a
 * different question from how much duplication we are willing to risk.
 *
 * **The classification.** A batch may only be retried when the provider
 * definitively never saw it. The useful question is not what kind of problem
 * occurred but a much simpler one:
 *
 *     Did the provider answer?
 *
 * An answer of any sort — a 200, a 429, a 550 — is definitive. It tells us
 * what happened to those messages. The absence of an answer is not. A
 * connection refused before a byte was written is definitively nothing; a
 * connection *reset* is a request that went out and a response that never
 * came back, which looks identical to success from the provider's side.
 *
 * That distinction is the whole of F31, and it is the one Node makes for us
 * in its socket error codes.
 */

import type { OutboundMessage, ProviderError, SendOutcome } from './port.js';

/**
 * R31. Not the adapter's declared maximum — the bound on how many recipients
 * a single ambiguous response can leave in `delivery_uncertain`.
 */
export const MAX_BATCH_SIZE = 100;

/**
 * Socket failures that prove nothing was ever written to the wire.
 *
 * The connection was refused, or the name never resolved. There is no request
 * for the provider to have accepted, so the batch is safe to retry in full.
 *
 * This is the only list, and that is deliberate. An earlier version also kept
 * a list of codes considered ambiguous — `ECONNRESET`, `EPIPE`, the undici
 * socket errors — and every entry in it was dead weight, because the fail-safe
 * default below already caught them. A list whose removal changes no behaviour
 * is not a guard; it is a comment that looks like one, and the next person to
 * edit it will believe it does something.
 *
 * So the rule is stated once, in the direction that carries the risk: name the
 * cases where a retry is provably safe, and treat everything else as
 * uncertain. Adding a code here is a claim that the provider cannot possibly
 * have seen the request. `ECONNRESET` is the one that most invites the
 * mistake — it is a *successful* write followed by a peer that went away, and
 * it is indistinguishable from an accepted send, so it must never appear here.
 */
const PRE_ACCEPTANCE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** The batch size to actually use, given what an adapter claims it supports. */
export function batchSizeFor(maxBatchSize: number): number {
  if (!Number.isFinite(maxBatchSize)) return 1;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(maxBatchSize)));
}

/**
 * Whether a thrown value proves the provider never received the request.
 *
 * Deliberately conservative. Anything unrecognised is *not* pre-acceptance,
 * because the cost of being wrong in that direction is a duplicate send and
 * the cost of being wrong in the other is a recipient the customer has to
 * look at once.
 */
export function isPreAcceptance(cause: unknown): boolean {
  // Not an error object at all: no evidence of anything.
  if (typeof cause !== 'object' || cause === null) return false;

  // A response of any status means the provider answered, which settles the
  // question regardless of what the answer was — but an answer is not the
  // same as never having asked, so this is not pre-acceptance either.
  if (hasHttpStatus(cause)) return false;

  return PRE_ACCEPTANCE_CODES.has(readCode(cause));
}

/**
 * Whether a thrown value leaves the outcome genuinely unknown.
 *
 * Not the complement of `isPreAcceptance`: a rejected credential and a 550 are
 * neither safe to retry nor ambiguous. They are definitive failures, and the
 * third case is the reason both functions exist.
 *
 *   answered at all         → definitive; retry or not per ERROR_POLICY
 *   known pre-acceptance    → definitive; the batch may be retried whole
 *   anything else           → ambiguous; the batch becomes uncertain
 */
export function isAmbiguous(cause: unknown): boolean {
  // A throw that is not even an error object tells us nothing about whether
  // the request went out. R31 reads an unknown batch outcome as uncertain
  // rather than retrying it, and the asymmetry is the reason: a wrongly
  // uncertain recipient is one line in a report the customer can act on, and
  // a wrongly retried one is a duplicate nobody can take back.
  if (typeof cause !== 'object' || cause === null) return true;
  if (hasHttpStatus(cause)) return false;

  // Everything that is not provably pre-acceptance. `ECONNRESET`, `EPIPE`,
  // `ETIMEDOUT` and the undici socket errors all land here by falling through,
  // which is exactly where they belong: each of them is a request that went
  // out and a response that never came back.
  return !PRE_ACCEPTANCE_CODES.has(readCode(cause));
}

function readCode(cause: object): string {
  return 'code' in cause ? String((cause as { code: unknown }).code) : '';
}

function hasHttpStatus(cause: object): boolean {
  for (const key of ['status', 'statusCode', 'httpStatusCode']) {
    if (key in cause && typeof (cause as Record<string, unknown>)[key] === 'number') return true;
  }

  if ('response' in cause) {
    const response = (cause as { response: unknown }).response;
    if (typeof response === 'object' && response !== null) return hasHttpStatus(response);
  }

  return false;
}

/**
 * The outcome for every message in a batch that failed as a whole.
 *
 * One error, applied to all of them. Splitting a batch failure into per-message
 * verdicts would be inventing information: the provider answered once, or not
 * at all, and it answered about the batch.
 */
export function batchFailureOutcomes(
  batch: readonly OutboundMessage[],
  error: ProviderError,
): SendOutcome[] {
  return batch.map((message) => ({
    ok: false as const,
    recipientId: message.recipientId,
    error,
  }));
}
