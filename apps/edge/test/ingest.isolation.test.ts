import { createSign, generateKeyPairSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ingestRoutes, hashBody, tokensMatch, type ResolvedConnection } from '../src/routes/ingest.js';

/**
 * INVARIANTS R4 / review finding F4.
 *
 * The proving test the invariant names: "Post a valid-shaped bounce for
 * workspace B's message id on workspace A's endpoint; assert no suppression
 * in B, one unmatched inbox row."
 *
 * Read the first test in "the cross-tenant attack" below as the invariant
 * itself. The rest are the ways round it that a determined attacker would try
 * next.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PUBLIC_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/** A second connection with its own key — workspace B's. */
const otherPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const OTHER_PUBLIC_KEY = otherPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const TOKEN_A = 'a'.repeat(48);
const TOKEN_B = 'b'.repeat(48);

function signSendgrid(body: Buffer, timestamp: string, key = privateKey): string {
  const signer = createSign('sha256');
  signer.update(timestamp, 'utf8');
  signer.update(body);
  signer.end();
  return signer.sign(key, 'base64');
}

function bounceFor(messageId: string, email: string): Buffer {
  return Buffer.from(
    JSON.stringify([
      {
        email,
        event: 'bounce',
        type: 'bounce',
        timestamp: 1_767_264_000,
        sg_event_id: `evt-${messageId}`,
        sg_message_id: messageId,
      },
    ]),
    'utf8',
  );
}

const CONNECTIONS: Record<string, ResolvedConnection> = {
  [TOKEN_A]: {
    connectionId: 'conn-a',
    workspaceId: 'ws-a',
    providerType: 'sendgrid',
    webhookSecret: PUBLIC_KEY_B64,
    active: true,
  },
  [TOKEN_B]: {
    connectionId: 'conn-b',
    workspaceId: 'ws-b',
    providerType: 'sendgrid',
    webhookSecret: OTHER_PUBLIC_KEY,
    active: true,
  },
};

interface StoredEvent {
  workspaceId: string;
  connectionId: string;
  dedupeKey: string;
  matched: boolean;
}

function harness(overrides: Partial<Record<string, ResolvedConnection | null>> = {}) {
  const stored: StoredEvent[] = [];
  const enqueued: { workspaceId: string; count: number }[] = [];
  const seen = new Set<string>();

  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as never;

  const app = express();
  app.use(
    ingestRoutes({
      logger,
      async resolveEndpointToken(token) {
        if (token in overrides) return overrides[token] ?? null;
        return CONNECTIONS[token] ?? null;
      },
      async storeEvent(input) {
        const key = `${input.connectionId}:${input.dedupeKey}`;
        if (seen.has(key)) return false;
        seen.add(key);

        stored.push({
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
          dedupeKey: input.dedupeKey,
          // Nothing is matched at ingest. Matching happens in the worker,
          // scoped to (workspace_id, provider_connection_id).
          matched: false,
        });
        return true;
      },
      async enqueue(input) {
        enqueued.push({ workspaceId: input.workspaceId, count: input.count });
      },
    }),
  );

  return { app, stored, enqueued };
}

const TIMESTAMP = '1767264100';

/**
 * Sends the exact bytes.
 *
 * `.send(buffer)` with a JSON content type makes superagent serialise the
 * Buffer itself — the route receives `{"type":"Buffer","data":[...]}` and no
 * signature over the real payload can match. A provider posts raw bytes, so
 * the string form is what reproduces production.
 */
function post(app: express.Express, token: string, body: Buffer, headers: Record<string, string>) {
  return request(app)
    .post(`/ingest/v1/sendgrid/${token}`)
    .set('content-type', 'application/json')
    .set(headers)
    .send(body.toString('utf8'));
}

function validHeaders(body: Buffer, key = privateKey) {
  return {
    'x-twilio-email-event-webhook-signature': signSendgrid(body, TIMESTAMP, key),
    'x-twilio-email-event-webhook-timestamp': TIMESTAMP,
  };
}

