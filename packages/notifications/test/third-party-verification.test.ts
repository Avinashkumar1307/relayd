import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildDelivery } from '../src/webhooks/delivery.js';

/**
 * Verification from a third party's side (BUILD-PLAN Phase 9).
 *
 * Everything else about the signature is tested with our own helper, which
 * proves the two halves of one implementation agree — a property that would
 * survive the scheme being wrong in both directions at once.
 *
 * So this file is deliberately written as an integrator would write it:
 * `node:crypto`, the documented header format, and nothing imported from
 * `@relayd/utils`. The only thing under test is whether a payload we built
 * can be verified by somebody who has read the documentation and has our
 * secret, which is the actual promise.
 *
 * The verifier below is also, near enough, the snippet that should end up in
 * the docs. If it stops being short, the scheme has become too clever.
 */

const SECRET = 'whsec_' + 'a'.repeat(32);
const NOW = new Date('2026-09-19T12:00:00.000Z');

/**
 * An integrator's verifier, written from the documentation.
 *
 * Signature header: `t=<unix seconds>,v1=<hex hmac>`
 * Signed payload:   `<timestamp>.<raw body>`
 * Algorithm:        HMAC-SHA256
 * Tolerance:        five minutes
 */
function verifyAsThirdParty(input: {
  rawBody: string;
  signatureHeader: string;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): boolean {
  const parts = new Map(
    input.signatureHeader.split(',').map((part) => {
      const [key, ...rest] = part.split('=');
      return [key?.trim() ?? '', rest.join('=').trim()];
    }),
  );

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');

  if (!Number.isInteger(timestamp) || provided === undefined) return false;

  const tolerance = input.toleranceSeconds ?? 300;
  const age = Math.abs(Math.floor(input.now.getTime() / 1000) - timestamp);
  if (age > tolerance) return false;

  const expected = createHmac('sha256', input.secret)
    .update(`${timestamp}.${input.rawBody}`, 'utf8')
    .digest('hex');

  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function delivery(over: Record<string, unknown> = {}) {
  return buildDelivery({
    url: 'https://hooks.example.com/relayd',
    secret: SECRET,
    eventId: '018f7d00-0000-7000-8000-000000000001',
    eventType: 'campaign.sent',
    occurredAt: NOW,
    data: { campaignId: 'c1', recipients: 4210 },
    at: NOW,
    attempt: 1,
    ...over,
  });
}

function headerOf(built: ReturnType<typeof buildDelivery>): string {
  return built.headers['relayd-signature'] as string;
}

describe('an integrator with the documentation and the secret', () => {
  it('can verify what we send', () => {
    // The promise. Everything else in this file is a way of it being false.
    const built = delivery();

    expect(
      verifyAsThirdParty({
        rawBody: built.body,
        signatureHeader: headerOf(built),
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('can verify a retry of the same event', () => {
    const built = delivery({ attempt: 5 });

    expect(
      verifyAsThirdParty({
        rawBody: built.body,
        signatureHeader: headerOf(built),
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rejects a body that was altered in transit', () => {
    const built = delivery();

    expect(
      verifyAsThirdParty({
        rawBody: built.body.replace('4210', '1'),
        signatureHeader: headerOf(built),
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const built = delivery();

    expect(
      verifyAsThirdParty({
        rawBody: built.body,
        signatureHeader: headerOf(built),
        secret: 'whsec_somebody_elses',
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rejects a replay from yesterday', () => {
    const built = delivery();

    expect(
      verifyAsThirdParty({
        rawBody: built.body,
        signatureHeader: headerOf(built),
        secret: SECRET,
        now: new Date(NOW.getTime() + 86_400_000),
      }),
    ).toBe(false);
  });

  it('rejects a replay whose timestamp was edited to look fresh', () => {
    // The attack the whole design turns on. Edit `t=` and the signature no
    // longer matches, because the timestamp is inside the MAC.
    const built = delivery();
    const original = headerOf(built);
    const forged = original.replace(
      /t=\d+/u,
      `t=${Math.floor((NOW.getTime() + 86_400_000) / 1000)}`,
    );

    expect(
      verifyAsThirdParty({
        rawBody: built.body,
        signatureHeader: forged,
        secret: SECRET,
        now: new Date(NOW.getTime() + 86_400_000),
      }),
    ).toBe(false);
  });
});

describe('what the integrator reads out of the payload', () => {
  it('finds the event id in both the header and the body, and they agree', () => {
    // So they can deduplicate before parsing under load, and after parsing
    // when they are being careful.
    const built = delivery();
    const body = JSON.parse(built.body) as { id: string; type: string; occurredAt: string };

    expect(built.headers['relayd-event-id']).toBe(body.id);
  });

  it('finds an event type and a timestamp', () => {
    const built = delivery();
    const body = JSON.parse(built.body) as { type: string; occurredAt: string };

    expect(body.type).toBe('campaign.sent');
    expect(new Date(body.occurredAt).toISOString()).toBe(NOW.toISOString());
  });

  it('gets the same event id on every attempt', () => {
    // The property at-least-once delivery rests on from their side: without
    // it they cannot tell a retry from a second event.
    const ids = [1, 2, 3, 8].map(
      (attempt) => (JSON.parse(delivery({ attempt }).body) as { id: string }).id,
    );

    expect(new Set(ids).size).toBe(1);
  });

  it('is told which attempt it is, without that changing the signature', () => {
    // The attempt is a header, not part of the signed body, so a consumer who
    // logs it sees the retry count while the body stays byte-identical.
    const first = delivery({ attempt: 1 });
    const later = delivery({ attempt: 6 });

    expect(first.headers['relayd-delivery-attempt']).toBe('1');
    expect(later.headers['relayd-delivery-attempt']).toBe('6');
    expect(later.body).toBe(first.body);
  });
});

describe('the verifier itself', () => {
  it('is short enough to put in the documentation', () => {
    // Not a joke. If verifying takes more than a screenful, integrators get
    // it wrong or skip it, and a signature nobody checks is decoration.
    const lines = verifyAsThirdParty.toString().split('\n').length;

    expect(lines).toBeLessThan(30);
  });

  it('needs nothing from us but the secret', () => {
    // No SDK, no import. An integrator on a language we will never ship a
    // client for has to be able to do this.
    const source = verifyAsThirdParty.toString();

    expect(source).not.toContain('relayd');
    expect(source).not.toContain('@relayd');
  });
});
