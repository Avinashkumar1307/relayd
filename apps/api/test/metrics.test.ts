// @vitest-environment node
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, resetMetrics } from '@relayd/logger';
import type { DatabasePool } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import { createApp } from '../src/app.js';
import { UNMATCHED_ROUTE, routeLabel, statusClass } from '../src/middleware/metrics.js';
import type { Request } from 'express';

/**
 * The Prometheus endpoint and the HTTP metrics middleware (BUILD-PLAN
 * Phase 10).
 *
 * The thing that actually goes wrong with HTTP metrics is not that they are
 * missing — it is cardinality. A `route` label built from `req.path` looks
 * correct in every test anybody writes, works in development, and then mints
 * one time series per campaign id in production until the process runs out
 * of memory. So most of this file is about the label.
 */

const silentLogger = () =>
  createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } });

function deps() {
  return {
    pool: { query: vi.fn(async () => ({ rows: [] })) } as unknown as DatabasePool,
    redis: { ping: vi.fn(async () => 'PONG') } as unknown as RedisConnection,
    logger: silentLogger(),
  };
}

beforeEach(() => {
  // Counters are process-lifetime values; without this, a test asserting on
  // one would depend on which tests ran before it in the same worker.
  resetMetrics();
});

describe('GET /metrics', () => {
  it('renders the Prometheus exposition format', async () => {
    const response = await request(createApp(deps())).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('# HELP');
    expect(response.text).toContain('# TYPE');
  });

  it('is not cached', async () => {
    // A cache anywhere between a scraper and this process would flatten
    // every series into a constant, which reads as a system that stopped
    // changing rather than as a caching bug.
    const response = await request(createApp(deps())).get('/metrics');

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('exposes the series the middleware records', async () => {
    const app = createApp(deps());

    await request(app).get('/health');
    const response = await request(app).get('/metrics');

    expect(response.text).toContain('relayd_http_requests_total');
    expect(response.text).toContain('relayd_http_request_duration_seconds');
  });

  it('labels the process', async () => {
    const app = createApp(deps());

    await request(app).get('/health');
    const response = await request(app).get('/metrics');

    expect(response.text).toMatch(/process="api"/u);
  });
});

describe('the route label cannot be unbounded', () => {
  it('uses the route pattern, not the path', () => {
    // The whole point. `/api/v1/campaigns/:campaignId` is one series;
    // `/api/v1/campaigns/0192f4...` is one series per campaign.
    const label = routeLabel({
      baseUrl: '/api/v1',
      route: { path: '/campaigns/:campaignId' },
    } as unknown as Request);

    expect(label).toBe('/api/v1/campaigns/:campaignId');
  });

  it('collapses unmatched requests to a single label', () => {
    // A scanner walking random URLs is exactly the traffic that would
    // otherwise mint the most series, and it is unauthenticated, so it is
    // also the traffic an attacker controls for free.
    const label = routeLabel({ baseUrl: '', path: '/wp-admin/x.php' } as unknown as Request);

    expect(label).toBe(UNMATCHED_ROUTE);
  });

  it('keeps the mount path, so two routers do not share a series', () => {
    const one = routeLabel({ baseUrl: '/api/v1/auth', route: { path: '/' } } as unknown as Request);
    const two = routeLabel({
      baseUrl: '/api/v1/workspaces',
      route: { path: '/' },
    } as unknown as Request);

    expect(one).not.toBe(two);
  });

  it('records a bounded number of series for an unbounded number of paths', async () => {
    // The property, end to end, rather than by inspecting the label
    // function. Ten distinct 404 paths must produce one series.
    const app = createApp(deps());

    for (let index = 0; index < 10; index += 1) {
      await request(app).get(`/nope/${index}`);
    }

    const response = await request(app).get('/metrics');
    const unmatched = response.text
      .split('\n')
      .filter((line) => line.startsWith('relayd_http_requests_total{'));

    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toContain(`route="${UNMATCHED_ROUTE}"`);
    expect(unmatched[0]).toMatch(/\s10$/u);
  });
});

describe('a request that never finishes is still counted', () => {
  it('records on close when finish never fires', async () => {
    // A client that hangs up mid-response — a mail client that gave up on
    // the pixel, a load balancer that timed out — emits `close` and never
    // `finish`. Counting only `finish` makes an endpoint that times out look
    // like an endpoint nobody calls, which is the opposite of the truth and
    // hides it from the p99 alarm.
    //
    // Driven directly rather than through supertest, because supertest
    // completes every response it makes.
    const { metrics: middleware } = await import('../src/middleware/metrics.js');

    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 200;

    const request = { method: 'GET', baseUrl: '', route: { path: '/o/:token.gif' } };

    await new Promise<void>((resolve) => {
      middleware('api')(request as never, response as never, () => resolve());
    });

    response.emit('close');

    const { registry } = await import('@relayd/logger');
    const text = await registry.metrics();

    expect(text).toMatch(/relayd_http_requests_total\{[^}]*route="\/o\/:token\.gif"[^}]*\}\s1/u);
  });

  it('counts a request once, not twice', async () => {
    // Both events fire on an ordinary response — `finish` then `close` — so
    // a naive two-listener version double-counts every single request and
    // every rate in the system reads twice its real value.
    const { metrics: middleware } = await import('../src/middleware/metrics.js');

    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 200;

    const request = { method: 'GET', baseUrl: '', route: { path: '/health' } };

    await new Promise<void>((resolve) => {
      middleware('api')(request as never, response as never, () => resolve());
    });

    response.emit('finish');
    response.emit('close');

    const { registry } = await import('@relayd/logger');
    const text = await registry.metrics();

    expect(text).toMatch(/relayd_http_requests_total\{[^}]*route="\/health"[^}]*\}\s1/u);
  });
});

describe('the status label is a class, not a code', () => {
  it('buckets by class', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(301)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(500)).toBe('5xx');
    expect(statusClass(503)).toBe('5xx');
  });

  it('puts the boundaries where docs/10 alarms are phrased', () => {
    // "5xx rate > 1% for 5 min" is a ratio over exactly this bucketing, so
    // 499 and 500 must fall either side.
    expect(statusClass(499)).toBe('4xx');
    expect(statusClass(500)).toBe('5xx');
  });
});
