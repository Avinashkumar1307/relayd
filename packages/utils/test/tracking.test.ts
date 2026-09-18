import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TOKEN_KINDS,
  TRACKING_TOKEN_LENGTH,
  TrackingTokenError,
  mintTrackingToken,
  mintingKey,
  verifyTrackingToken,
  type TrackingKey,
} from '../src/crypto/tracking.js';

/**
 * Tracking tokens (docs/06 §13; INVARIANTS R6 for the kinds).
 *
 * The phase gate requires that "a forged tracking token is rejected without a
 * DB read", so the tests that matter are the ones that try to forge one. The
 * happy path is three lines.
 */

const KEY: TrackingKey = { id: 1, secret: Buffer.alloc(32, 7) };
const OLD_KEY: TrackingKey = { id: 0, secret: Buffer.alloc(32, 3) };
const MESSAGE = Buffer.alloc(16, 42);

function mint(overrides: Partial<Parameters<typeof mintTrackingToken>[0]> = {}, key = KEY): string {
  return mintTrackingToken(
    { messageToken: MESSAGE, kind: 'open', linkIndex: 0, ...overrides },
    key,
  );
}

describe('what a token carries', () => {
  it('round-trips the message token, kind and link index', () => {
    const token = mint({ kind: 'click', linkIndex: 7 });
    const payload = verifyTrackingToken(token, [KEY]);

    expect(payload.messageToken.equals(MESSAGE)).toBe(true);
    expect(payload.kind).toBe('click');
    expect(payload.linkIndex).toBe(7);
  });

  it('is URL-safe, so it survives a mail client rewriting the link', () => {
    for (let i = 0; i < 50; i += 1) {
      const token = mint({ messageToken: randomBytes(16), linkIndex: i });
      expect(token, token).toMatch(/^[A-Za-z0-9_-]+$/u);
    }
  });

  it('is a fixed length, so a truncation is a length error not a parse', () => {
    const token = mint();
    expect(Buffer.from(token, 'base64url')).toHaveLength(TRACKING_TOKEN_LENGTH);
    // 1 key id + 16 message token + 4 link index + 1 kind + 10 MAC.
    expect(TRACKING_TOKEN_LENGTH).toBe(32);
  });

  it('contains no recipient, campaign or workspace identifier', () => {
    // The point of the design: a proxy log, a referrer header or a browser
    // history reveals nothing about who was mailed.
    const token = mint({ messageToken: Buffer.from('0123456789abcdef', 'utf8') });
    const decoded = Buffer.from(token, 'base64url').toString('utf8');

    // The message token itself is opaque random bytes; nothing else is in
    // there to leak.
    expect(decoded).not.toContain('campaign');
    expect(decoded).not.toContain('@');
  });

  it('carries the largest link index a campaign could plausibly have', () => {
    const payload = verifyTrackingToken(mint({ kind: 'click', linkIndex: 0xff_ff_ff_ff }), [KEY]);
    expect(payload.linkIndex).toBe(0xff_ff_ff_ff);
  });
});

describe('forging one', () => {
  it('rejects a token signed with a different key', () => {
    const forged = mint({}, { id: 1, secret: Buffer.alloc(32, 9) });

    expect(() => verifyTrackingToken(forged, [KEY])).toThrow(TrackingTokenError);
  });

  it('rejects a flipped bit anywhere in the payload', () => {
    // Every byte, one at a time. A MAC that covers only part of the payload
    // is the classic way this is got wrong.
    const raw = Buffer.from(mint({ kind: 'click', linkIndex: 3 }), 'base64url');

    for (let i = 0; i < raw.length; i += 1) {
      const tampered = Buffer.from(raw);
      tampered.writeUInt8(tampered.readUInt8(i) ^ 0x01, i);

      expect(
        () => verifyTrackingToken(tampered.toString('base64url'), [KEY]),
        `byte ${i}`,
      ).toThrow(TrackingTokenError);
    }
  });

  it('rejects a token whose key id was swapped to another valid key', () => {
    // The key id is inside the MAC as well as in front of it. If it were only
    // a prefix, flipping it would point the verifier at a different key
    // without invalidating anything it covers.
    const raw = Buffer.from(mint(), 'base64url');
    raw.writeUInt8(OLD_KEY.id, 0);

    expect(() => verifyTrackingToken(raw.toString('base64url'), [KEY, OLD_KEY])).toThrow(
      /verification/u,
    );
  });

  it('rejects an open token replayed against a different kind', () => {
    // Without the kind in the signed payload, every recipient holds a working
    // unsubscribe link for themselves inside their own pixel URL — which a
    // prefetching mail client would then fire.
    const raw = Buffer.from(mint({ kind: 'open' }), 'base64url');
    raw.writeUInt8(TOKEN_KINDS.unsubscribe, 1 + 16 + 4);

    expect(() => verifyTrackingToken(raw.toString('base64url'), [KEY])).toThrow(/verification/u);
  });

  it('rejects a truncated token as a length error', () => {
    // Asserted on the typed reason rather than the message. Without the
    // explicit length check, `timingSafeEqual` throws a RangeError whose own
    // message contains the word "length" — so matching the text passes
    // whether or not the check exists.
    const raw = Buffer.from(mint(), 'base64url');

    const error = attempt(() => verifyTrackingToken(raw.subarray(0, 20).toString('base64url'), [KEY]));

    expect(error).toBeInstanceOf(TrackingTokenError);
    expect(error?.reason).toBe('bad_length');
  });

  it('rejects an extended token as a length error', () => {
    const raw = Buffer.concat([Buffer.from(mint(), 'base64url'), Buffer.alloc(4)]);

    const error = attempt(() => verifyTrackingToken(raw.toString('base64url'), [KEY]));

    expect(error).toBeInstanceOf(TrackingTokenError);
    expect(error?.reason).toBe('bad_length');
  });

  it('rejects every truncation length cleanly', () => {
    // One byte short is the interesting one: it is the length at which a
    // naive implementation slices a MAC of the right size out of the wrong
    // bytes.
    const raw = Buffer.from(mint(), 'base64url');

    for (let length = 0; length < raw.length; length += 1) {
      const error = attempt(() =>
        verifyTrackingToken(raw.subarray(0, length).toString('base64url'), [KEY]),
      );

      expect(error, `length ${length}`).toBeInstanceOf(TrackingTokenError);
    }
  });

  it('rejects an empty or absent token', () => {
    for (const bad of ['', null, undefined, 123]) {
      expect(() => verifyTrackingToken(bad as string, [KEY]), String(bad)).toThrow(
        TrackingTokenError,
      );
    }
  });

  it('rejects punctuation rather than letting the decoder skip it', () => {
    // Node's base64url decoder ignores characters it does not recognise, so a
    // token with a dot spliced in decodes shorter and would otherwise be
    // judged on its length instead of its contents.
    const token = mint();

    for (const junk of ['.', '!', '%20', '/', '+', '=', '\n']) {
      const spliced = token.slice(0, 10) + junk + token.slice(10);
      expect(() => verifyTrackingToken(spliced, [KEY]), junk).toThrow(/base64url/u);
    }
  });

  it('rejects a plausible-looking random string', () => {
    for (let i = 0; i < 200; i += 1) {
      const random = randomBytes(TRACKING_TOKEN_LENGTH).toString('base64url');
      expect(() => verifyTrackingToken(random, [KEY])).toThrow(TrackingTokenError);
    }
  });

  it('names why it refused, so the metrics can tell noise from an attack', () => {
    // Malformed input is a scanner; a bad MAC is somebody trying.
    const malformed = attempt(() => verifyTrackingToken('not a token!', [KEY]));
    const badMac = attempt(() => verifyTrackingToken(mint({}, { id: 1, secret: Buffer.alloc(32, 9) }), [KEY]));

    expect(malformed?.reason).toBe('malformed');
    expect(badMac?.reason).toBe('bad_mac');
  });
});

