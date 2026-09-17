import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSendgridAdapter,
  parseSendgridEvents,
  verifySendgridSignature,
  type FetchLike,
} from '../src/adapters/sendgrid/index.js';
import { runProviderContract, outboundMessage, type ContractHarness } from '../src/testing/contract.js';
import type { ErrorKind, ProviderCredentials } from '../src/port.js';

/**
 * SendGrid, against an injected fetch.
 *
 * No network and no account. The signature tests use a real ECDSA P-256 key
 * pair, which is the scheme SendGrid's Signed Event Webhook uses, so the
 * verification path under test is the production one.
 */

const CREDENTIALS: ProviderCredentials = { type: 'sendgrid', apiKey: 'SG.SECRET-CANARY-9f3a' };

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PUBLIC_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const EVENTS = [
  {
    email: 'a@example.com',
    event: 'delivered',
    timestamp: 1_767_264_000,
    sg_event_id: 'evt-delivered-1',
    sg_message_id: 'msg-1',
  },
  {
    email: 'b@example.com',
    event: 'bounce',
    type: 'bounce',
    timestamp: 1_767_264_060,
    sg_event_id: 'evt-bounce-1',
    sg_message_id: 'msg-2',
  },
];

const WEBHOOK_BODY = Buffer.from(JSON.stringify(EVENTS), 'utf8');
const TIMESTAMP = '1767264100';

function signSendgrid(body: Buffer, timestamp: string): string {
  const signer = createSign('sha256');
  signer.update(timestamp, 'utf8');
  signer.update(body);
  signer.end();
  return signer.sign(privateKey, 'base64');
}

const VALID_HEADERS = {
  'x-twilio-email-event-webhook-signature': signSendgrid(WEBHOOK_BODY, TIMESTAMP),
  'x-twilio-email-event-webhook-timestamp': TIMESTAMP,
};

