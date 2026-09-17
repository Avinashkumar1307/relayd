import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { AppError, NotFoundError } from '@relayd/types';
import { createLogger } from '@relayd/logger';
import type { DatabasePool } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import { createApp } from '../src/app.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';

const silentLogger = () =>
  createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } });

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
      logger: silentLogger(),
    },
  };
}

describe('GET /health', () => {
  it('returns 200', async () => {
    const { deps: d } = deps();
    const res = await request(createApp(d)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' } });
  });

  it('never touches a dependency', async () => {
    // docs/10: if /health checked Postgres and Postgres hiccuped, the load
    // balancer would drain every task at once.
    const { query, ping, deps: d } = deps();
    await request(createApp(d)).get('/health');
    expect(query).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it('stays 200 when both dependencies are down', async () => {
    const { deps: d } = deps({ pgFails: true, redisFails: true });
    const res = await request(createApp(d)).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('GET /ready', () => {
  it('returns 200 when Postgres and Redis both answer', async () => {
    const { query, ping, deps: d } = deps();
    const res = await request(createApp(d)).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ready', postgres: true, redis: true });
    expect(query).toHaveBeenCalled();
    expect(ping).toHaveBeenCalled();
  });

  it('returns 503 and names the failure when Postgres is down', async () => {
    const { deps: d } = deps({ pgFails: true });
    const res = await request(createApp(d)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.data).toMatchObject({ status: 'not_ready', postgres: false, redis: true });
  });

  it('returns 503 when Redis is down', async () => {
    const { deps: d } = deps({ redisFails: true });
    const res = await request(createApp(d)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.data).toMatchObject({ postgres: true, redis: false });
  });
});

describe('request id', () => {
  it('generates one and echoes it', async () => {
    const { deps: d } = deps();
    const res = await request(createApp(d)).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('honours an inbound request id so callers can correlate', async () => {
    const { deps: d } = deps();
    const res = await request(createApp(d)).get('/health').set('x-request-id', 'req_from_caller');
    expect(res.headers['x-request-id']).toBe('req_from_caller');
  });
});

describe('error envelope', () => {
  const appThatThrows = (error: unknown) => {
    const app = express();
    app.use(requestId);
    app.get('/boom', () => {
      throw error;
    });
    app.use(errorEnvelope(silentLogger()));
    return app;
  };

  it('maps an AppError to its status, code and requestId', async () => {
    const res = await request(appThatThrows(new NotFoundError('Campaign not found'))).get('/boom');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'not_found',
      message: 'Campaign not found',
      docsUrl: 'https://docs.relayd.io/errors/not_found',
    });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('carries details when the error has them', async () => {
    const error = new AppError('validation_failed', 'Request validation failed', 400, [
      { path: 'audience.listIds', message: 'At least one list is required' },
    ]);
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { path: 'audience.listIds', message: 'At least one list is required' },
    ]);
  });

  it('turns an unexpected error into a 500 that leaks nothing', async () => {
    const leaky = new Error('connection to postgres://relayd:s3cr3t@db failed');
    const res = await request(appThatThrows(leaky)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('s3cr3t');
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('forwards a rejected promise from an async handler without asyncHandler', async () => {
    // Express 5 does this natively, which is why no asyncHandler wrapper exists.
    const app = express();
    app.use(requestId);
    app.get('/boom', async () => {
      await Promise.resolve();
      throw new NotFoundError('gone');
    });
    app.use(errorEnvelope(silentLogger()));
    const res = await request(app).get('/boom');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('unmatched routes', () => {
  it('return 404 in the same envelope', async () => {
    const { deps: d } = deps();
    const res = await request(createApp(d)).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});
