import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '@relayd/types';
import type { AuditQueryRepository, AuditQueryRow, WorkspaceScope } from '@relayd/db';
import type { AuditLogUnitOfWork } from '../src/services/audit-log.js';
import { listAuditLogsQuerySchema, exportAuditLogsQuerySchema } from '@relayd/validation';
import {
  AuditLogService,
  detailsFor,
  initialsFor,
  type AuditLogRepositories,
} from '../src/services/audit-log.js';

/**
 * Reading the audit log (J6).
 *
 * The service's whole job is translation, and each of the three translations
 * is a place the page can end up lying:
 *
 *   A **range** becomes a lower bound on `occurred_at`. Get it wrong and J6's
 *   "Last 7 days" quietly shows ninety.
 *
 *   An **actor** becomes either an id predicate or a type predicate. Rows
 *   Relayd wrote carry no `actor_id`, so filtering "Relayd" by id matches
 *   nothing and the page renders empty with no explanation.
 *
 *   A **payload** becomes one line of prose. The Details column is the only
 *   part of the row a person actually reads, and a summary that drops the old
 *   value turns "suspended someone" into "set a status".
 */

const WORKSPACE = 'ws-1' as WorkspaceId;
const SCOPE = { workspaceId: WORKSPACE } as unknown as WorkspaceScope;
const NOW = new Date('2026-09-20T12:00:00.000Z');

type Captured = Parameters<AuditQueryRepository['list']>[1];

function row(over: Partial<AuditQueryRow> = {}): AuditQueryRow {
  return {
    id: 'a1',
    occurredAt: new Date('2026-09-19T09:30:00.000Z'),
    actorType: 'user',
    actorId: 'u1',
    actorName: 'Dana Haddad',
    action: 'campaign.launched',
    resourceType: 'campaign',
    resourceId: 'c1',
    before: null,
    after: { recipientCount: 42 },
    ...over,
  };
}

function service(
  over: {
    rows?: AuditQueryRow[];
    total?: number;
    actors?: { actorType: AuditQueryRow['actorType']; actorId: string | null; actorName: string | null }[];
    actions?: string[];
    resourceTypes?: string[];
    maxExportRows?: number;
  } = {},
) {
  const calls: { query: Captured; paging: Parameters<AuditQueryRepository['list']>[2] }[] = [];
  const scopes: WorkspaceScope[] = [];

  // Annotated rather than cast, so the fake's parameters and returns are
  // checked against the real repository. A bare `as unknown as` gives every
  // parameter `any`, which is how a fake drifts without a test noticing.
  const auditQuery: Pick<AuditQueryRepository, 'list' | 'count' | 'filterOptions' | 'stream'> = {
    async list(scope, query, paging) {
      scopes.push(scope);
      calls.push({ query, paging });
      return { rows: over.rows ?? [row()] };
    },
    async count(scope) {
      scopes.push(scope);
      return over.total ?? 1;
    },
    async filterOptions(scope) {
      scopes.push(scope);
      return {
        actions: over.actions ?? ['campaign.launched', 'contact.created'],
        resourceTypes: over.resourceTypes ?? ['campaign', 'contact'],
        actors: over.actors ?? [],
      };
    },
    async *stream(scope, query) {
      scopes.push(scope);
      calls.push({ query, paging: { limit: 0 } });
      for (const item of over.rows ?? [row()]) yield item;
    },
  };

  const unitOfWork = vi.fn(async <T,>(fn: (repos: AuditLogRepositories) => Promise<T>) =>
    fn({ auditQuery } as unknown as AuditLogRepositories),
  );

  return {
    calls,
    scopes,
    unitOfWork,
    service: new AuditLogService({
      // vi.fn() erases the call signature's generic; the mock is still what
      // records the calls, it just cannot express <T> on its own.
      unitOfWork: unitOfWork as unknown as AuditLogUnitOfWork,
      now: () => NOW,
      ...(over.maxExportRows === undefined ? {} : { maxExportRows: over.maxExportRows }),
    }),
  };
}

