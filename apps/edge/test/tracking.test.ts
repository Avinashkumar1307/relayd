import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { mintTrackingToken, type TrackingKey } from '@relayd/utils';
import type { DatabasePool } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import { createApp } from '../src/app.js';
import type { TrackingDependencies, TrackingEvent } from '../src/routes/tracking.js';

/**
 * The tracking endpoints over HTTP (docs/06 §13; INVARIANTS R6).
 *
 * Two properties the phase gate names directly: a forged token is rejected
 * without a database read, and one-click unsubscribe acts on POST only. Both
 * are tested here against the real Express app rather than the handler,
 * because both are as much about routing as about logic — a GET route that
 * happens to share a handler with POST would pass a unit test and unsubscribe
 * everyone behind a corporate mail scanner.
 */

const KEY: TrackingKey = { id: 1, secret: Buffer.alloc(32, 7) };
const MESSAGE = Buffer.alloc(16, 42);

function harness(over: Partial<TrackingDependencies> = {}) {
  const events: TrackingEvent[] = [];
  const unsubscribed: Buffer[] = [];
  const query = vi.fn(async () => ({ rows: [] }));

  const tracking: TrackingDependencies = {
    keys: [KEY],
    ipSalt: 'salt-of-the-day',
    enqueueEvent(event) {
      events.push(event);
    },
    async resolveLink(input) {
      return input.linkIndex === 0 ? 'https://example.com/offer' : null;
    },
    fallbackUrl: 'https://relayd.test/link-expired',
    renderUnsubscribeConfirmation: () => '<!doctype html><p>Confirm?</p>',
    async unsubscribe(input) {
      unsubscribed.push(input.messageToken);
    },
    logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ...over,
  };

  const app = createApp({
    pool: { query } as unknown as DatabasePool,
    redis: { ping: async () => 'PONG' } as unknown as RedisConnection,
    logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    tracking,
  });

  return { app, events, unsubscribed, query };
}

function token(kind: 'open' | 'click' | 'unsubscribe', linkIndex = 0): string {
  return mintTrackingToken({ messageToken: MESSAGE, kind, linkIndex }, KEY);
}

describe('the open pixel', () => {
  it('returns a GIF', async () => {
    const { app } = harness();
    const res = await request(app).get(`/o/${token('open')}.gif`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/gif');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('forbids caching, so a proxy cannot swallow every later open', async () => {
    // Worse than losing opens: every recipient behind one corporate proxy
    // would share a single cached response.
    const { app } = harness();
    const res = await request(app).get(`/o/${token('open')}.gif`);

    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['cache-control']).toContain('private');
  });

  it('records the open', async () => {
    const { app, events } = harness();
    await request(app).get(`/o/${token('open')}.gif`);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'open', linkIndex: 0 });
    expect(events[0]?.messageToken.equals(MESSAGE)).toBe(true);
  });

  it('answers a HEAD request and calls it a bot', async () => {
    // Refusing HEAD makes the image look broken in the clients strictest
    // about it, and nothing human sends one.
    const { app, events } = harness();
    const res = await request(app).head(`/o/${token('open')}.gif`);

    expect(res.status).toBe(200);
    expect(events[0]?.bot).toMatchObject({ isBot: true, reason: 'head_request' });
  });

  it('serves the pixel even when the enqueue throws, and says so', async () => {
    // The response is already sent by then, so asserting the status alone
    // proves nothing — it would pass whether or not the throw is contained.
    // What the containment buys is that the failure is logged instead of
    // escaping as an unhandled rejection, so that is what is asserted.
    const warn = vi.fn();
    const { app } = harness({
      enqueueEvent() {
        throw new Error('redis down');
      },
      logger: { warn },
    });

    expect((await request(app).get(`/o/${token('open')}.gif`)).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'redis down' }),
      expect.stringContaining('enqueue'),
    );
  });

  it('does not let an enqueue failure reach the error middleware', async () => {
    // Express would otherwise try to write an error envelope onto a response
    // that has already been sent.
    const { app } = harness({
      enqueueEvent() {
        throw new Error('redis down');
      },
    });

    const res = await request(app).get(`/o/${token('open')}.gif`);

    expect(res.headers['content-type']).toContain('image/gif');
  });
});

describe('the click redirect', () => {
  it('302s to the URL the campaign author saved', async () => {
    const { app } = harness();
    const res = await request(app).get(`/c/${token('click', 0)}`);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://example.com/offer');
  });

  it('resolves by index, never from the token', async () => {
    // The open-redirect hole, closed structurally: there is no field in a
    // token in which to put an attacker's URL.
    const resolveLink = vi.fn(async () => 'https://example.com/offer');
    const { app } = harness({ resolveLink });

    await request(app).get(`/c/${token('click', 3)}`);

    expect(resolveLink).toHaveBeenCalledWith({ messageToken: MESSAGE, linkIndex: 3 });
  });

  it('falls back rather than erroring on an index that no longer exists', async () => {
    // A campaign that changed, not an attack — and an error page is
    // something the reader cannot act on.
    const { app } = harness();
    const res = await request(app).get(`/c/${token('click', 99)}`);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://relayd.test/link-expired');
  });

  it('records the click with its link index', async () => {
    const { app, events } = harness();
    await request(app).get(`/c/${token('click', 0)}`);

    expect(events[0]).toMatchObject({ kind: 'click', linkIndex: 0 });
  });
});

