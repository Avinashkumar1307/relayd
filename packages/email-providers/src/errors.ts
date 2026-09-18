import { isAmbiguous } from './batching.js';
import { ERROR_POLICY, type ErrorKind, type ProviderError } from './port.js';

/**
 * The scrubbing boundary (INVARIANTS R22, review finding F22).
 *
 * Provider errors are reconstructed into a typed `ProviderError` here and the
 * original object is discarded. This is not tidiness. Nodemailer's errors
 * embed the full connection URL including the password; several SDKs attach
 * the Authorization header to the error object; and Sentry's default
 * `beforeSend` will happily ship both. An error object that has crossed this
 * boundary contains no credential, because it is a new object built from a
 * fixed set of fields.
 *
 * The rule for anyone extending this file: never copy a field off the original
 * error into the result. Read it, classify it, and write a message of your
 * own.
 */

/** Never let a provider's prose grow without bound in a log line. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * Patterns that must never survive into a message.
 *
 * Belt and braces: the reconstruction above is the actual guarantee, and this
 * catches a message that a future adapter built by interpolating something it
 * should not have. Ordered longest-first so a URL with credentials is redacted
 * whole rather than leaving its scheme behind.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // scheme://user:password@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@\S+/giu,
  // Authorization: Bearer xyz / Basic xyz
  //
  // Consumes to end of line, not \S+. A header value has two words, and
  // stopping at the first whitespace redacts "Authorization: Bearer" while
  // leaving the credential itself sitting there — and having eaten the
  // "Bearer" prefix, the pattern below no longer recognises what remains.
  /\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/giu,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  // key=value forms for anything that sounds like a credential
  /\b(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key[_-]?id|secret|password|passwd|pwd|token|credential)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/giu,
  // AWS access key ids are self-identifying
  /\bA(?:KIA|SIA|ROA|IDA|NPA|NVA|PKA)[0-9A-Z]{12,}\b/gu,
  // SendGrid keys
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu,
  // Long opaque blobs that are almost certainly keys, not prose
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/gu,
];

/**
 * Removes known secrets, then anything that merely looks like one.
 *
 * `known` is the credential material the caller is actually holding, and it
 * matters more than the patterns do. The patterns are guesses about shape —
 * they catch a real SendGrid key because real keys look like `SG.x.y`, and
 * they miss anything that does not. A provider that echoes the key back inside
 * its own prose ("Bad key <key> rejected") defeats every pattern and is
 * defeated by this.
 */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text;

  for (const secret of known) {
    // Short strings are skipped: a two-character password would match
    // everywhere and redact the whole message into uselessness.
    if (typeof secret !== 'string' || secret.length < 6) continue;
    out = out.split(secret).join('[redacted]');
  }

  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * The credential material inside a ProviderCredentials, whatever its shape.
 *
 * Used to redact the exact secret in play rather than guessing at its form.
 */
export function secretsOf(credentials: unknown): string[] {
  if (typeof credentials !== 'object' || credentials === null) return [];

  const record = credentials as Record<string, unknown>;
  const fields = ['apiKey', 'secretAccessKey', 'accessKeyId', 'pass', 'refreshToken', 'clientSecret'];

  return fields
    .map((field) => record[field])
    .filter((value): value is string => typeof value === 'string' && value !== '');
}

/**
 * Builds a typed error.
 *
 * `retryable` and `affects` come from ERROR_POLICY rather than the caller, so
 * an adapter cannot accidentally declare an auth failure retryable and put a
 * connection into a retry loop with a wrong password.
 */
export function providerError(
  kind: ErrorKind,
  message: string,
  extra: { providerCode?: string; retryAfterMs?: number; secrets?: readonly string[] } = {},
): ProviderError {
  const policy = ERROR_POLICY[kind];
  const secrets = extra.secrets ?? [];

  return {
    kind,
    retryable: policy.retryable,
    affects: policy.affects,
    message: redact(message, secrets).slice(0, MAX_MESSAGE_LENGTH),
    ...(extra.providerCode === undefined
      ? {}
      : { providerCode: redact(extra.providerCode, secrets).slice(0, 64) }),
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
  };
}

/**
 * The last line of defence: an unexpected throw from inside an adapter.
 *
 * Reads only the shape of the thrown value, never its contents, except for a
 * message which is redacted. Anything unrecognised becomes `unknown`, which is
 * retryable — an adapter that threw for a reason nobody anticipated is not
 * evidence that the recipient is bad.
 */
export function fromUnknown(cause: unknown): ProviderError {
  if (isProviderError(cause)) return cause;

  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : 'The provider returned an error';

  const error = providerError(classifyThrown(cause), message);

  // R31: whether the provider answered is a separate question from what went
  // wrong, and only this boundary can still see the evidence. A connection
  // reset and a 429 are both retryable kinds; only one of them may be retried.
  return isAmbiguous(cause) ? { ...error, ambiguous: true } : error;
}

/**
 * An error an adapter already typed, or null.
 *
 * Adapters throw ProviderError for their own refusals — credentials for the
 * wrong provider, for instance. Passing one back through classification would
 * turn a definite auth failure into `unknown`, which is retryable, and the
 * send path would keep trying it.
 */
export function asProviderError(value: unknown): ProviderError | null {
  return isProviderError(value) ? value : null;
}

function isProviderError(value: unknown): value is ProviderError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'affects' in value &&
    'retryable' in value &&
    typeof (value as { kind: unknown }).kind === 'string' &&
    (value as { kind: string }).kind in ERROR_POLICY
  );
}

/**
 * Classifies a thrown value by the few properties that are reliable across
 * runtimes: Node's socket error codes and an HTTP status where one exists.
 */
function classifyThrown(cause: unknown): ErrorKind {
  if (typeof cause !== 'object' || cause === null) return 'unknown';

  const code = 'code' in cause ? String((cause as { code: unknown }).code) : '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ABORT_ERR') return 'timeout';
  if (cause instanceof Error && cause.name === 'AbortError') return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
    return 'provider_unavailable';
  }

  const status = readStatus(cause);
  return status === undefined ? 'unknown' : classifyStatus(status);
}

function readStatus(cause: object): number | undefined {
  for (const key of ['status', 'statusCode', 'httpStatusCode']) {
    if (key in cause) {
      const value = (cause as Record<string, unknown>)[key];
      if (typeof value === 'number') return value;
    }
  }

  if ('response' in cause) {
    const response = (cause as { response: unknown }).response;
    if (typeof response === 'object' && response !== null) return readStatus(response);
  }

  return undefined;
}

/**
 * HTTP status to error kind.
 *
 * The shared fallback every adapter starts from; each one overrides where its
 * provider is more specific, because this is where provider quirks actually
 * live.
 */
export function classifyStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 413) return 'message_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'provider_unavailable';
  if (status === 422 || status === 400) return 'content_rejected';
  return 'unknown';
}

/**
 * Reads a Retry-After header.
 *
 * Both forms are legal: delta-seconds, or an HTTP date. Guessing a backoff
 * when the provider has told us exactly how long to wait is how a rate limit
 * becomes a ban.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;

  return Math.max(0, at - now);
}