const parse = (input: Record<string, unknown>) => listAuditLogsQuerySchema.parse(input);

describe('the range becomes a lower bound on occurred_at', () => {
  it.each([
    ['last_7', 7],
    ['last_30', 30],
    ['last_90', 90],
  ])('%s looks back %i days', async (range, days) => {
    const { service: subject, calls } = service();

    await subject.list(SCOPE, parse({ range }));

    expect(calls[0]?.query.since).toEqual(new Date(NOW.getTime() - days * 86_400_000));
  });

  it('all has no lower bound at all', async () => {
    const { service: subject, calls } = service();

    await subject.list(SCOPE, parse({ range: 'all' }));

    expect(calls[0]?.query.since).toBeUndefined();
  });

  it('defaults to thirty days when the page asks for nothing', async () => {
    const { service: subject, calls } = service();

    await subject.list(SCOPE, parse({}));

    expect(calls[0]?.query.since).toEqual(new Date(NOW.getTime() - 30 * 86_400_000));
  });
});

describe('the workspace reaches every repository call', () => {
  it('passes the scope to the page, the count and the options', async () => {
    const { service: subject, scopes } = service();

    await subject.list(SCOPE, parse({}));
    await subject.filterOptions(SCOPE);

    expect(scopes).toHaveLength(3);
    for (const scope of scopes) expect(scope).toBe(SCOPE);
  });
});

describe('the actor filter', () => {
  it('filters a person by id', async () => {
    const { service: subject, calls } = service();

    await subject.list(SCOPE, parse({ actor: '0192f0a0-0000-7000-8000-000000000001' }));

    expect(calls[0]?.query.actorId).toBe('0192f0a0-0000-7000-8000-000000000001');
    expect(calls[0]?.query.systemActor).toBeUndefined();
  });

  it('filters Relayd by actor type, because those rows carry no id', async () => {
    const { service: subject, calls } = service();

    await subject.list(SCOPE, parse({ actor: 'system' }));

    expect(calls[0]?.query.systemActor).toBe(true);
    expect(calls[0]?.query.actorId).toBeUndefined();
  });

  it('refuses an actor that is neither a uuid nor the system literal', () => {
    expect(listAuditLogsQuerySchema.safeParse({ actor: 'dana' }).success).toBe(false);
  });
});

describe('paging', () => {
  it('turns page 4 of 10 into an offset of 30', async () => {
    const { service: subject, calls } = service();

    await subject.list(SCOPE, parse({ page: '4', limit: '10' }));

    expect(calls[0]?.paging.offset).toBe(30);
    expect(calls[0]?.paging.limit).toBe(10);
  });

  it('sends no offset for the first page', async () => {
    const { service: subject, calls } = service();

    await subject.list(SCOPE, parse({ page: '1', limit: '10' }));

    expect(calls[0]?.paging.offset).toBeUndefined();
  });

  it('returns the total the page footer needs', async () => {
    const { service: subject } = service({ total: 3412 });

    expect((await subject.list(SCOPE, parse({}))).total).toBe(3412);
  });

  it('refuses a page and a cursor together rather than picking one', () => {
    const cursor = Buffer.from(
      JSON.stringify({ occurredAt: NOW.toISOString(), id: 'a1' }),
      'utf8',
    ).toString('base64url');

    expect(listAuditLogsQuerySchema.safeParse({ page: '2', cursor }).success).toBe(false);
  });

  it('refuses a cursor it cannot read, rather than starting from the top', () => {
    // Silently restarting re-serves rows the caller has already read, which in
    // an audit log reads as the same event happening twice.
    expect(listAuditLogsQuerySchema.safeParse({ cursor: 'zzzz' }).success).toBe(false);
  });

  it('accepts a well-formed cursor', () => {
    const cursor = Buffer.from(
      JSON.stringify({ occurredAt: NOW.toISOString(), id: 'a1' }),
      'utf8',
    ).toString('base64url');

    expect(listAuditLogsQuerySchema.safeParse({ cursor }).success).toBe(true);
  });

  it('caps how deep the offset form may go', () => {
    expect(listAuditLogsQuerySchema.safeParse({ page: '1000' }).success).toBe(true);
    expect(listAuditLogsQuerySchema.safeParse({ page: '1001' }).success).toBe(false);
  });
});