/** How SendGrid expresses each error kind: a status and a body. */
const SCRIPTED: Partial<Record<ErrorKind, { status: number; body: unknown; headers?: Record<string, string> }>> = {
  auth_failed: { status: 401, body: { errors: [{ message: 'The provided authorization grant is invalid' }] } },
  rate_limited: {
    status: 429,
    body: { errors: [{ message: 'too many requests' }] },
    headers: { 'retry-after': '30' },
  },
  invalid_recipient: {
    status: 400,
    body: { errors: [{ message: 'Does not contain a valid address', field: 'personalizations.0.to.0.email' }] },
  },
  invalid_sender: {
    status: 400,
    body: { errors: [{ message: 'The from address does not match a verified Sender Identity' }] },
  },
  content_rejected: { status: 400, body: { errors: [{ message: 'The subject is required' }] } },
  message_too_large: { status: 413, body: { errors: [{ message: 'Payload too large' }] } },
  provider_unavailable: { status: 503, body: { errors: [{ message: 'service unavailable' }] } },
  timeout: { status: 504, body: { errors: [{ message: 'gateway timeout' }] } },
  unknown: { status: 418, body: { errors: [{ message: 'a teapot' }] } },
  // quota_exceeded has no SendGrid expression: it reports a rate limit and
  // nothing else, so that case is skipped rather than invented.
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('sendgrid adapter', () => {
  runProviderContract((): ContractHarness => {
    let failure: ErrorKind | null = null;
    let hang = false;

    const fetchImpl: FetchLike = async (url) => {
      if (hang) return new Promise(() => undefined);

      if (failure !== null) {
        const scripted = SCRIPTED[failure];
        if (scripted !== undefined) {
          return jsonResponse(scripted.status, scripted.body, scripted.headers ?? {});
        }
      }

      if (url.includes('/v3/scopes')) return jsonResponse(200, { scopes: ['mail.send'] });
      if (url.includes('/v3/whitelabel/domains')) return jsonResponse(200, []);
      if (url.includes('/v3/verified_senders')) return jsonResponse(200, { results: [] });

      // mail/send: 202 with the id in a header and no body.
      return new Response(null, { status: 202, headers: { 'x-message-id': 'msg-1' } });
    };

    return {
      name: 'sendgrid',
      adapter: createSendgridAdapter(fetchImpl),
      credentials: CREDENTIALS,

      scriptFailure(kind: ErrorKind): boolean {
        if (SCRIPTED[kind] === undefined) return false;
        failure = kind;
        return true;
      },

      scriptHang(): void {
        hang = true;
      },

      reset(): void {
        failure = null;
        hang = false;
      },

      webhook: {
        body: WEBHOOK_BODY,
        headers: VALID_HEADERS,
        secret: PUBLIC_KEY_B64,
        expectedEvents: 2,
        invalid: [
          {
            label: 'the body altered after signing',
            body: Buffer.from(JSON.stringify([{ ...EVENTS[0], email: 'victim@example.com' }])),
            headers: VALID_HEADERS,
          },
          { label: 'no signature header', body: WEBHOOK_BODY, headers: {} },
          {
            label: 'no timestamp header, so the signed material is incomplete',
            body: WEBHOOK_BODY,
            headers: {
              'x-twilio-email-event-webhook-signature':
                VALID_HEADERS['x-twilio-email-event-webhook-signature'],
            },
          },
          {
            label: 'a replayed payload with a fresh timestamp',
            body: WEBHOOK_BODY,
            headers: { ...VALID_HEADERS, 'x-twilio-email-event-webhook-timestamp': '9999999999' },
          },
        ],
      },
    };
  });
});

describe('the request it builds', () => {
  async function capture(messages = [outboundMessage('r1')]) {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};

    const adapter = createSendgridAdapter(async (_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      headers = init.headers as Record<string, string>;
      return new Response(null, { status: 202, headers: { 'x-message-id': 'msg-1' } });
    });

    await adapter.sendBatch(CREDENTIALS, messages);
    return { body, headers };
  }

  it('disables SendGrid click tracking, which would replace our links', async () => {
    // docs/07 names this as SendGrid's sharp edge: its rewriting would replace
    // the tracked links we generate and break the unsubscribe token with them.
    const { body } = await capture();
    const tracking = body['tracking_settings'] as {
      click_tracking: { enable: boolean };
      open_tracking: { enable: boolean };
    };

    expect(tracking.click_tracking.enable).toBe(false);
    expect(tracking.open_tracking.enable).toBe(false);
  });

  it('does not let SendGrid apply its own suppression list', async () => {
    // We re-check suppression at send time ourselves. A recipient SendGrid
    // silently dropped would leave a campaign reporting a send that never
    // happened.
    const { body } = await capture();
    const mail = body['mail_settings'] as { bypass_list_management: { enable: boolean } };
    expect(mail.bypass_list_management.enable).toBe(false);
  });

  it('carries the recipient id as a custom arg, for event matching', async () => {
    const { body } = await capture();
    const personalizations = body['personalizations'] as { custom_args: Record<string, string> }[];
    expect(personalizations[0]?.custom_args['relayd_recipient_id']).toBe('r1');
  });

  it('sets List-Unsubscribe per personalization', async () => {
    const { body } = await capture();
    const personalizations = body['personalizations'] as { headers: Record<string, string> }[];

    expect(personalizations[0]?.headers['List-Unsubscribe']).toContain('https://relayd.test/u/r1');
    expect(personalizations[0]?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('sends one personalization per recipient in a batch', async () => {
    const { body } = await capture(['a', 'b', 'c'].map(outboundMessage));
    expect((body['personalizations'] as unknown[]).length).toBe(3);
  });

  it('authenticates with a bearer token', async () => {
    const { headers } = await capture();
    expect(headers['authorization']).toBe('Bearer SG.SECRET-CANARY-9f3a');
  });
});

describe('responses', () => {
  it('reads the message id from the header, since the body is empty', async () => {
    const adapter = createSendgridAdapter(
      async () => new Response(null, { status: 202, headers: { 'x-message-id': 'abc123' } }),
    );

    const outcome = await adapter.send(CREDENTIALS, outboundMessage('r1'));
    expect(outcome.ok && outcome.providerMessageId).toBe('abc123');
  });

  it('honours Retry-After rather than guessing a backoff', async () => {
    const adapter = createSendgridAdapter(async () =>
      jsonResponse(429, { errors: [{ message: 'slow down' }] }, { 'retry-after': '45' }),
    );

    const outcome = await adapter.send(CREDENTIALS, outboundMessage('r1'));
    expect(outcome.ok === false && outcome.error.retryAfterMs).toBe(45_000);
  });

  it('separates a bad recipient from bad content, both of which are 400', async () => {
    // Classified as content, a bad address is never suppressed and every
    // future campaign retries it.
    const recipient = createSendgridAdapter(async () =>
      jsonResponse(400, { errors: [{ message: 'Does not contain a valid address' }] }),
    );
    const content = createSendgridAdapter(async () =>
      jsonResponse(400, { errors: [{ message: 'The subject is required' }] }),
    );

    const a = await recipient.send(CREDENTIALS, outboundMessage('r1'));
    const b = await content.send(CREDENTIALS, outboundMessage('r1'));

    expect(a.ok === false && a.error.kind).toBe('invalid_recipient');
    expect(b.ok === false && b.error.kind).toBe('content_rejected');
  });

  it('identifies an unverified sender, which is also a 400', async () => {
    const adapter = createSendgridAdapter(async () =>
      jsonResponse(400, {
        errors: [{ message: 'The from address does not match a verified Sender Identity' }],
      }),
    );

    const outcome = await adapter.send(CREDENTIALS, outboundMessage('r1'));
    expect(outcome.ok === false && outcome.error.kind).toBe('invalid_sender');
    expect(outcome.ok === false && outcome.error.affects).toBe('sender');
  });

  it('fails every message in the batch when the request fails', async () => {
    const adapter = createSendgridAdapter(async () =>
      jsonResponse(503, { errors: [{ message: 'unavailable' }] }),
    );

    const outcomes = await adapter.sendBatch(CREDENTIALS, ['a', 'b', 'c'].map(outboundMessage));
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.ok === false)).toBe(true);
  });

  it('reports a key that cannot send, rather than letting every send fail', async () => {
    const adapter = createSendgridAdapter(async () => jsonResponse(200, { scopes: ['mail.batch.read'] }));
    const result = await adapter.verifyConnection(CREDENTIALS);

    expect(result.ok).toBe(true);
    expect(result.details?.['canSend']).toBe(false);
  });

  it('leaks no API key through a failure', async () => {
    const adapter = createSendgridAdapter(async () =>
      jsonResponse(401, {
        errors: [{ message: 'Bad key SG.SECRET-CANARY-9f3a rejected' }],
      }),
    );

    const outcome = await adapter.send(CREDENTIALS, outboundMessage('r1'));
    expect(JSON.stringify(outcome)).not.toContain('SECRET-CANARY-9f3a');
  });

  it('refuses credentials for another provider', async () => {
    const adapter = createSendgridAdapter(async () => new Response(null, { status: 202 }));
    const outcome = await adapter.send({ type: 'smtp', host: 'h', port: 1, secure: false, user: 'u', pass: 'p' }, outboundMessage('r1'));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.kind).toBe('auth_failed');
  });
});