describe('the cross-tenant attack (R4)', () => {
  it("refuses workspace A's bounce for workspace B's message", async () => {
    // The invariant's own test. Workspace A owns TOKEN_A and signs with their
    // own key. They forge a bounce naming workspace B's message id.
    const { app, stored } = harness();
    const body = bounceFor('ws-b-message-id', 'victim@example.com');

    const response = await post(app, TOKEN_A, body, validHeaders(body));

    // It is accepted only into A's own inbox — the signature really is A's —
    // and it lands unmatched against A's connection, where B's message id
    // means nothing.
    expect(response.status).toBe(202);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.workspaceId).toBe('ws-a');
    expect(stored[0]?.connectionId).toBe('conn-a');
    expect(stored[0]?.matched).toBe(false);

    // Nothing was written for workspace B at all.
    expect(stored.filter((event) => event.workspaceId === 'ws-b')).toEqual([]);
  });

  it("refuses A's signature posted to B's endpoint", async () => {
    // The obvious next attempt: post to B's token instead. The signature is
    // verified against B's own secret, so A's signature is worthless there.
    const { app, stored } = harness();
    const body = bounceFor('ws-b-message-id', 'victim@example.com');

    const response = await post(app, TOKEN_B, body, validHeaders(body));

    expect(response.status).toBe(401);
    expect(stored).toEqual([]);
  });

  it('refuses an unsigned payload on a real endpoint', async () => {
    const { app, stored } = harness();
    const body = bounceFor('m1', 'victim@example.com');

    const response = await post(app, TOKEN_A, body, {});

    expect(response.status).toBe(401);
    expect(stored).toEqual([]);
  });

  it('refuses a token that resolves to nothing, without saying so', async () => {
    // A distinguishable response tells a scanner which tokens exist.
    const { app, stored } = harness();
    const body = bounceFor('m1', 'a@example.com');

    const response = await post(app, 'c'.repeat(48), body, validHeaders(body));

    expect(response.status).toBe(404);
    expect(stored).toEqual([]);
  });

  it('refuses a token of the wrong shape before touching the database', async () => {
    let lookups = 0;
    const app = express();
    app.use(
      ingestRoutes({
        logger: { warn: vi.fn(), error: vi.fn() } as never,
        async resolveEndpointToken() {
          lookups += 1;
          return null;
        },
        async storeEvent() {
          return true;
        },
        async enqueue() {},
      }),
    );

    await request(app).post('/ingest/v1/sendgrid/short').send('{}');
    expect(lookups).toBe(0);
  });

  it('refuses a provider that does not match the token', async () => {
    // Otherwise a token for one connection could be used to post events
    // shaped for a provider the customer never connected.
    const { app, stored } = harness();
    const body = bounceFor('m1', 'a@example.com');

    const response = await request(app)
      .post(`/ingest/v1/ses/${TOKEN_A}`)
      .set('content-type', 'application/json')
      .set(validHeaders(body))
      .send(body.toString('utf8'));

    expect(response.status).toBe(404);
    expect(stored).toEqual([]);
  });

  it('refuses a disabled connection', async () => {
    const { app, stored } = harness({
      [TOKEN_A]: { ...(CONNECTIONS[TOKEN_A] as ResolvedConnection), active: false },
    });
    const body = bounceFor('m1', 'a@example.com');

    const response = await post(app, TOKEN_A, body, validHeaders(body));

    expect(response.status).toBe(404);
    expect(stored).toEqual([]);
  });

  it('refuses a connection whose provider has no webhooks at all', async () => {
    // An SMTP connection receiving a payload is receiving something nobody
    // sent.
    const { app, stored } = harness({
      [TOKEN_A]: {
        connectionId: 'conn-a',
        workspaceId: 'ws-a',
        providerType: 'smtp',
        webhookSecret: 'anything',
        active: true,
      },
    });

    const body = bounceFor('m1', 'a@example.com');
    const response = await request(app)
      .post(`/ingest/v1/smtp/${TOKEN_A}`)
      .set('content-type', 'application/json')
      .set(validHeaders(body))
      .send(body.toString('utf8'));

    expect(response.status).toBe(404);
    expect(stored).toEqual([]);
  });
});

