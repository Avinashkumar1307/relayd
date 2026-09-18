import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tracking tokens (docs/06 §13).
 *
 * The token in `/o/:token.gif`, `/c/:token` and `/u/:token` is not an id. It
 * is an opaque blob carrying its own HMAC, and every property the tracking
 * endpoints need follows from that one choice:
 *
 *   *Unguessable.* Faking engagement requires the key. A sequential id or a
 *   UUID can be scanned, and scanning a competitor's open rate is the sort of
 *   thing that only needs to be possible once.
 *
 *   *Verifiable without a database hit.* The MAC is checked in microseconds
 *   and garbage is rejected before Postgres is touched. That is what lets one
 *   small service absorb a scanner walking every link in a mailshot.
 *
 *   *No PII in the URL.* The token says nothing about the recipient, the
 *   campaign or the workspace to anyone reading a browser history, a referrer
 *   header or a corporate proxy log.
 *
 *   *Rotatable.* A one-byte key id prefix means old keys stay valid while new
 *   mail is minted with a new one. Thirteen months, which is the longest
 *   realistic engagement tail — people do open year-old mail.
 *
 * The click token carries a link *index*, never a URL. `/c/...` resolves the
 * destination from `tracked_links` for that campaign, so an open redirect is
 * not merely blocked, it is unrepresentable: there is no field in which to put
 * an attacker's URL.
 */

/** `16B message_token || 4B linkIndex || 1B kind`, then a 10-byte MAC. */
const MESSAGE_TOKEN_BYTES = 16;
const LINK_INDEX_BYTES = 4;
const KIND_BYTES = 1;
const MAC_BYTES = 10;
const KEY_ID_BYTES = 1;

const PAYLOAD_BYTES = MESSAGE_TOKEN_BYTES + LINK_INDEX_BYTES + KIND_BYTES;
const TOKEN_BYTES = KEY_ID_BYTES + PAYLOAD_BYTES + MAC_BYTES;

/**
 * What the token is for.
 *
 * Part of the signed payload, so an open pixel's token cannot be replayed
 * against the unsubscribe endpoint. Without this, every recipient of every
 * campaign holds a working unsubscribe link for themselves in the pixel URL —
 * which a prefetching mail client would then fire.
 */
export const TOKEN_KINDS = { open: 1, click: 2, unsubscribe: 3 } as const;

export type TokenKind = keyof typeof TOKEN_KINDS;

const KIND_BY_BYTE: ReadonlyMap<number, TokenKind> = new Map(
  Object.entries(TOKEN_KINDS).map(([name, byte]) => [byte, name as TokenKind]),
);

export interface TrackingKey {
  /** 0–255. Written into the token so the verifier knows which key to use. */
  id: number;
  secret: Buffer;
}

export interface TrackingPayload {
  messageToken: Buffer;
  kind: TokenKind;
  linkIndex: number;
}

export class TrackingTokenError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'malformed'
      | 'bad_length'
      | 'unknown_key'
      | 'bad_mac'
      | 'unknown_kind'
      | 'bad_payload',
  ) {
    super(message);
    this.name = 'TrackingTokenError';
  }
}

/** Mints a token. `linkIndex` is meaningful only for clicks. */
export function mintTrackingToken(payload: TrackingPayload, key: TrackingKey): string {
  if (payload.messageToken.length !== MESSAGE_TOKEN_BYTES) {
    throw new TrackingTokenError(
      `A message token must be exactly ${MESSAGE_TOKEN_BYTES} bytes`,
      'bad_payload',
    );
  }

  if (!Number.isInteger(payload.linkIndex) || payload.linkIndex < 0 || payload.linkIndex > 0xff_ff_ff_ff) {
    throw new TrackingTokenError('A link index must fit in four unsigned bytes', 'bad_payload');
  }

  if (!Number.isInteger(key.id) || key.id < 0 || key.id > 0xff) {
    throw new TrackingTokenError('A key id must fit in one byte', 'bad_payload');
  }

  const body = Buffer.alloc(PAYLOAD_BYTES);
  payload.messageToken.copy(body, 0);
  body.writeUInt32BE(payload.linkIndex, MESSAGE_TOKEN_BYTES);
  body.writeUInt8(TOKEN_KINDS[payload.kind], MESSAGE_TOKEN_BYTES + LINK_INDEX_BYTES);

  const keyId = Buffer.from([key.id]);

  // The key id is inside the MAC as well as in front of it. Otherwise it is
  // attacker-controlled: flipping it would point the verifier at a different
  // key without invalidating anything.
  const mac = macOf(Buffer.concat([keyId, body]), key.secret);

  return base64url(Buffer.concat([keyId, body, mac]));
}

/**
 * Verifies a token and returns what it carries.
 *
 * Throws rather than returning null, because every failure mode here is worth
 * a distinct metric: malformed input is scanner noise, a bad MAC is someone
 * trying, and an unknown key id after a rotation is a bug in the retirement
 * schedule.
 */
export function verifyTrackingToken(
  token: string,
  keys: readonly TrackingKey[],
): TrackingPayload & { keyId: number } {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TrackingTokenError('Empty tracking token', 'malformed');
  }

  // Reject anything that is not base64url before decoding. Node's decoder is
  // lenient — it skips characters it does not recognise — so without this a
  // token with punctuation spliced in decodes to something shorter and is
  // judged on its length rather than its contents.
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new TrackingTokenError('Tracking token is not base64url', 'malformed');
  }

  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== TOKEN_BYTES) {
    throw new TrackingTokenError('Tracking token is the wrong length', 'bad_length');
  }

  const keyId = raw.readUInt8(0);
  const key = keys.find((candidate) => candidate.id === keyId);
  if (key === undefined) {
    throw new TrackingTokenError('Tracking token uses an unknown key', 'unknown_key');
  }

  const signed = raw.subarray(0, KEY_ID_BYTES + PAYLOAD_BYTES);
  const mac = raw.subarray(KEY_ID_BYTES + PAYLOAD_BYTES);

  if (!timingSafeEqual(macOf(signed, key.secret), mac)) {
    throw new TrackingTokenError('Tracking token failed verification', 'bad_mac');
  }

  // Only now is any of this trustworthy.
  const body = signed.subarray(KEY_ID_BYTES);
  const kind = KIND_BY_BYTE.get(body.readUInt8(MESSAGE_TOKEN_BYTES + LINK_INDEX_BYTES));

  if (kind === undefined) {
    throw new TrackingTokenError('Tracking token has an unknown kind', 'unknown_kind');
  }

  return {
    messageToken: Buffer.from(body.subarray(0, MESSAGE_TOKEN_BYTES)),
    linkIndex: body.readUInt32BE(MESSAGE_TOKEN_BYTES),
    kind,
    keyId,
  };
}

/**
 * The keys a verifier should accept, newest first.
 *
 * Retired keys stay verifiable for thirteen months but are never used to mint.
 * `mintingKey` is therefore a separate accessor rather than "the first one" —
 * relying on order is how a rotation quietly starts minting with a key that
 * was supposed to be on its way out.
 */
export function mintingKey(keys: readonly TrackingKey[]): TrackingKey {
  const key = keys[0];
  if (key === undefined) throw new TrackingTokenError('No tracking keys configured', 'unknown_key');
  return key;
}

function macOf(signed: Buffer, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(signed).digest().subarray(0, MAC_BYTES);
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** Exported for the route handlers, which need to size their parsers. */
export const TRACKING_TOKEN_LENGTH = TOKEN_BYTES;