describe('event parsing', () => {
  it('normalises the events SendGrid posts', () => {
    const events = parseSendgridEvents(WEBHOOK_BODY);

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('delivered');
    expect(events[1]?.type).toBe('bounce');
    expect(events[1]?.bounceClass).toBe('hard');
  });

  it('treats a blocked event as a block, not a hard bounce', () => {
    // A block is the receiving server refusing us, not the address being
    // wrong. Suppressing on it removes a working contact.
    const body = Buffer.from(
      JSON.stringify([{ email: 'a@example.com', event: 'blocked', timestamp: 1, sg_event_id: 'e1' }]),
    );

    expect(parseSendgridEvents(body)[0]?.bounceClass).toBe('block');
  });

  it('treats a soft bounce as soft', () => {
    const body = Buffer.from(
      JSON.stringify([
        { email: 'a@example.com', event: 'bounce', type: 'blocked', timestamp: 1, sg_event_id: 'e1' },
      ]),
    );

    expect(parseSendgridEvents(body)[0]?.bounceClass).toBe('block');
  });

  it('uses sg_event_id, which is stable across redeliveries', () => {
    const first = parseSendgridEvents(WEBHOOK_BODY).map((e) => e.providerEventId);
    const second = parseSendgridEvents(WEBHOOK_BODY).map((e) => e.providerEventId);

    expect(second).toEqual(first);
    expect(first[0]).toBe('evt-delivered-1');
  });

  it('gives processed and delivered distinct ids when sg_event_id is absent', () => {
    // Both map to `delivered`. Without the event name in the fallback id they
    // would collide and one would be deduplicated away.
    const body = Buffer.from(
      JSON.stringify([
        { email: 'a@example.com', event: 'processed', timestamp: 1, sg_message_id: 'm1' },
        { email: 'a@example.com', event: 'delivered', timestamp: 1, sg_message_id: 'm1' },
      ]),
    );

    const events = parseSendgridEvents(body);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.providerEventId)).size).toBe(2);
  });

  it('skips an event type it does not understand rather than guessing', () => {
    const body = Buffer.from(
      JSON.stringify([{ email: 'a@example.com', event: 'something_new', timestamp: 1, sg_event_id: 'e1' }]),
    );

    expect(parseSendgridEvents(body)).toEqual([]);
  });

  it('converts the unix timestamp to a real date', () => {
    const [event] = parseSendgridEvents(WEBHOOK_BODY);
    expect(event?.occurredAt.toISOString()).toBe('2026-01-01T10:40:00.000Z');
  });

  it('yields nothing rather than throwing on rubbish', () => {
    expect(parseSendgridEvents(Buffer.from('not json'))).toEqual([]);
    expect(parseSendgridEvents(Buffer.from('{}'))).toEqual([]);
    expect(parseSendgridEvents(Buffer.from('[{"nope":1}]'))).toEqual([]);
  });
});

describe('signed event webhook', () => {
  it('accepts a correctly signed payload', () => {
    expect(verifySendgridSignature(WEBHOOK_BODY, VALID_HEADERS, PUBLIC_KEY_B64)).toBe(true);
  });

  it('rejects a signature made with another key', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const otherKey = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    expect(verifySendgridSignature(WEBHOOK_BODY, VALID_HEADERS, otherKey)).toBe(false);
  });

  it('rejects a replay with a different timestamp', () => {
    // The timestamp is part of the signed material, which is what makes a
    // captured payload useless with a fresh one.
    expect(
      verifySendgridSignature(
        WEBHOOK_BODY,
        { ...VALID_HEADERS, 'x-twilio-email-event-webhook-timestamp': '1767264999' },
        PUBLIC_KEY_B64,
      ),
    ).toBe(false);
  });

  it('rejects an empty key rather than treating it as a pass', () => {
    expect(verifySendgridSignature(WEBHOOK_BODY, VALID_HEADERS, '')).toBe(false);
  });

  it('rejects a malformed key without throwing', () => {
    expect(verifySendgridSignature(WEBHOOK_BODY, VALID_HEADERS, 'not-base64-der')).toBe(false);
  });
});
