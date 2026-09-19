import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_TOLERANCE_SECONDS,
  constantTimeEquals,
  parseSignatureHeader,
  signWebhook,
  verifyWebhookSignature,
} from '../src/crypto/webhook-signature.js';

/**
 * Outbound webhook signatures.
 *
 * This file is written from the position of somebody attacking it, because
 * that is the only useful way to read a signature scheme. Each test is a way
 * in that the implementation has to be closed against: edit the timestamp,
 * replay an old delivery, swap the body, guess a prefix.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const SECRET = 'whsec_' + 'a'.repeat(32);
const BODY = JSON.stringify({ id: 'evt_1', type: 'campaign.sent' });

function verify(over: Record<string, unknown> = {}) {
  const signed = signWebhook({ body: BODY, secret: SECRET, at: NOW });

  return verifyWebhookSignature({
    body: BODY,
    header: signed.header,
    secrets: [SECRET],
    now: NOW,
    ...over,
  });
}

describe('signing', () => {
  it('produces the header shape integrators expect', () => {
    // Deliberately Stripe's shape. An integrator who has written one verifier
    // can write ours in five minutes.
    const signed = signWebhook({ body: BODY, secret: SECRET, at: NOW });

    expect(signed.header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/u);
  });

  it('uses whole seconds', () => {
    // The header carries seconds, so a verifier re-deriving the signed string
    // from milliseconds would MAC over something else entirely.
    const signed = signWebhook({
      body: BODY,
      secret: SECRET,
      at: new Date('2026-09-19T12:00:00.999Z'),
    });

    expect(signed.timestamp).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it('signs a different body differently', () => {
    const a = signWebhook({ body: BODY, secret: SECRET, at: NOW });
    const b = signWebhook({ body: `${BODY} `, secret: SECRET, at: NOW });

    expect(a.signature).not.toBe(b.signature);
  });

  it('signs with a different secret differently', () => {
    const a = signWebhook({ body: BODY, secret: SECRET, at: NOW });
    const b = signWebhook({ body: BODY, secret: 'whsec_other', at: NOW });

    expect(a.signature).not.toBe(b.signature);
  });
});

describe('verifying', () => {
  it('accepts what it signed', () => {
    expect(verify()).toEqual({ valid: true });
  });

  it('refuses a changed body', () => {
    const signed = signWebhook({ body: BODY, secret: SECRET, at: NOW });

    expect(
      verifyWebhookSignature({
        body: JSON.stringify({ id: 'evt_1', type: 'campaign.deleted' }),
        header: signed.header,
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'no_matching_signature' });
  });

  it('refuses a changed timestamp', () => {
    // The timestamp is inside the MAC. A timestamp merely *alongside* it is a
    // timestamp an attacker edits, replaying yesterday's delivery with
    // today's clock while the signature still verifies.
    const signed = signWebhook({ body: BODY, secret: SECRET, at: NOW });
    const forged = `t=${signed.timestamp + 1},v1=${signed.signature}`;

    expect(
      verifyWebhookSignature({ body: BODY, header: forged, secrets: [SECRET], now: NOW }),
    ).toEqual({ valid: false, reason: 'no_matching_signature' });
  });

  it('refuses the wrong secret', () => {
    expect(verify({ secrets: ['whsec_wrong'] })).toEqual({
      valid: false,
      reason: 'no_matching_signature',
    });
  });

  it('refuses when there are no secrets at all', () => {
    // An endpoint whose secret failed to load must not verify everything.
    expect(verify({ secrets: [] }).valid).toBe(false);
  });

  it('ignores an empty secret in the list', () => {
    // A missing previous secret read as `''` would otherwise be MACed with.
    // The attack is signing *with* the empty secret: anybody who guesses that
    // an endpoint failed to load its secret gets in, and they can guess it
    // for free by trying.
    const forged = signWebhook({ body: BODY, secret: '', at: NOW });

    expect(
      verifyWebhookSignature({ body: BODY, header: forged.header, secrets: [''], now: NOW }),
    ).toEqual({ valid: false, reason: 'no_matching_signature' });

    expect(verify({ secrets: ['', SECRET] })).toEqual({ valid: true });
  });
});

describe('replay', () => {
  it('refuses a delivery older than the tolerance', () => {
    // Without a bound a captured request is valid forever, so seeing one
    // request is enough to replay it whenever it suits.
    const signed = signWebhook({ body: BODY, secret: SECRET, at: NOW });

    expect(
      verifyWebhookSignature({
        body: BODY,
        header: signed.header,
        secrets: [SECRET],
        now: new Date(NOW.getTime() + (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000),
      }),
    ).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('accepts one inside the tolerance', () => {
    const signed = signWebhook({ body: BODY, secret: SECRET, at: NOW });

    expect(
      verifyWebhookSignature({
        body: BODY,
        header: signed.header,
        secrets: [SECRET],
        now: new Date(NOW.getTime() + (SIGNATURE_TOLERANCE_SECONDS - 1) * 1000),
      }),
    ).toEqual({ valid: true });
  });

  it('refuses one from the future too', () => {
    // A one-sided check accepts anything ahead of our clock, and "ahead of
    // our clock" is where an attacker puts a timestamp they control.
    const signed = signWebhook({
      body: BODY,
      secret: SECRET,
      at: new Date(NOW.getTime() + (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000),
    });

    expect(
      verifyWebhookSignature({ body: BODY, header: signed.header, secrets: [SECRET], now: NOW }),
    ).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('uses five minutes', () => {
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });

  it('takes a caller-supplied tolerance', () => {
    const signed = signWebhook({ body: BODY, secret: SECRET, at: NOW });

    expect(
      verifyWebhookSignature({
        body: BODY,
        header: signed.header,
        secrets: [SECRET],
        now: new Date(NOW.getTime() + 10_000),
        toleranceSeconds: 5,
      }).valid,
    ).toBe(false);
  });
});

describe('rotation', () => {
  it('accepts either live secret', () => {
    // The overlap window. A rotation with no overlap breaks every consumer
    // at the instant it lands, which makes rotation something nobody does.
    const signedWithOld = signWebhook({ body: BODY, secret: 'whsec_old', at: NOW });

    expect(
      verifyWebhookSignature({
        body: BODY,
        header: signedWithOld.header,
        secrets: ['whsec_new', 'whsec_old'],
        now: NOW,
      }),
    ).toEqual({ valid: true });
  });

  it('accepts the new one as well', () => {
    const signedWithNew = signWebhook({ body: BODY, secret: 'whsec_new', at: NOW });

    expect(
      verifyWebhookSignature({
        body: BODY,
        header: signedWithNew.header,
        secrets: ['whsec_new', 'whsec_old'],
        now: NOW,
      }),
    ).toEqual({ valid: true });
  });
});

describe('the header parser', () => {
  it('reads a well-formed header', () => {
    expect(parseSignatureHeader(`t=1789000000,v1=${'a'.repeat(64)}`)).toEqual({
      timestamp: 1_789_000_000,
      signature: 'a'.repeat(64),
    });
  });

  it('reads the fields in either order', () => {
    expect(parseSignatureHeader(`v1=${'b'.repeat(64)},t=1789000000`)?.timestamp).toBe(
      1_789_000_000,
    );
  });

  it('tolerates a field it does not know', () => {
    // Adding a `v2=` alongside `v1=` is how this scheme gets upgraded without
    // breaking every existing consumer. A parser that refused unknown fields
    // would make that impossible.
    expect(
      parseSignatureHeader(`t=1789000000,v1=${'c'.repeat(64)},v2=something`)?.signature,
    ).toBe('c'.repeat(64));
  });

  it('refuses a timestamp with trailing rubbish', () => {
    // `parseInt('12abc')` is 12, which would accept a header nobody sent.
    expect(parseSignatureHeader(`t=1789000000abc,v1=${'a'.repeat(64)}`)).toBe(null);
  });

  it('refuses a signature of the wrong shape', () => {
    expect(parseSignatureHeader('t=1789000000,v1=short')).toBe(null);
    expect(parseSignatureHeader(`t=1789000000,v1=${'A'.repeat(64)}`)).toBe(null);
    expect(parseSignatureHeader(`t=1789000000,v1=${'z'.repeat(64)}`)).toBe(null);
  });

  it('refuses a header missing either field', () => {
    expect(parseSignatureHeader('t=1789000000')).toBe(null);
    expect(parseSignatureHeader(`v1=${'a'.repeat(64)}`)).toBe(null);
    expect(parseSignatureHeader('')).toBe(null);
  });

  it('refuses garbage without throwing', () => {
    for (const header of ['=', ',,,', 't=,v1=', 'nonsense']) {
      expect(parseSignatureHeader(header)).toBe(null);
    }
  });

  it('is reported as malformed rather than as a bad signature', () => {
    // So an integrator debugging knows to look at their header construction
    // rather than at their secret.
    expect(
      verifyWebhookSignature({ body: BODY, header: 'nonsense', secrets: [SECRET], now: NOW }),
    ).toEqual({ valid: false, reason: 'malformed_header' });
  });
});

describe('the comparison', () => {
  it('matches equal strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, and that throw would be
    // the timing signal it exists to remove.
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });
});

describe('the comparison is constant time, in the source', () => {
  /**
   * Timing is not observable from a test, so this reads the file.
   *
   * The same instrument the repo uses for the other properties no assertion
   * can reach — the `SET LOCAL` grep, the recipient-count grep. A `===` here
   * passes every functional test in this file and leaks the prefix of a valid
   * signature one request at a time.
   */
  it('verifies through the helper rather than with ===', async () => {
    const source = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/crypto/webhook-signature.ts'),
      'utf8',
    );

    const body = source.slice(source.indexOf('export function verifyWebhookSignature'));
    const loop = body.slice(0, body.indexOf('export function parseSignatureHeader'));

    expect(loop).toContain('constantTimeEquals(');
    expect(loop).not.toMatch(/hmac\([^)]*\)\s*===/u);
  });
});
