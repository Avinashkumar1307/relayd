// @vitest-environment node
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { workspaceScope } from '@relayd/db';
import type { IdempotencyRecord, WorkspaceId } from '@relayd/db';
import {
  canonicalHash,
  idempotent,
  replayDecision,
  type IdempotencyPort,
} from '../src/middleware/idempotency.js';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import { setWorkspaceContext } from '../src/context.js';

/**
 * Idempotency (docs/03).
 *
 * A caller that does not know whether their POST arrived retries it. Three
 * things make that safe, and each is tested for the failure it prevents:
 * the claim is taken before the work starts, the request body is hashed and
 * compared, and a failed request releases its claim rather than storing the
 * failure.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const WS = 'ws-a' as WorkspaceId;

/**
 * An in-memory store that behaves like the SQL does: the claim is a single
 * conditional insert, and completion is guarded on the row still being in
 * progress.
 */
function store() {
  const rows = new Map<string, IdempotencyRecord>();
  const calls: string[] = [];

  const port: IdempotencyPort = {
    async claim(_scope, input) {
      calls.push('claim');
      const id = `${input.key}:${input.endpoint}`;
      const existing = rows.get(id);

      if (existing !== undefined) return { claimed: false, existing };

      rows.set(id, {
        key: input.key,
        endpoint: input.endpoint,
        requestHash: input.requestHash,
        status: 'in_progress',
        responseCode: null,
        responseBody: null,
        lockedAt: input.now,
        expiresAt: new Date(input.now.getTime() + 86_400_000),
      });

      return { claimed: true, existing: null };
    },

    async reclaim(_scope, input) {
      calls.push('reclaim');
      const id = `${input.key}:${input.endpoint}`;
      const existing = rows.get(id);
      if (existing === undefined || existing.status !== 'in_progress') return false;

      rows.set(id, { ...existing, requestHash: input.requestHash, lockedAt: input.now });
      return true;
    },

    async complete(_scope, input) {
      calls.push('complete');
      const id = `${input.key}:${input.endpoint}`;
      const existing = rows.get(id);
      if (existing === undefined || existing.status !== 'in_progress') return false;

      rows.set(id, {
        ...existing,
        status: 'completed',
        responseCode: input.responseCode,
        responseBody: input.responseBody,
        lockedAt: null,
      });
      return true;
    },

    async release(_scope, input) {
      calls.push('release');
      rows.delete(`${input.key}:${input.endpoint}`);
    },
  };

  return { port, rows, calls };
}

function buildApp(
  port: IdempotencyPort,
  over: {
    required?: boolean;
    lockMs?: number;
    handler?: (req: Request, res: Response) => void;
  } = {},
): { app: Express; runs: number[] } {
  const runs: number[] = [];

  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);
  app.use((_req, _res, next) => {
    setWorkspaceContext({
      scope: workspaceScope(WS),
      role: 'owner',
      permissions: ['campaign:launch'],
    });
    next();
  });

  app.post(
    '/things',
    idempotent('POST /things', {
      store: port,
      now: () => NOW,
      ...(over.required === undefined ? {} : { required: over.required }),
      ...(over.lockMs === undefined ? {} : { lockMs: over.lockMs }),
    }),
    (req: Request, res: Response) => {
      runs.push(runs.length + 1);
      if (over.handler !== undefined) {
        over.handler(req, res);
        return;
      }
      res.status(201).json({ data: { id: `thing-${runs.length}` } });
    },
  );

  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return { app, runs };
}

function post(app: Express, key: string, body: unknown = { name: 'Spring' }) {
  return request(app).post('/things').set('Idempotency-Key', key).send(body as object);
}

describe('the canonical hash', () => {
  it('ignores key order', () => {
    // Two clients serialising the same intent must not disagree about
    // whether it is the same intent.
    expect(canonicalHash({ a: 1, b: 2 })).toEqual(canonicalHash({ b: 2, a: 1 }));
  });

  it('respects array order', () => {
    // `[1,2]` and `[2,1]` are genuinely different bodies.
    expect(canonicalHash({ ids: [1, 2] })).not.toEqual(canonicalHash({ ids: [2, 1] }));
  });

  it('ignores an explicitly undefined member', () => {
    // JSON drops it, so hashing must too, or `{a:1}` and `{a:1,b:undefined}`
    // are different requests for the same call.
    expect(canonicalHash({ a: 1 })).toEqual(canonicalHash({ a: 1, b: undefined }));
  });

  it('distinguishes null from absent', () => {
    // `null` survives JSON and means something.
    expect(canonicalHash({ a: 1 })).not.toEqual(canonicalHash({ a: 1, b: null }));
  });

  it('goes deep', () => {
    expect(canonicalHash({ a: { x: 1, y: 2 } })).toEqual(canonicalHash({ a: { y: 2, x: 1 } }));
    expect(canonicalHash({ a: { x: 1 } })).not.toEqual(canonicalHash({ a: { x: 2 } }));
  });

  it('distinguishes a number from its string', () => {
    expect(canonicalHash({ a: 1 })).not.toEqual(canonicalHash({ a: '1' }));
  });
});

