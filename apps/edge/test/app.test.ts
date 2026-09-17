import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { DatabasePool } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import { createApp } from '../src/app.js';

function deps(over: { pgFails?: boolean; redisFails?: boolean } = {}) {
  const query = vi.fn(async () =>
    over.pgFails === true ? Promise.reject(new Error('pg down')) : { rows: [] },
  );
  const ping = vi.fn(async () =>
    over.redisFails === true ? Promise.reject(new Error('redis down')) : 'PONG',
  );
  return {
    query,
    ping,
    deps: {
      pool: { query } as unknown as DatabasePool,
      redis: { ping } as unknown as RedisConnection,
      logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    },
  };
}

describe('edge health probes', () => {
  it('serves /health without touching a dependency', async () => {
    const { query, ping, deps: d } = deps();
    const res = await request(createApp(d)).get('/health');
    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it('serves /ready when both dependencies answer', async () => {
    const { deps: d } = deps();
    const res = await request(createApp(d)).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ready' });
  });

  it('returns 503 when Redis is down', async () => {
    const { deps: d } = deps({ redisFails: true });
    const res = await request(createApp(d)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.data).toMatchObject({ postgres: true, redis: false });
  });

  it('returns the shared error envelope for unmatched routes', async () => {
    const { deps: d } = deps();
    const res = await request(createApp(d)).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});
