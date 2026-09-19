import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signing outbound webhooks (docs/03, docs/06).
 *
 * The scheme is the one every provider we integrate with uses, for the
 * obvious reason: an integrator who has written a Stripe or SendGrid verifier
 * can write ours in five minutes.
 *
 *   `Relayd-Signature: t=<unix seconds>,v1=<hex hmac>`
 *
 * The signed payload is `<timestamp>.<body>` — the timestamp is *inside* the
 * MAC, not merely alongside it. A timestamp outside the MAC is a timestamp an
 * attacker edits: they replay yesterday's delivery with today's clock and the
 * signature still verifies, which defeats the whole point of having one.
 *
 * Two things a verifier must do, and the helper below does both because
 * leaving them to the reader is how they get skipped:
 *
 *   **Compare in constant time.** A byte-by-byte comparison that returns early
 *   leaks the prefix of a valid signature, one request at a time.
 *
 *   **Bound the timestamp.** Without a tolerance a captured delivery is valid
 *   forever, so an attacker who sees one request can replay it whenever it
 *   suits them.
 */

/** The header integrators read. */
export const SIGNATURE_HEADER = 'relayd-signature';

/** The event id header, so a consumer can deduplicate without parsing the body. */
export const EVENT_ID_HEADER = 'relayd-event-id';

/**
 * How far out a timestamp may be before the delivery is refused.
 *
 * Five minutes, matching Stripe's default. Generous enough for a slow network
 * and a mildly wrong clock, short enough that a captured request is not a
 * lasting credential.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface SignedPayload {
  /** The full header value. */
  header: string;
  timestamp: number;
  signature: string;
}

/**
 * Signs a body.
 *
 * `timestamp` in whole seconds, because that is what the header carries and a
 * verifier re-deriving it from milliseconds would produce a different string
 * to MAC over.
 */
export function signWebhook(input: {
  body: string;
  secret: string;
  at: Date;
}): SignedPayload {
  const timestamp = Math.floor(input.at.getTime() / 1000);
  const signature = hmac(input.secret, `${timestamp}.${input.body}`);

  return { header: `t=${timestamp},v1=${signature}`, timestamp, signature };
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export type VerifyFailure =
  | 'malformed_header'
  | 'timestamp_out_of_tolerance'
  | 'no_matching_signature';

export type VerifyResult = { valid: true } | { valid: false; reason: VerifyFailure };

/**
 * Verifies a signature, against one or more secrets.
 *
 * Several secrets because of rotation: for the overlap window both the new
 * and the previous secret are live, so an integrator who has not yet
 * redeployed keeps working. The check is "any of these", and a rotation
 * without an overlap is a rotation that breaks every consumer at the moment
 * it lands.
 */
export function verifyWebhookSignature(input: {
  body: string;
  header: string;
  secrets: readonly string[];
  now: Date;
  toleranceSeconds?: number;
}): VerifyResult {
  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) return { valid: false, reason: 'malformed_header' };

  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const now = Math.floor(input.now.getTime() / 1000);

  // Absolute, so a clock ahead of ours is refused as well as one behind. A
  // one-sided check accepts anything from the future, and "the future" is
  // where an attacker puts a timestamp they control.
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = `${parsed.timestamp}.${input.body}`;

  for (const secret of input.secrets) {
    if (secret.length === 0) continue;
    if (constantTimeEquals(hmac(secret, expected), parsed.signature)) return { valid: true };
  }

  return { valid: false, reason: 'no_matching_signature' };
}

/**
 * `t=...,v1=...`, in either order and ignoring anything else.
 *
 * Tolerant of extra fields on purpose: adding a `v2=` alongside `v1=` is how
 * this scheme gets upgraded without breaking every existing consumer, and a
 * parser that refused unknown fields would make that impossible.
 */
export function parseSignatureHeader(
  header: string,
): { timestamp: number; signature: string } | null {
  let timestamp: number | null = null;
  let signature: string | null = null;

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      const seconds = Number.parseInt(value, 10);
      // `Number.parseInt('12abc')` is 12, which would accept a header nobody
      // sent. The shape check is what makes the parse total.
      if (!/^\d{1,15}$/u.test(value) || !Number.isFinite(seconds)) return null;
      timestamp = seconds;
    }

    if (key === 'v1') {
      if (!/^[0-9a-f]{64}$/u.test(value)) return null;
      signature = value;
    }
  }

  if (timestamp === null || signature === null) return null;
  return { timestamp, signature };
}

/**
 * Constant-time string comparison.
 *
 * Length is checked first because `timingSafeEqual` throws on a mismatch, and
 * that throw would itself be the timing signal it exists to remove.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
