import { REDACTION_CENSOR } from './redaction.js';

/**
 * The Sentry `beforeSend` denylist (INVARIANTS R22, review finding F22).
 *
 * Pino redaction protects log lines. Sentry is a separate exfiltration path
 * with its own serialiser, and its defaults are generous: request headers,
 * breadcrumbs, `extra`, and the properties hanging off a thrown error all go
 * up as they are. Nodemailer attaches the connection URL with the password to
 * its errors; several SDKs attach the Authorization header. Without this they
 * are shipped to a third party.
 *
 * This is deliberately not clever. It walks the event and censors by key name
 * and by value shape, and it fails closed on its own errors: if scrubbing
 * throws, the event is dropped rather than sent unscrubbed.
 */

/** Key names whose value is never safe to send, at any depth. */
const DENIED_KEYS: readonly RegExp[] = [
  /^authorization$/iu,
  /^proxy-authorization$/iu,
  /^cookie$/iu,
  /^set-cookie$/iu,
  /^x-api-key$/iu,
  /pass(word|wd)?$/iu,
  /secret/iu,
  /token$/iu,
  /^apikey$/iu,
  /^api_key$/iu,
  /^credentials?$/iu,
  /^connectionstring$/iu,
  /_url$/iu,
  /^dsn$/iu,
];

/** Value shapes that are a credential wherever they appear. */
const DENIED_VALUES: readonly RegExp[] = [
  // key=value in prose or a query string. The key that leaks is rarely a
  // field name Sentry can see — it is a fragment of a URL or a message the
  // provider wrote.
  /\b(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key[_-]?id|secret|password|passwd|pwd|token|credential)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&"']+)/giu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@\S+/giu,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\bA(?:KIA|SIA|ROA|IDA|NPA|NVA|PKA)[0-9A-Z]{12,}\b/gu,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/gu,
  /\bwhsec_[A-Za-z0-9]{10,}\b/gu,
];

/** Depth and breadth bounds, so a cyclic or enormous event cannot hang the process. */
const MAX_DEPTH = 8;
const MAX_KEYS = 200;

function isDeniedKey(key: string): boolean {
  return DENIED_KEYS.some((pattern) => pattern.test(key));
}

export function scrubValue(value: string): string {
  let out = value;
  for (const pattern of DENIED_VALUES) out = out.replace(pattern, REDACTION_CENSOR);
  return out;
}

/**
 * Censors a value in place, by key name and by content.
 *
 * `seen` breaks cycles: a Sentry event can contain an error whose `cause`
 * points back at it, and a naive walk would not terminate.
 */
function scrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') return scrubValue(value);
  if (typeof value !== 'object' || value === null) return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((entry) => scrub(entry, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  let count = 0;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_KEYS) break;
    count += 1;

    out[key] = isDeniedKey(key) ? REDACTION_CENSOR : scrub(entry, depth + 1, seen);
  }

  return out;
}

/**
 * The function to pass as Sentry's `beforeSend`.
 *
 * Returns null — dropping the event — if scrubbing itself fails. An event
 * that could not be scrubbed is not an event worth the risk of sending; a
 * missing error report is a smaller problem than a leaked credential, and the
 * log line is still there.
 */
export function beforeSend<T extends object>(event: T): T | null {
  try {
    return scrub(event, 0, new WeakSet()) as T;
  } catch {
    return null;
  }
}