describe('the row as J6 draws it', () => {
  it('names a person, and gives the avatar the same initials', async () => {
    const { service: subject } = service();

    const [event] = (await subject.list(SCOPE, parse({}))).events;

    expect(event?.actor).toEqual({ kind: 'user', name: 'Dana Haddad', initials: 'DH' });
  });

  it('keeps the row when the person is gone', async () => {
    const { service: subject } = service({ rows: [row({ actorName: null })] });

    // An audit log that forgets who did something the moment they leave is
    // not an audit log.
    expect((await subject.list(SCOPE, parse({}))).events[0]?.actor.name).toBe('Removed user');
  });

  it('names an API key as a key, not as whoever minted it', async () => {
    const { service: subject } = service({
      rows: [row({ actorType: 'api_key', actorName: 'Deploy key' })],
    });

    const [event] = (await subject.list(SCOPE, parse({}))).events;

    expect(event?.actor.kind).toBe('api_key');
    expect(event?.actor.name).toBe('Deploy key');
  });

  it('draws system and provider rows as Relayd-side actors', async () => {
    const { service: subject } = service({
      rows: [
        row({ actorType: 'system', actorId: null, actorName: null }),
        row({ id: 'a2', actorType: 'provider', actorId: null, actorName: null }),
      ],
    });

    const { events } = await subject.list(SCOPE, parse({}));

    expect(events.map((event) => event.actor.kind)).toEqual(['system', 'system']);
    expect(events.map((event) => event.actor.name)).toEqual(['Relayd', 'Provider']);
  });

  it('has a null resource for a workspace-wide event', async () => {
    const { service: subject } = service({ rows: [row({ resourceId: null })] });

    expect((await subject.list(SCOPE, parse({}))).events[0]?.resource).toBeNull();
  });

  it('sends the time as an ISO string, so the browser formats it in the workspace zone', async () => {
    const { service: subject } = service();

    expect((await subject.list(SCOPE, parse({}))).events[0]?.occurredAt).toBe(
      '2026-09-19T09:30:00.000Z',
    );
  });
});

describe('initials', () => {
  it.each([
    ['Dana Haddad', 'DH'],
    ['Relayd', 'R'],
    ['jo van der berg', 'JB'],
    ['   ', '?'],
  ])('%s becomes %s', (name, expected) => {
    expect(initialsFor(name)).toBe(expected);
  });
});

describe('the Details column', () => {
  it('shows what changed, old value and new', () => {
    expect(
      detailsFor({
        action: 'workspace.updated',
        before: { name: 'Northwind', timezone: 'UTC' },
        after: { name: 'Northwind Voyages', timezone: 'UTC' },
      }),
    ).toBe('name: Northwind → Northwind Voyages, timezone: UTC');
  });

  it('shows what was set when there was nothing before', () => {
    expect(detailsFor({ action: 'list.created', before: null, after: { name: 'EU leisure' } })).toBe(
      'name: EU leisure',
    );
  });

  it('shows what was removed when a row carries only a before', () => {
    expect(detailsFor({ action: 'member.removed', before: { role: 'editor' }, after: null })).toBe(
      'role: editor',
    );
  });

  it('falls back to a readable sentence when the row carries no payload', () => {
    expect(detailsFor({ action: 'campaign.launched', before: null, after: null })).toBe(
      'Campaign launched',
    );
    expect(detailsFor({ action: 'member.role_changed', before: null, after: null })).toBe(
      'Member role changed',
    );
  });

  it('renders an array of scopes rather than [object Object]', () => {
    expect(
      detailsFor({
        action: 'apikey.created',
        before: null,
        after: { scopes: ['contact:read', 'contact:write'] },
      }),
    ).toBe('scopes: contact:read, contact:write');
  });

  it('truncates a value long enough to blow out the column', () => {
    const details = detailsFor({
      action: 'template.saved',
      before: null,
      after: { name: 'x'.repeat(400) },
    });

    expect(details.length).toBeLessThanOrEqual(240);
    expect(details).toContain('…');
  });
});