describe('a first request', () => {
  it('runs and records its response', async () => {
    const { port, rows, calls } = store();
    const { app, runs } = buildApp(port);

    const res = await post(app, 'key-00000001');

    expect(res.status).toBe(201);
    expect(runs).toEqual([1]);
    expect(calls).toContain('claim');
    expect(rows.get('key-00000001:POST /things')?.status).toBe('completed');
  });

  it('claims before the handler runs', async () => {
    // A read followed by an insert is a race in which two requests both see
    // nothing and both proceed.
    const seen: string[] = [];
    const { port, calls } = store();
    const { app } = buildApp(port, {
      handler: (_req, res) => {
        seen.push(...calls);
        res.status(201).json({ data: {} });
      },
    });

    await post(app, 'key-00000001');

    expect(seen).toEqual(['claim']);
  });
});

describe('a retry with the same body', () => {
  it('replays the first response without running again', async () => {
    const { port } = store();
    const { app, runs } = buildApp(port);

    const first = await post(app, 'key-00000001');
    const second = await post(app, 'key-00000001');

    expect(runs).toEqual([1]);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });

  it('says it is a replay', async () => {
    // So a client can tell "I created it" from "it was already there".
    const { port } = store();
    const { app } = buildApp(port);

    await post(app, 'key-00000001');

    expect((await post(app, 'key-00000001')).get('Idempotent-Replay')).toBe('true');
  });

  it('replays the original status, not a 200', async () => {
    const { port } = store();
    const { app } = buildApp(port);

    await post(app, 'key-00000001');

    expect((await post(app, 'key-00000001')).status).toBe(201);
  });
});