describe('what it does with an event it accepts', () => {
  it('stores it against the resolved connection and enqueues once', async () => {
    const { app, stored, enqueued } = harness();
    const body = bounceFor('m1', 'a@example.com');

    await post(app, TOKEN_A, body, validHeaders(body));

    expect(stored).toEqual([
      { workspaceId: 'ws-a', connectionId: 'conn-a', dedupeKey: 'evt-m1', matched: false },
    ]);
    expect(enqueued).toEqual([{ workspaceId: 'ws-a', count: 1 }]);
  });

  it('marks nothing as matched at ingest', async () => {
    // Matching is the worker's job, scoped to (workspace_id,
    // provider_connection_id). An event matched here would be an event
    // applied before anything checked it belonged to this tenant.
    const { app, stored } = harness();
    const body = bounceFor('m1', 'a@example.com');

    await post(app, TOKEN_A, body, validHeaders(body));
    expect(stored.every((event) => !event.matched)).toBe(true);
  });

  it('stores a redelivery once, and enqueues nothing the second time', async () => {
    // Every provider redelivers. The dedupe key is the provider's own event
    // id, so the second delivery inserts nothing.
    const { app, stored, enqueued } = harness();
    const body = bounceFor('m1', 'a@example.com');
    const headers = validHeaders(body);

    const first = await post(app, TOKEN_A, body, headers);
    const second = await post(app, TOKEN_A, body, headers);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(stored).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  it('keeps a signed payload that yields no events', async () => {
    // An SNS subscription confirmation, or an event type this adapter does
    // not model yet. Discarding it loses the only record that it arrived.
    const { app, stored } = harness();
    const body = Buffer.from(JSON.stringify([{ email: 'a@example.com', event: 'unheard_of' }]));

    const response = await post(app, TOKEN_A, body, validHeaders(body));

    expect(response.status).toBe(202);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.dedupeKey).toBe(hashBody(body));
  });

  it('stores one row per event in a batched payload', async () => {
    const { app, stored, enqueued } = harness();
    const body = Buffer.from(
      JSON.stringify([
        { email: 'a@example.com', event: 'delivered', timestamp: 1, sg_event_id: 'e1' },
        { email: 'b@example.com', event: 'bounce', type: 'bounce', timestamp: 2, sg_event_id: 'e2' },
        { email: 'c@example.com', event: 'open', timestamp: 3, sg_event_id: 'e3' },
      ]),
    );

    await post(app, TOKEN_A, body, validHeaders(body));

    expect(stored.map((event) => event.dedupeKey)).toEqual(['e1', 'e2', 'e3']);
    expect(enqueued).toEqual([{ workspaceId: 'ws-a', count: 3 }]);
  });

  it('answers quickly even when there is nothing to do', async () => {
    // A provider that does not get a prompt 2xx retries, and several of them
    // disable an endpoint that keeps timing out.
    const { app } = harness();
    const body = bounceFor('m1', 'a@example.com');
    const headers = validHeaders(body);

    const started = Date.now();
    await post(app, TOKEN_A, body, headers);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('token comparison', () => {
  it('matches an identical token', () => {
    expect(tokensMatch(TOKEN_A, TOKEN_A)).toBe(true);
  });

  it('rejects a different one, including a prefix', () => {
    expect(tokensMatch(TOKEN_A, TOKEN_B)).toBe(false);
    expect(tokensMatch(TOKEN_A, TOKEN_A.slice(0, 40))).toBe(false);
    expect(tokensMatch('', TOKEN_A)).toBe(false);
  });
});
