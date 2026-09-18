import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  billingWebhookRoutes,
  type BillingWebhookDependencies,
} from '../src/routes/billing-webhook.js';

/**
 * Stripe webhook ingest (INVARIANTS R17, review findings F17, F18).
 *
 * The property R17 names is negative and is the one worth stating first: this
 * route never calls Stripe. At the monthly billing boundary Stripe emits
 * events for every customer within a few minutes, and fetching inline means
 * 429s inside HTTP handlers that each owe a 200 in under 200 ms.
 */

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as BillingWebhookDependencies['logger'];

function app(over: Partial<BillingWebhookDependencies> = {}) {
  const calls: string[] = [];
  const seen = new Set<string>();
  const dirtied: string[] = [];
  const verifiedBytes: Buffer[] = [];

  const deps: BillingWebhookDependencies = {
    logger,
    async verify(input) {
      calls.push('verify');
      verifiedBytes.push(input.rawBody);
      return {
        providerEventId: 'evt_1',
        type: 'customer.subscription.updated',
        objectType: 'subscription',
        providerObjectId: 'sub_123',
        workspaceId: 'ws-1',
        payload: { id: 'evt_1' },
      };
    },
    async insertInboxEvent(input) {
      calls.push('insert');
      if (seen.has(input.providerEventId)) return false;
      seen.add(input.providerEventId);
      return true;
    },
    async markDirty(input) {
      calls.push('mark-dirty');
      dirtied.push(input.providerObjectId);
      return undefined;
    },
    ...over,
  };

  const server = express();
  server.use(billingWebhookRoutes(deps));

  return { server, deps, calls, dirtied, verifiedBytes };
}

const BODY = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });

describe('a verified event', () => {
  it('is stored and its object marked dirty', async () => {
    const { server, dirtied } = app();

    const response = await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=abc')
      .set('content-type', 'application/json')
      .send(BODY);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: { received: true, marked: true } });
    expect(dirtied).toEqual(['sub_123']);
  });

  it('is stored before the object is marked', async () => {
    // The inbox row commits before the 200, so a crash after the 200 loses
    // nothing.
    const { server, calls } = app();

    await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=abc')
      .send(BODY);

    expect(calls.indexOf('insert')).toBeLessThan(calls.indexOf('mark-dirty'));
  });

  it('never calls the provider (R17)', async () => {
    // The whole reason this route is two writes. 500 events for one object
    // would otherwise be 500 API calls inside 500 HTTP handlers.
    const { server, calls } = app();

    await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=abc')
      .send(BODY);

    expect(calls).toEqual(['verify', 'insert', 'mark-dirty']);
  });
});

describe('the raw body', () => {
  it('reaches verification byte for byte', async () => {
    // Stripe signs what it sent. Re-serialising parsed JSON changes key
    // order, whitespace and number formatting, and the signature stops
    // matching for every event at once.
    const body = '{"b":1,"a":2,"n":1.50}';
    const { server, verifiedBytes } = app();

    await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=abc')
      .set('content-type', 'application/json')
      .send(body);

    expect(verifiedBytes[0]?.toString('utf8')).toBe(body);
  });

  it('survives a content type Express would otherwise parse', async () => {
    const { server, verifiedBytes } = app();

    await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=abc')
      .set('content-type', 'application/json; charset=utf-8')
      .send(BODY);

    expect(verifiedBytes[0]?.toString('utf8')).toBe(BODY);
  });
});

describe('what the route refuses', () => {
  it('a request with no signature', async () => {
    const { server, calls } = app();

    const response = await request(server).post('/ingest/v1/stripe').send(BODY);

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('a signature that does not verify', async () => {
    const { server, calls } = app({
      async verify() {
        return null;
      },
    });

    const response = await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=wrong')
      .send(BODY);

    expect(response.status).toBe(401);
    expect(calls).not.toContain('insert');
  });

  it('a verifier that throws', async () => {
    // The Stripe SDK throws rather than returning null. Either way nothing is
    // stored.
    const { server, calls } = app({
      async verify() {
        throw new Error('no signatures found matching the expected signature');
      },
    });

    const response = await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=wrong')
      .send(BODY);

    expect(response.status).toBe(401);
    expect(calls).not.toContain('insert');
  });

  it('an empty signature header', async () => {
    // Present and empty is the shape a proxy that strips headers leaves
    // behind. Passed on to `verify` it would be refused there too, but not
    // before the raw bytes had been handed to the SDK — and the reason to
    // refuse here is that an empty string is not a signature somebody sent.
    const { server, calls } = app();

    const response = await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', '')
      .send(BODY);

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('a signature that arrived as several headers', async () => {
    // Node joins duplicate headers into one comma-separated string, so this
    // normally reaches `verify` as a malformed signature and fails there. A
    // proxy or a middleware can still hand Express an array, and picking one
    // element would be choosing which signature to verify against — a
    // decision nobody should make on a caller's behalf.
    const { calls, deps } = app();
    const server = express();
    server.use((req, _res, next) => {
      req.headers['stripe-signature'] = ['t=1,v1=a', 't=2,v1=b'];
      next();
    });
    server.use(billingWebhookRoutes(deps));

    const response = await request(server).post('/ingest/v1/stripe').send(BODY);

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('a body over the limit', async () => {
    const { server } = app({ maxBodyBytes: 64 });

    const response = await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=abc')
      .set('content-type', 'application/json')
      .send('x'.repeat(4_096));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('a redelivery', () => {
  it('answers 200', async () => {
    // Anything else makes Stripe retry, and retrying a duplicate forever is
    // how a webhook endpoint ends up disabled by the provider.
    const { server } = app();

    const send = () =>
      request(server).post('/ingest/v1/stripe').set('stripe-signature', 't=1,v1=abc').send(BODY);

    await send();
    const second = await send();

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ data: { duplicate: true } });
  });

  it('does not mark the object dirty again', async () => {
    // The first delivery already did. Marking again inflates `dirty_count`
    // without changing what the consumer does.
    const { server, dirtied } = app();

    const send = () =>
      request(server).post('/ingest/v1/stripe').set('stripe-signature', 't=1,v1=abc').send(BODY);

    await send();
    await send();

    expect(dirtied).toEqual(['sub_123']);
  });
});

describe('an event about nothing we mirror', () => {
  it('is stored and answered 200 without marking', async () => {
    // A `ping`, a `customer.discount.created`. Refusing it makes Stripe retry
    // something we will never process.
    const { server, calls } = app({
      async verify() {
        return {
          providerEventId: 'evt_ping',
          type: 'ping',
          objectType: null,
          providerObjectId: null,
          workspaceId: null,
          payload: {},
        };
      },
    });

    const response = await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=abc')
      .send(BODY);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: { marked: false } });
    expect(calls).toContain('insert');
    expect(calls).not.toContain('mark-dirty');
  });
});

describe('an event we cannot attribute yet', () => {
  it('is still stored', async () => {
    // A `checkout.session.completed` arriving before our own metadata write
    // has landed. Refusing it would lose it.
    const { server, dirtied } = app({
      async verify() {
        return {
          providerEventId: 'evt_2',
          type: 'checkout.session.completed',
          objectType: 'subscription',
          providerObjectId: 'sub_new',
          workspaceId: null,
          payload: {},
        };
      },
    });

    const response = await request(server)
      .post('/ingest/v1/stripe')
      .set('stripe-signature', 't=1,v1=abc')
      .send(BODY);

    expect(response.status).toBe(200);
    expect(dirtied).toEqual(['sub_new']);
  });
});
