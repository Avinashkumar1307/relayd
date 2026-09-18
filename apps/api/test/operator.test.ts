import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { operatorRoutes, type OperatorRouterOptions } from '../src/routes/operator.js';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';

/**
 * The operator console.
 *
 * Every route here reads across tenants, so the only thing that matters more
 * than what it shows is who it shows it to.
 */

const LOGGER = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
const AUTH = { authorization: 'Bearer token' };

function build(overrides: Partial<OperatorRouterOptions> = {}) {
  const rows = [
    {
      id: 'dl-1',
      queue: 'email-send',
      jobId: 'send:r1',
      workspaceId: 'ws-1',
      payload: { recipientId: 'r1' },
      error: { name: 'Error', message: 'boom' },
      attempts: 5,
      status: 'new' as const,
      replayedAt: null,
      notes: null,
      failedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];

  const enqueued: { queue: string; jobId: string }[] = [];
  const statusCalls: { id: string; status: string }[] = [];
  let claims = 0;

  const options: OperatorRouterOptions = {
    tokens: {
      verifyAccessToken: () => ({ userId: 'user-1', sessionId: 's1', workspaceIds: [] }),
    } as never,

    deadLetters: {
      async list() {
        return rows;
      },
      async summary() {
        return [{ queue: 'email-send', status: 'new', count: 1 }];
      },
      async findById(id: string) {
        return rows.find((row) => row.id === id) ?? null;
      },
      async claimForReplay() {
        // The guarded update: the first caller wins, later ones do not.
        claims += 1;
        return claims === 1;
      },
      async setStatus(id: string, status: string) {
        statusCalls.push({ id, status });
        return true;
      },
    } as never,

    schedules: {
      async list() {
        return [
          {
            name: 'hourly-rollup',
            cron: '0 * * * *',
            queue: 'analytics-rollup',
            payload: {},
            enabled: true,
            lastRunAt: null,
            nextRunAt: new Date('2026-01-01T11:00:00.000Z'),
            lastError: null,
            consecutiveFailures: 0,
          },
        ];
      },
      async setEnabled() {
        return true;
      },
      async runNow() {
        return true;
      },
    } as never,

    queues: {
      async depth(queue) {
        if (queue === 'billing-webhook') throw new Error('redis is down');
        return { waiting: 1, active: 2, delayed: 3, failed: 4 };
      },
    },

    replayTarget: {
      async enqueue(input) {
        enqueued.push({ queue: input.queue, jobId: input.jobId });
      },
    },

    ...overrides,
  };

  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use('/api/v1', operatorRoutes(options));
  app.use(errorEnvelope(LOGGER));

  return { app, enqueued, statusCalls };
}

const READ_PATHS = [
  '/api/v1/operator/queues',
  '/api/v1/operator/dead-letters',
  '/api/v1/operator/dead-letters/summary',
  '/api/v1/operator/dead-letters/dl-1',
  '/api/v1/operator/schedules',
];

const WRITE_PATHS = [
  '/api/v1/operator/dead-letters/dl-1/replay',
  '/api/v1/operator/dead-letters/dl-1/status',
  '/api/v1/operator/schedules/hourly-rollup/run',
  '/api/v1/operator/schedules/hourly-rollup/enable',
];

describe('the operator gate', () => {
  it('denies everyone by default', async () => {
    // An operator console open by default is a cross-tenant read for every
    // user who finds the URL.
    const { app } = build();

    expect((await request(app).get('/api/v1/operator/queues').set(AUTH)).status).toBe(404);
  });

  it('answers 404 rather than 403, so probing tells nobody it exists', async () => {
    const { app } = build({ isOperator: () => false });

    const response = await request(app).get('/api/v1/operator/dead-letters').set(AUTH);

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toMatch(/operator|forbidden/iu);
  });

  it('gates every read route', async () => {
    const { app } = build();

    for (const path of READ_PATHS) {
      expect((await request(app).get(path).set(AUTH)).status, path).toBe(404);
    }
  });

  it('gates every write route', async () => {
    const { app } = build();

    for (const path of WRITE_PATHS) {
      const response = await request(app).post(path).set(AUTH).send({ status: 'discarded' });
      expect(response.status, path).toBe(404);
    }
  });

  it('changes nothing while denied', async () => {
    const { app, enqueued } = build();

    await request(app).post('/api/v1/operator/dead-letters/dl-1/replay').set(AUTH).send({});
    expect(enqueued).toEqual([]);
  });

  it('lets a configured operator through', async () => {
    const { app } = build({ isOperator: () => true });

    expect((await request(app).get('/api/v1/operator/queues').set(AUTH)).status).toBe(200);
  });

  it('accepts an async check', async () => {
    const { app } = build({ isOperator: async () => true });

    expect((await request(app).get('/api/v1/operator/schedules').set(AUTH)).status).toBe(200);
  });
});

describe('queue depths', () => {
  it('reports every declared queue', async () => {
    const { app } = build({ isOperator: () => true });

    const response = await request(app).get('/api/v1/operator/queues').set(AUTH);
    const body = response.body as { data: { queue: string }[] };

    expect(body.data.length).toBeGreaterThanOrEqual(14);
    expect(body.data.map((row) => row.queue)).toContain('email-send');
  });

  it('keeps going when one queue cannot be read', async () => {
    // Failing the whole page for one of fourteen helps nobody, and a queue
    // whose depth cannot be read is itself worth seeing.
    const { app } = build({ isOperator: () => true });

    const response = await request(app).get('/api/v1/operator/queues').set(AUTH);
    const body = response.body as { data: { queue: string; waiting: number }[] };

    expect(response.status).toBe(200);
    expect(body.data.find((row) => row.queue === 'billing-webhook')?.waiting).toBe(-1);
    expect(body.data.find((row) => row.queue === 'email-send')?.waiting).toBe(1);
  });
});

describe('dead letters', () => {
  it('lists them', async () => {
    const { app } = build({ isOperator: () => true });

    const response = await request(app).get('/api/v1/operator/dead-letters').set(AUTH);
    const body = response.body as { data: { jobId: string }[] };

    expect(body.data[0]?.jobId).toBe('send:r1');
  });

  it('summarises by queue and status', async () => {
    const { app } = build({ isOperator: () => true });

    const response = await request(app).get('/api/v1/operator/dead-letters/summary').set(AUTH);
    expect(response.body).toEqual({ data: [{ queue: 'email-send', status: 'new', count: 1 }] });
  });

  it('404s for one that does not exist', async () => {
    const { app } = build({ isOperator: () => true });

    expect((await request(app).get('/api/v1/operator/dead-letters/nope').set(AUTH)).status).toBe(404);
  });
});

describe('replay', () => {
  it('re-enqueues with the original job id', async () => {
    // Which is what makes replaying an already-succeeded job a no-op.
    const { app, enqueued } = build({ isOperator: () => true });

    const response = await request(app)
      .post('/api/v1/operator/dead-letters/dl-1/replay')
      .set(AUTH)
      .send({});

    expect(response.status).toBe(200);
    expect(enqueued).toEqual([{ queue: 'email-send', jobId: 'send:r1' }]);
  });

  it('replays exactly once when two operators press the button', async () => {
    // The guarded claim lets one through; the loser gets a 409 rather than a
    // second enqueue.
    const { app, enqueued } = build({ isOperator: () => true });

    const first = await request(app)
      .post('/api/v1/operator/dead-letters/dl-1/replay')
      .set(AUTH)
      .send({});
    const second = await request(app)
      .post('/api/v1/operator/dead-letters/dl-1/replay')
      .set(AUTH)
      .send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(enqueued).toHaveLength(1);
  });
});

describe('marking a row', () => {
  it('accepts investigating and discarded', async () => {
    const { app, statusCalls } = build({ isOperator: () => true });

    for (const status of ['investigating', 'discarded']) {
      const response = await request(app)
        .post('/api/v1/operator/dead-letters/dl-1/status')
        .set(AUTH)
        .send({ status });

      expect(response.status, status).toBe(204);
    }

    expect(statusCalls.map((call) => call.status)).toEqual(['investigating', 'discarded']);
  });

  it('refuses to set replayed by hand', async () => {
    // Replaying is done by replaying, so a row cannot claim to have run
    // without having run.
    const { app, statusCalls } = build({ isOperator: () => true });

    const response = await request(app)
      .post('/api/v1/operator/dead-letters/dl-1/status')
      .set(AUTH)
      .send({ status: 'replayed' });

    expect(response.status).toBe(422);
    expect(statusCalls).toEqual([]);
  });

  it('refuses an unknown status', async () => {
    const { app } = build({ isOperator: () => true });

    const response = await request(app)
      .post('/api/v1/operator/dead-letters/dl-1/status')
      .set(AUTH)
      .send({ status: 'whatever' });

    expect(response.status).toBe(422);
  });
});

describe('schedules', () => {
  it('lists them with their next run and failure count', async () => {
    const { app } = build({ isOperator: () => true });

    const response = await request(app).get('/api/v1/operator/schedules').set(AUTH);
    const body = response.body as { data: { name: string; consecutiveFailures: number }[] };

    expect(body.data[0]?.name).toBe('hourly-rollup');
    expect(body.data[0]?.consecutiveFailures).toBe(0);
  });

  it('runs one now by making it due, not by enqueueing', async () => {
    // So the run still goes through the leader-elected tick and cannot
    // produce a second copy alongside a scheduled one.
    const { app, enqueued } = build({ isOperator: () => true });

    const response = await request(app)
      .post('/api/v1/operator/schedules/hourly-rollup/run')
      .set(AUTH)
      .send({});

    expect(response.status).toBe(200);
    expect(enqueued).toEqual([]);
  });

  it('turns one off without deleting it', async () => {
    const { app } = build({ isOperator: () => true });

    const response = await request(app)
      .post('/api/v1/operator/schedules/hourly-rollup/enable')
      .set(AUTH)
      .send({ enabled: false });

    expect(response.status).toBe(204);
  });
});