describe('a retry with a different body', () => {
  it('is an error rather than a replay', async () => {
    // Otherwise "retry my contact import" answers with the campaign somebody
    // launched yesterday under the same key.
    const { port } = store();
    const { app, runs } = buildApp(port);

    await post(app, 'key-00000001', { name: 'Spring' });
    const second = await post(app, 'key-00000001', { name: 'Autumn' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_key_reuse');
    expect(runs).toEqual([1]);
  });

  it('is an error while the first request is still running too', () => {
    // The caller has made a mistake whether or not the first one finished,
    // and "still in progress" would send them back to retry the wrong thing.
    const decision = replayDecision(
      {
        key: 'k',
        endpoint: 'e',
        requestHash: canonicalHash({ a: 1 }),
        status: 'in_progress',
        responseCode: null,
        responseBody: null,
        lockedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 1_000),
      },
      { requestHash: canonicalHash({ a: 2 }), now: NOW, lockMs: 30_000 },
    );

    expect(decision.kind).toBe('reuse');
  });
});

describe('a request that is still running', () => {
  it('is refused with a conflict', async () => {
    const { port } = store();
    const { app } = buildApp(port);

    // A claim with no completion — the first request is still in flight.
    await port.claim(workspaceScope(WS), {
      key: 'key-00000001',
      endpoint: 'POST /things',
      requestHash: canonicalHash({ name: 'Spring' }),
      now: NOW,
    });

    const res = await post(app, 'key-00000001');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });
});

describe('a claim whose holder died', () => {
  it('is taken over rather than held for a day', async () => {
    // A crashed request must not lock a key for twenty-four hours: the caller
    // retries, gets `in progress` forever, and has no way out but support.
    const { port, calls } = store();
    const { app, runs } = buildApp(port, { lockMs: 1_000 });

    await port.claim(workspaceScope(WS), {
      key: 'key-00000001',
      endpoint: 'POST /things',
      requestHash: canonicalHash({ name: 'Spring' }),
      now: new Date(NOW.getTime() - 60_000),
    });

    const res = await post(app, 'key-00000001');

    expect(res.status).toBe(201);
    expect(runs).toEqual([1]);
    expect(calls).toContain('reclaim');
  });

  it('is not taken over while the lock is fresh', async () => {
    const { port } = store();
    const { app } = buildApp(port, { lockMs: 60_000 });

    await port.claim(workspaceScope(WS), {
      key: 'key-00000001',
      endpoint: 'POST /things',
      requestHash: canonicalHash({ name: 'Spring' }),
      now: new Date(NOW.getTime() - 1_000),
    });

    expect((await post(app, 'key-00000001')).status).toBe(409);
  });

  it('refuses when somebody else wins the takeover', async () => {
    const { port } = store();
    const losing: IdempotencyPort = {
      ...port,
      async reclaim() {
        return false;
      },
    };
    const { app } = buildApp(losing, { lockMs: 1_000 });

    await port.claim(workspaceScope(WS), {
      key: 'key-00000001',
      endpoint: 'POST /things',
      requestHash: canonicalHash({ name: 'Spring' }),
      now: new Date(NOW.getTime() - 60_000),
    });

    expect((await post(app, 'key-00000001')).status).toBe(409);
  });
});

describe('a request that failed', () => {
  it('releases the claim rather than storing the failure', async () => {
    // A 502 replayed for twenty-four hours is worse than the duplicate this
    // was protecting against.
    const { port, rows, calls } = store();
    const { app } = buildApp(port, {
      handler: (_req, res) => {
        res.status(502).json({ error: { code: 'provider_unavailable' } });
      },
    });

    await post(app, 'key-00000001');

    expect(calls).toContain('release');
    expect(rows.has('key-00000001:POST /things')).toBe(false);
  });

  it('lets the caller retry immediately with the same key', async () => {
    let failFirst = true;
    const { port } = store();
    const { app, runs } = buildApp(port, {
      handler: (_req, res) => {
        if (failFirst) {
          failFirst = false;
          res.status(502).json({ error: { code: 'provider_unavailable' } });
          return;
        }
        res.status(201).json({ data: { id: 'thing-1' } });
      },
    });

    await post(app, 'key-00000001');
    const second = await post(app, 'key-00000001');

    expect(second.status).toBe(201);
    expect(runs).toEqual([1, 2]);
  });

  it('releases on a redirect too, not only on an error', async () => {
    // A 3xx from a POST is not a completed creation. Storing it means the
    // retry replays a redirect and the work never happens; releasing means
    // the retry does it. Releasing is the recoverable half.
    const { port, rows, calls } = store();
    const { app } = buildApp(port, {
      handler: (_req, res) => {
        res.status(302).json({ data: { location: '/elsewhere' } });
      },
    });

    await post(app, 'key-00000001');

    expect(calls).toContain('release');
    expect(rows.has('key-00000001:POST /things')).toBe(false);
  });

  it('does not fail the response when recording fails', async () => {
    const { port } = store();
    const broken: IdempotencyPort = {
      ...port,
      async complete() {
        throw new Error('database down');
      },
    };
    const { app } = buildApp(broken);

    expect((await post(app, 'key-00000001')).status).toBe(201);
  });
});

describe('the key itself', () => {
  it('is required', async () => {
    // docs/03: mandatory on every POST that creates or charges.
    const { port } = store();
    const { app } = buildApp(port);

    const res = await request(app).post('/things').send({ name: 'Spring' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Idempotency-Key');
  });

  it('can be optional where a route says so', async () => {
    const { port } = store();
    const { app, runs } = buildApp(port, { required: false });

    expect((await request(app).post('/things').send({ name: 'Spring' })).status).toBe(201);
    expect(runs).toEqual([1]);
  });

  it('is bounded', async () => {
    const { port } = store();
    const { app } = buildApp(port);

    expect((await post(app, 'short')).status).toBe(400);
    expect((await post(app, 'x'.repeat(300))).status).toBe(400);
  });
});

describe('the endpoint is part of the key', () => {
  it('so the same key against two routes is two requests', async () => {
    // Collapsing them would replay a campaign launch as a contact import.
    const { port, rows } = store();
    const { app } = buildApp(port);

    await post(app, 'key-00000001');

    const other = express();
    other.use(express.json());
    other.use(requestContext);
    other.use((_req, _res, next) => {
      setWorkspaceContext({
        scope: workspaceScope(WS),
        role: 'owner',
        permissions: ['campaign:launch'],
      });
      next();
    });
    other.post(
      '/others',
      idempotent('POST /others', { store: port, now: () => NOW }),
      (_req: Request, res: Response) => {
        res.status(201).json({ data: { id: 'other-1' } });
      },
    );

    const res = await request(other)
      .post('/others')
      .set('Idempotency-Key', 'key-00000001')
      .send({ name: 'Spring' });

    expect(res.status).toBe(201);
    expect(rows.size).toBe(2);
  });
});

describe('deciding what to do with a held key', () => {
  function record(over: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
    return {
      key: 'k',
      endpoint: 'e',
      requestHash: canonicalHash({ a: 1 }),
      status: 'in_progress',
      responseCode: null,
      responseBody: null,
      lockedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 1_000),
      ...over,
    };
  }

  const same = { requestHash: canonicalHash({ a: 1 }), now: NOW, lockMs: 30_000 };

  it('treats a vanished row as takeable', () => {
    // Expired, or released by a failure. Telling the caller a request is in
    // progress that is not would strand them.
    expect(replayDecision(null, same).kind).toBe('stale');
  });

  it('replays a completed row', () => {
    const decision = replayDecision(
      record({ status: 'completed', responseCode: 201, responseBody: { data: {} } }),
      same,
    );

    expect(decision).toMatchObject({ kind: 'replay', responseCode: 201 });
  });

  it('replays a completed row with no stored code as a 200', () => {
    // A bug upstream, not a reason to fail the caller.
    expect(
      replayDecision(record({ status: 'completed', responseCode: null }), same),
    ).toMatchObject({ kind: 'replay', responseCode: 200 });
  });

  it('treats a claim with no lock time as takeable', () => {
    expect(replayDecision(record({ lockedAt: null }), same).kind).toBe('stale');
  });

  it('holds a fresh claim', () => {
    expect(
      replayDecision(record({ lockedAt: new Date(NOW.getTime() - 1_000) }), same).kind,
    ).toBe('in_progress');
  });

  it('releases one at exactly the lock duration', () => {
    expect(
      replayDecision(record({ lockedAt: new Date(NOW.getTime() - 30_000) }), same).kind,
    ).toBe('stale');
  });

  it('checks the body before anything else', () => {
    // Every state. A mismatched body is a mistake whether the first request
    // finished, is running, or died.
    for (const status of ['in_progress', 'completed'] as const) {
      expect(
        replayDecision(record({ status }), {
          ...same,
          requestHash: canonicalHash({ a: 99 }),
        }).kind,
      ).toBe('reuse');
    }
  });
});

describe('what it does not do', () => {
  it('does not lock the resource against a different key', async () => {
    // Two requests with different keys can still both launch the same
    // campaign. That is what the guarded state transition in Postgres is
    // for; this makes a retry safe, not a race.
    const { port } = store();
    const { app, runs } = buildApp(port);

    await post(app, 'key-00000001');
    await post(app, 'key-00000002');

    expect(runs).toEqual([1, 2]);
  });
});

describe('a store that is unreachable', () => {
  it('fails the request rather than running it unguarded', async () => {
    // The opposite of the rate limiter. A claim that cannot be taken means we
    // cannot promise the work happens once, and doing it anyway is how a
    // retry becomes a second charge.
    const broken: IdempotencyPort = {
      async claim() {
        throw new Error('database down');
      },
      async reclaim() {
        return false;
      },
      async complete() {
        return false;
      },
      async release() {
        /* nothing */
      },
    };

    const { app, runs } = buildApp(broken);
    const res = await post(app, 'key-00000001');

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(runs).toEqual([]);
  });
});

describe('the store contract', () => {
  it('completes only a claim that is still in progress', async () => {
    // So the slow handler that lost its claim does not overwrite the answer
    // the retry already gave the caller.
    const { port } = store();
    const scope = workspaceScope(WS);
    const args = { key: 'key-00000001', endpoint: 'POST /things' };

    await port.claim(scope, { ...args, requestHash: canonicalHash({}), now: NOW });

    expect(await port.complete(scope, { ...args, responseCode: 201, responseBody: {} })).toBe(true);
    expect(await port.complete(scope, { ...args, responseCode: 500, responseBody: {} })).toBe(
      false,
    );
  });

  it('is called once per request', async () => {
    const claim = vi.fn(async () => ({ claimed: true, existing: null }));
    const { port } = store();
    const { app } = buildApp({ ...port, claim });

    await post(app, 'key-00000001');

    expect(claim).toHaveBeenCalledTimes(1);
  });
});