describe('key rotation', () => {
  it('verifies a token minted with a retired key', () => {
    // People open year-old mail. Thirteen months of validity is the point.
    const token = mint({}, OLD_KEY);

    expect(verifyTrackingToken(token, [KEY, OLD_KEY]).keyId).toBe(OLD_KEY.id);
  });

  it('refuses a key that has been retired past its window', () => {
    const token = mint({}, OLD_KEY);

    const error = attempt(() => verifyTrackingToken(token, [KEY]));
    expect(error?.reason).toBe('unknown_key');
  });

  it('mints with the first key, not with whichever verifies', () => {
    // Relying on "the first one that works" is how a rotation quietly starts
    // minting with the key that was on its way out.
    expect(mintingKey([KEY, OLD_KEY])).toBe(KEY);
  });

  it('refuses to mint with no keys at all', () => {
    expect(() => mintingKey([])).toThrow(TrackingTokenError);
  });
});

describe('minting rejects what it cannot represent', () => {
  it('refuses a message token of the wrong size', () => {
    for (const size of [0, 8, 15, 17, 32]) {
      expect(() => mint({ messageToken: Buffer.alloc(size) }), String(size)).toThrow(/16 bytes/u);
    }
  });

  it('refuses a link index that will not fit', () => {
    for (const index of [-1, 1.5, 0x1_00_00_00_00, Number.NaN]) {
      expect(() => mint({ kind: 'click', linkIndex: index }), String(index)).toThrow(/four/u);
    }
  });

  it('refuses a key id that will not fit', () => {
    for (const id of [-1, 256, 1.5]) {
      expect(() => mint({}, { id, secret: KEY.secret }), String(id)).toThrow(/one byte/u);
    }
  });
});

describe('the three kinds', () => {
  it('are distinct bytes', () => {
    expect(new Set(Object.values(TOKEN_KINDS)).size).toBe(3);
  });

  it('round-trip each one', () => {
    for (const kind of ['open', 'click', 'unsubscribe'] as const) {
      expect(verifyTrackingToken(mint({ kind }), [KEY]).kind, kind).toBe(kind);
    }
  });

  it('reject a validly signed token carrying a kind this version does not know', () => {
    // Not a forgery — a rolling deploy. New code mints a fourth kind, an old
    // instance still serving traffic receives it, and the MAC is perfectly
    // valid. It must refuse cleanly rather than read the byte as whatever
    // sorts first, so the token is signed here exactly as the minter would.
    const body = Buffer.alloc(21);
    MESSAGE.copy(body, 0);
    body.writeUInt32BE(0, 16);
    body.writeUInt8(99, 20);

    const signed = Buffer.concat([Buffer.from([KEY.id]), body]);
    const mac = createHmac('sha256', KEY.secret).update(signed).digest().subarray(0, 10);
    const token = Buffer.concat([signed, mac]).toString('base64url');

    const error = attempt(() => verifyTrackingToken(token, [KEY]));

    expect(error).toBeInstanceOf(TrackingTokenError);
    expect(error?.reason).toBe('unknown_kind');
  });
});

function attempt(fn: () => unknown): TrackingTokenError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error as TrackingTokenError;
  }
}