describe('one-click unsubscribe is POST only (R6)', () => {
  it('unsubscribes on POST', async () => {
    const { app, unsubscribed } = harness();
    const res = await request(app).post(`/u/${token('unsubscribe')}`);

    expect(res.status).toBe(200);
    expect(unsubscribed).toHaveLength(1);
  });

  it('changes nothing on GET', async () => {
    // The whole point. Scanners issue GETs constantly, and a GET that
    // unsubscribes means a corporate mail filter silently removes every
    // recipient it protects.
    const unsubscribe = vi.fn(async () => undefined);
    const { app } = harness({ unsubscribe });

    const res = await request(app).get(`/u/${token('unsubscribe')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('renders a confirmation page on GET', async () => {
    const { app } = harness();
    const res = await request(app).get(`/u/${token('unsubscribe')}`);

    expect(res.text).toContain('Confirm?');
  });

  it('records nothing on the GET', async () => {
    const { app, events } = harness();
    await request(app).get(`/u/${token('unsubscribe')}`);
    expect(events).toEqual([]);
  });

  it('records the unsubscribe on the POST', async () => {
    const { app, events } = harness();
    await request(app).post(`/u/${token('unsubscribe')}`);
    expect(events[0]).toMatchObject({ kind: 'unsubscribe' });
  });
});

describe('a forged token', () => {
  it('is rejected without a database read', async () => {
    // The phase gate, stated directly. This is what lets one small service
    // absorb a scanner walking every link in a mailshot.
    const { app, query } = harness();

    const res = await request(app).get('/o/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.gif');

    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('is rejected on every route', async () => {
    const { app } = harness();
    const junk = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

    expect((await request(app).get(`/o/${junk}.gif`)).status).toBe(404);
    expect((await request(app).get(`/c/${junk}`)).status).toBe(404);
    expect((await request(app).get(`/u/${junk}`)).status).toBe(404);
    expect((await request(app).post(`/u/${junk}`)).status).toBe(404);
  });

  it('records no event', async () => {
    const { app, events } = harness();
    await request(app).get('/c/nonsense');
    expect(events).toEqual([]);
  });

  it('never unsubscribes anyone', async () => {
    const { app, unsubscribed } = harness();
    await request(app).post('/u/nonsense');
    expect(unsubscribed).toEqual([]);
  });

  it('gives the same answer whatever is wrong with it', async () => {
    // Distinguishing "bad MAC" from "unknown kind" would turn the endpoint
    // into an oracle for probing the token format.
    const { app } = harness();

    const tooShort = await request(app).get('/o/AAAA.gif');
    const badMac = await request(app).get(
      `/o/${mintTrackingToken({ messageToken: MESSAGE, kind: 'open', linkIndex: 0 }, { id: 1, secret: Buffer.alloc(32, 9) })}.gif`,
    );

    expect(tooShort.status).toBe(badMac.status);
    expect(tooShort.text).toBe(badMac.text);
  });
});

describe('a token replayed against the wrong endpoint', () => {
  it('will not unsubscribe with an open token', async () => {
    // Signed kinds make this unreachable; it is checked anyway because
    // "unreachable" rests on the kind byte being inside the MAC.
    const { app, unsubscribed } = harness();

    const res = await request(app).post(`/u/${token('open')}`);

    expect(res.status).toBe(404);
    expect(unsubscribed).toEqual([]);
  });

  it('will not count an unsubscribe token as an open', async () => {
    const { app, events } = harness();

    expect((await request(app).get(`/o/${token('unsubscribe')}.gif`)).status).toBe(404);
    expect(events).toEqual([]);
  });

  it('will not redirect with an open token', async () => {
    const { app } = harness();
    expect((await request(app).get(`/c/${token('open')}`)).status).toBe(404);
  });
});

describe('the process without tracking keys', () => {
  it('404s the pixel rather than serving one it cannot attribute', async () => {
    const app = createApp({
      pool: { query: vi.fn() } as unknown as DatabasePool,
      redis: { ping: async () => 'PONG' } as unknown as RedisConnection,
      logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    });

    expect((await request(app).get(`/o/${token('open')}.gif`)).status).toBe(404);
  });
});

describe('privacy', () => {
  it('stores a hashed IP, never a raw one', async () => {
    const { app, events } = harness();
    await request(app).get(`/o/${token('open')}.gif`);

    const hash = events[0]?.ipHash ?? '';
    expect(hash).not.toContain('127.0.0.1');
    expect(hash).not.toContain('::');
  });

  it('gives different hashes under different daily salts', async () => {
    // The rotation is what stops the column becoming a pseudonymous
    // identifier in everything but name.
    const monday = harness({ ipSalt: 'monday' });
    const tuesday = harness({ ipSalt: 'tuesday' });

    await request(monday.app).get(`/o/${token('open')}.gif`);
    await request(tuesday.app).get(`/o/${token('open')}.gif`);

    expect(monday.events[0]?.ipHash).not.toBe(tuesday.events[0]?.ipHash);
  });
});