describe('the export', () => {
  it('writes one record per row, with the raw payloads the screen has no room for', async () => {
    const { service: subject } = service({ rows: [row(), row({ id: 'a2' })] });
    const written: unknown[] = [];

    const result = await subject.exportRecords(
      SCOPE,
      exportAuditLogsQuerySchema.parse({}),
      (record) => {
        written.push(record);
      },
    );

    expect(result).toEqual({ rows: 2, truncated: false });
    expect(written[0]).toMatchObject({
      actor: 'Dana Haddad',
      action: 'campaign.launched',
      resourceType: 'campaign',
      after: '{"recipientCount":42}',
    });
  });

  it('stops at the cap and says that it did', async () => {
    const { service: subject } = service({
      rows: [row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })],
      maxExportRows: 2,
    });
    const written: unknown[] = [];

    const result = await subject.exportRecords(
      SCOPE,
      exportAuditLogsQuerySchema.parse({}),
      (record) => {
        written.push(record);
      },
    );

    // A truncated export that does not say so is worse than no export.
    expect(result).toEqual({ rows: 2, truncated: true });
    expect(written).toHaveLength(2);
  });

  it('carries the filters into the stream, not just into the list', async () => {
    const { service: subject, calls } = service();

    await subject.exportRecords(
      SCOPE,
      exportAuditLogsQuerySchema.parse({ range: 'last_7', action: 'campaign.launched' }),
      () => undefined,
    );

    expect(calls[0]?.query.action).toBe('campaign.launched');
    expect(calls[0]?.query.since).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
  });
});

describe('the filter pickers', () => {
  it('offers people and keys by id, and Relayd last', async () => {
    const { service: subject } = service({
      actors: [
        { actorType: 'system', actorId: null, actorName: null },
        { actorType: 'user', actorId: 'u2', actorName: 'Zoe Adeyemi' },
        { actorType: 'user', actorId: 'u1', actorName: 'Dana Haddad' },
        { actorType: 'api_key', actorId: 'k1', actorName: 'Deploy key' },
      ],
    });

    const options = await subject.filterOptions(SCOPE);

    expect(options.actors).toEqual([
      { id: 'u1', name: 'Dana Haddad' },
      { id: 'k1', name: 'Deploy key' },
      { id: 'u2', name: 'Zoe Adeyemi' },
      { id: 'system', name: 'Relayd' },
    ]);
  });

  it('leaves Relayd out when the workspace has no system rows', async () => {
    const { service: subject } = service({
      actors: [{ actorType: 'user', actorId: 'u1', actorName: 'Dana Haddad' }],
    });

    expect((await subject.filterOptions(SCOPE)).actors).toEqual([
      { id: 'u1', name: 'Dana Haddad' },
    ]);
  });

  it('de-duplicates by id, since two people can share a name', async () => {
    const { service: subject } = service({
      actors: [
        { actorType: 'user', actorId: 'u1', actorName: 'Dana Haddad' },
        { actorType: 'user', actorId: 'u1', actorName: 'Dana Haddad' },
      ],
    });

    expect((await subject.filterOptions(SCOPE)).actors).toHaveLength(1);
  });

  it('passes the actions and resource types through', async () => {
    const { service: subject } = service();

    const options = await subject.filterOptions(SCOPE);

    expect(options.actions).toEqual(['campaign.launched', 'contact.created']);
    expect(options.resourceTypes).toEqual(['campaign', 'contact']);
  });
});
