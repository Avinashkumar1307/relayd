import { generateKeyPairSync } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { GlobalMembershipRepository } from '@relayd/db';
import type {
  ContactId,
  ContactListId,
  ImportJobId,
  SegmentId,
  SuppressionId,
  TagId,
  UserId,
  WorkspaceId,
} from '@relayd/types';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import { audienceRoutes } from '../src/routes/audience.js';
import { AudienceService, type AudienceRepositories } from '../src/services/audience.js';
import { TokenService } from '../src/services/tokens.js';

/**
 * The audience contract: what `apps/web/src/api/*.ts` says each endpoint
 * returns, asserted against what the router actually sends.
 *
 * ## Why this file exists
 *
 * `apiRequest` in the browser unwraps the envelope and hands `data` straight
 * to the caller as the type the call site declared. Nothing checks that
 * claim at runtime. So when the server sends a contact without `tags`, the
 * page does not error — `row.tags.map(...)` throws inside a render, or a
 * column quietly prints `undefined`, and both survive review because every
 * web test mocks fetch and every API test asserts the API's own shape.
 *
 * This suite is the join between the two. It boots the real router over
 * in-memory repositories and asserts, per endpoint, that the body has the
 * keys the browser's interface declares and that each one has the declared
 * type — including the difference between `null` and absent, which is the
 * difference between a rendered dash and a crash.
 *
 * ## What it deliberately does not do
 *
 * It does not assert business behaviour. Whether archiving twice is a 409,
 * whether a saved view resolves to the right filter, whether a merge moves
 * the right rows — those are `audience.test.ts` and
 * `audience-extra.test.ts`. A failure here means the wire shape moved, and
 * that is the only thing it should ever mean.
 *
 * The one shape it checks hardest is `GET /contacts`'s envelope. The list
 * endpoints answer `{ data, meta }` and `getPage` in
 * `apps/web/src/api/audience.ts` reads `meta.nextCursor` and nothing else,
 * so a cursor moved into `data` or renamed in `meta` is a page that silently
 * stops at fifty rows.
 */

/* ------------------------------------------------------------------ */
/* Shape assertions                                                    */
/* ------------------------------------------------------------------ */

type Check = 'string' | 'number' | 'boolean' | 'object' | 'string|null' | 'number|null' | 'array';

/**
 * Asserts a value has exactly these keys' types, and that each key is
 * *present*.
 *
 * Presence matters on its own: `undefined` and `null` are the same thing to
 * `JSON.stringify`, so a field the service forgot arrives as an absent key
 * and a `string | null` field the browser renders becomes a crash rather
 * than a dash.
 */
function expectShape(value: unknown, shape: Record<string, Check>, where: string): void {
  expect(value, where).toBeTypeOf('object');
  expect(value, where).not.toBeNull();
  const row = value as Record<string, unknown>;

  for (const [key, check] of Object.entries(shape)) {
    expect(Object.hasOwn(row, key), `${where}.${key} is missing`).toBe(true);
    const actual = row[key];

    switch (check) {
      case 'array':
        expect(Array.isArray(actual), `${where}.${key} should be an array`).toBe(true);
        break;
      case 'object':
        expect(typeof actual, `${where}.${key}`).toBe('object');
        expect(actual, `${where}.${key}`).not.toBeNull();
        break;
      case 'string|null':
        expect(
          actual === null || typeof actual === 'string',
          `${where}.${key} should be string | null, got ${JSON.stringify(actual)}`,
        ).toBe(true);
        break;
      case 'number|null':
        expect(
          actual === null || typeof actual === 'number',
          `${where}.${key} should be number | null, got ${JSON.stringify(actual)}`,
        ).toBe(true);
        break;
      default:
        expect(typeof actual, `${where}.${key}`).toBe(check);
    }
  }
}

/** `apps/web/src/api/audience.ts` — `Contact`. */
const CONTACT: Record<string, Check> = {
  id: 'string',
  email: 'string',
  firstName: 'string|null',
  lastName: 'string|null',
  status: 'string',
  attributes: 'object',
  createdAt: 'string',
};

/** `audience-extra.ts` — `ContactRow`, which is `Contact` plus D1's columns. */
const CONTACT_ROW: Record<string, Check> = {
  ...CONTACT,
  tags: 'array',
  lists: 'array',
  lastEngaged: 'string',
};

/** `audience-extra.ts` — `ContactDetail`. */
const CONTACT_DETAIL: Record<string, Check> = {
  ...CONTACT_ROW,
  country: 'string|null',
  language: 'string|null',
  consentSource: 'string|null',
  consentRecorded: 'string|null',
  suppression: 'object',
  events: 'array',
};

/** `audience.ts` — `ContactList`; `audience-extra.ts` — `ListCard`. */
const LIST_CARD: Record<string, Check> = {
  id: 'string',
  name: 'string',
  description: 'string|null',
  memberCount: 'number',
  createdAt: 'string',
  archived: 'boolean',
  footnote: 'string',
  growth30d: 'number|null',
  trend: 'array',
};

/** `audience.ts` — `Tag`; `audience-extra.ts` — `TagRow`. */
const TAG_ROW: Record<string, Check> = {
  id: 'string',
  name: 'string',
  color: 'string|null',
  createdAt: 'string',
  contactCount: 'number',
  segments: 'array',
};

/** `audience-extra.ts` — `SuppressionRow`. */
const SUPPRESSION_ROW: Record<string, Check> = {
  id: 'string',
  email: 'string',
  reason: 'string',
  notes: 'string|null',
  source: 'string|null',
  addedBy: 'string|null',
  createdAt: 'string',
};

/** `segments.ts` — `Segment`. */
const SEGMENT: Record<string, Check> = {
  id: 'string',
  name: 'string',
  cachedCount: 'number|null',
  cachedAt: 'string|null',
  createdAt: 'string',
  updatedAt: 'string',
};

/** `audience.ts` — `ImportJob`. */
const IMPORT_JOB: Record<string, Check> = {
  id: 'string',
  originalFilename: 'string',
  byteSize: 'number',
  fileType: 'string',
  status: 'string',
  totalRows: 'number|null',
  processedRows: 'number',
  createdCount: 'number',
  updatedCount: 'number',
  skippedCount: 'number',
  failedCount: 'number',
  createdAt: 'string',
  completedAt: 'string|null',
};

/**
 * `audience.ts` — `ImportStatus`.
 *
 * The import page polls `GET /imports/:id` and switches on this exact set
 * (`statusLook`, and `ACTIVE` which decides whether to keep polling). A
 * value outside it renders as the default branch — "Completed" — on a job
 * that has not completed, and the poller stops.
 */
const IMPORT_STATUSES = [
  'pending',
  'mapping',
  'validating',
  'processing',
  'completed',
  'failed',
  'cancelled',
];

/* ------------------------------------------------------------------ */
/* The world                                                           */
/* ------------------------------------------------------------------ */

const WS = 'ws-audience' as WorkspaceId;
const USER = 'user-audience' as UserId;
const NOW = new Date('2026-09-20T09:14:00Z');

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

interface FakeContact {
  id: ContactId;
  workspaceId: WorkspaceId;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  source: string;
  consentStatus: string;
  consentSource: string | null;
  consentAt: Date | null;
  lastEngagedAt: Date | null;
  attributes: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory repositories, faithful on shape rather than on SQL.
 *
 * Every method returns rows of the same interface the Drizzle repository
 * declares, because that interface is what the service maps onto the wire —
 * a double that returned a convenient subset would pass this suite while
 * production sent something narrower.
 */
function buildWorld() {
  const contacts: FakeContact[] = [];
  const lists: {
    id: ContactListId;
    name: string;
    description: string | null;
    memberCount: number;
    createdAt: Date;
    archivedAt: Date | null;
  }[] = [];
  const tags: { id: TagId; name: string; color: string | null; createdAt: Date }[] = [];
  const segments: {
    id: SegmentId;
    name: string;
    definition: unknown;
    cachedCount: number | null;
    cachedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }[] = [];
  const suppressions: {
    id: SuppressionId;
    email: string;
    reason: string;
    scope: string;
    notes: string | null;
    sourceCampaignId: string | null;
    createdAt: Date;
  }[] = [];
  const imports: {
    id: ImportJobId;
    originalFilename: string;
    byteSize: number;
    fileType: string;
    status: string;
    columnMapping: Record<string, string> | null;
    totalRows: number | null;
    processedRows: number;
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
    failedCount: number;
    createdAt: Date;
    completedAt: Date | null;
  }[] = [];
  const views: { id: string; key: string; label: string; filters: Record<string, string> }[] = [];
  const exports: { id: string; resource: string; status: string }[] = [];
  const memberships: { contactId: ContactId; listId: ContactListId }[] = [];
  const tagged: { contactId: ContactId; tagId: TagId }[] = [];

  let sequence = 0;
  const newId = (): string => `id-${++sequence}`;
  const copy = <T>(row: T): T => ({ ...row });

  const repos = {
    contacts: {
      async list() {
        return { contacts: contacts.map(copy), nextCursor: 'cursor-page-2' };
      },
      async findById(_s: unknown, id: ContactId) {
        return contacts.find((row) => row.id === id) ?? null;
      },
      async findByEmail(_s: unknown, email: string) {
        return contacts.find((row) => row.email === email) ?? null;
      },
      async upsert(_s: unknown, input: { id: ContactId; email: string; firstName?: string }) {
        const existing = contacts.find((row) => row.email === input.email);
        if (existing !== undefined) return { contact: copy(existing), created: false };
        const row: FakeContact = {
          id: input.id,
          workspaceId: WS,
          email: input.email,
          firstName: input.firstName ?? null,
          lastName: null,
          status: 'subscribed',
          source: 'api',
          consentStatus: 'unknown',
          consentSource: null,
          consentAt: null,
          lastEngagedAt: null,
          attributes: {},
          createdAt: NOW,
          updatedAt: NOW,
        };
        contacts.push(row);
        return { contact: copy(row), created: true };
      },
      async update(_s: unknown, id: ContactId, patch: Record<string, unknown>) {
        const row = contacts.find((candidate) => candidate.id === id);
        if (row === undefined) return null;
        Object.assign(row, patch);
        return copy(row);
      },
      async softDelete(_s: unknown, id: ContactId) {
        const index = contacts.findIndex((row) => row.id === id);
        if (index === -1) return false;
        contacts.splice(index, 1);
        return true;
      },
      async addTag(_s: unknown, ids: readonly ContactId[], tagId: TagId) {
        for (const contactId of ids) tagged.push({ contactId, tagId });
        return ids.length;
      },
      async removeTag(_s: unknown, ids: readonly ContactId[]) {
        return ids.length;
      },
      async addToList(_s: unknown, ids: readonly ContactId[], listId: ContactListId) {
        for (const contactId of ids) memberships.push({ contactId, listId });
        return ids.length;
      },
      async removeFromList(_s: unknown, ids: readonly ContactId[]) {
        return ids.length;
      },
    },

    lists: {
      async create(_s: unknown, input: { id: ContactListId; name: string; description?: string }) {
        const row = {
          id: input.id,
          name: input.name,
          description: input.description ?? null,
          memberCount: 0,
          createdAt: NOW,
          archivedAt: null,
        };
        lists.push(row);
        return copy(row);
      },
      async list() {
        return lists.map(copy);
      },
      async findById(_s: unknown, id: ContactListId) {
        const row = lists.find((candidate) => candidate.id === id);
        return row === undefined ? null : copy(row);
      },
      async update(_s: unknown, id: ContactListId, patch: { name?: string }) {
        const row = lists.find((candidate) => candidate.id === id);
        if (row === undefined) return null;
        Object.assign(row, patch);
        return copy(row);
      },
      async archive(_s: unknown, id: ContactListId, at: Date) {
        const row = lists.find((candidate) => candidate.id === id);
        if (row === undefined || row.archivedAt !== null) return null;
        row.archivedAt = at;
        return copy(row);
      },
      async remove(_s: unknown, id: ContactListId) {
        const index = lists.findIndex((row) => row.id === id);
        if (index === -1) return false;
        lists.splice(index, 1);
        return true;
      },
      async recountMembers(_s: unknown, id: ContactListId) {
        return memberships.filter((row) => row.listId === id).length;
      },
    },

    tags: {
      async create(_s: unknown, input: { id: TagId; name: string; color?: string }) {
        const row = { id: input.id, name: input.name, color: input.color ?? null, createdAt: NOW };
        tags.push(row);
        return copy(row);
      },
      async list() {
        return tags.map(copy);
      },
      async findById(_s: unknown, id: TagId) {
        const row = tags.find((candidate) => candidate.id === id);
        return row === undefined ? null : copy(row);
      },
      async update(_s: unknown, id: TagId, patch: { name?: string }) {
        const row = tags.find((candidate) => candidate.id === id);
        if (row === undefined) return null;
        Object.assign(row, patch);
        return copy(row);
      },
      async remove(_s: unknown, id: TagId) {
        const index = tags.findIndex((row) => row.id === id);
        if (index === -1) return false;
        tags.splice(index, 1);
        return true;
      },
    },

    segments: {
      async create(_s: unknown, input: { id: SegmentId; name: string; definition: unknown }) {
        const row = {
          id: input.id,
          name: input.name,
          definition: input.definition,
          cachedCount: null,
          cachedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        segments.push(row);
        return copy(row);
      },
      async list() {
        return segments.map(copy);
      },
      async findById(_s: unknown, id: SegmentId) {
        const row = segments.find((candidate) => candidate.id === id);
        return row === undefined ? null : copy(row);
      },
      async update(_s: unknown, id: SegmentId, patch: Record<string, unknown>) {
        const row = segments.find((candidate) => candidate.id === id);
        if (row === undefined) return null;
        Object.assign(row, patch, { updatedAt: NOW });
        return copy(row);
      },
      async remove(_s: unknown, id: SegmentId) {
        const index = segments.findIndex((row) => row.id === id);
        if (index === -1) return false;
        segments.splice(index, 1);
        return true;
      },
      async previewCount() {
        return { count: 412, capped: false };
      },
      async cacheCount(_s: unknown, id: SegmentId, count: number) {
        const row = segments.find((candidate) => candidate.id === id);
        if (row !== undefined) {
          row.cachedCount = count;
          row.cachedAt = NOW;
        }
      },
    },

    suppressions: {
      async add(_s: unknown, input: { id: SuppressionId; email: string; reason: string }) {
        if (suppressions.some((row) => row.email === input.email)) return null;
        const row = {
          id: input.id,
          email: input.email,
          reason: input.reason,
          scope: 'workspace',
          notes: null,
          sourceCampaignId: 'cmp-1',
          createdAt: NOW,
        };
        suppressions.push(row);
        return copy(row);
      },
      async list(_s: unknown, options: { reason?: string; search?: string } = {}) {
        return suppressions
          .filter((row) => options.reason === undefined || row.reason === options.reason)
          .filter((row) => options.search === undefined || row.email.includes(options.search))
          .map(copy);
      },
      async findByEmail(_s: unknown, email: string) {
        const row = suppressions.find((candidate) => candidate.email === email);
        return row === undefined ? null : copy(row);
      },
      async isSuppressed(_s: unknown, email: string) {
        return suppressions.some((row) => row.email === email);
      },
      async remove(_s: unknown, id: SuppressionId) {
        const index = suppressions.findIndex((row) => row.id === id);
        if (index === -1) return false;
        suppressions.splice(index, 1);
        return true;
      },
    },

    imports: {
      async create(
        _s: unknown,
        input: { id: ImportJobId; originalFilename: string; byteSize: number; fileType: string },
      ) {
        const row = {
          id: input.id,
          originalFilename: input.originalFilename,
          byteSize: input.byteSize,
          fileType: input.fileType,
          status: 'pending',
          columnMapping: null,
          totalRows: null,
          processedRows: 0,
          createdCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          createdAt: NOW,
          completedAt: null,
        };
        imports.push(row);
        return copy(row);
      },
      async list() {
        return imports.map(copy);
      },
      async findById(_s: unknown, id: ImportJobId) {
        const row = imports.find((candidate) => candidate.id === id);
        return row === undefined ? null : copy(row);
      },
      async setMapping(
        _s: unknown,
        id: ImportJobId,
        mapping: Record<string, string>,
      ) {
        const row = imports.find((candidate) => candidate.id === id);
        if (row === undefined || row.status !== 'pending') return false;
        row.columnMapping = mapping;
        row.status = 'validating';
        return true;
      },
      async transition(
        _s: unknown,
        id: ImportJobId,
        from: readonly string[],
        to: string,
      ) {
        const row = imports.find((candidate) => candidate.id === id);
        if (row === undefined || !from.includes(row.status)) return false;
        row.status = to;
        row.completedAt = NOW;
        return true;
      },
      async listRowErrors() {
        return [
          {
            rowNumber: 17,
            columnName: 'Email',
            errorCode: 'invalid_email',
            message: 'Not a valid address',
            rawValue: 'not-an-email',
          },
        ];
      },
    },

    savedViews: {
      async list() {
        return views.map(copy);
      },
      async findByKey(_s: unknown, key: string) {
        const row = views.find((candidate) => candidate.key === key);
        return row === undefined ? null : copy(row);
      },
      async create(
        _s: unknown,
        input: { id: string; key: string; label: string; filters: Record<string, string> },
      ) {
        if (views.some((row) => row.key === input.key)) return null;
        const row = { id: input.id, key: input.key, label: input.label, filters: input.filters };
        views.push(row);
        return copy(row);
      },
    },

    exports: {
      async create(_s: unknown, input: { id: string; resource: string }) {
        const row = { id: input.id, resource: input.resource, status: 'pending' };
        exports.push(row);
        return copy(row);
      },
    },

    stats: {
      async contactStats() {
        return { contacts: 48_213, subscribed: 45_102, suppressed: 2_318, matching: 8 };
      },
      async tagCounts() {
        return tags.map((tag) => ({ tagId: tag.id, contactCount: 3 }));
      },
      async segmentsByTag() {
        return tags.map((tag) => ({ tagId: tag.id, name: 'Engaged in 90 days' }));
      },
      async mergePreview() {
        return { total: 912, overlap: 634 };
      },
      async suppressionSummary() {
        return [
          { reason: 'unsubscribe', count: 1_800 },
          { reason: 'hard_bounce', count: 418 },
        ];
      },
      async suppressionSources() {
        return [{ id: 'cmp-1', name: 'September newsletter' }];
      },
      async tagsForContacts(_s: unknown, ids: readonly ContactId[]) {
        return ids.flatMap((contactId) =>
          tagged
            .filter((row) => row.contactId === contactId)
            .map((row) => ({
              contactId,
              tagId: row.tagId,
              name: tags.find((tag) => tag.id === row.tagId)?.name ?? 'VIP',
              color: '#3b82f6',
            })),
        );
      },
      async listsForContacts(_s: unknown, ids: readonly ContactId[]) {
        return ids.flatMap((contactId) =>
          memberships
            .filter((row) => row.contactId === contactId)
            .map((row) => ({
              contactId,
              listId: row.listId,
              name: lists.find((list) => list.id === row.listId)?.name ?? 'Newsletter',
            })),
        );
      },
      async contactActivity() {
        return [
          {
            id: 'rcp-1',
            state: 'delivered',
            at: new Date('2026-09-20T08:03:00Z'),
            campaignName: 'September newsletter',
          },
        ];
      },
    },

    tagMerge: {
      async merge() {
        return { moved: 278, collapsed: 634, segmentsRewritten: 1, contacts: 912 };
      },
    },

    auditLogs: {
      async append() {
        // Audited behaviour is audience.test.ts's subject, not this file's.
      },
    },

    consent: {
      async record() {
        // Likewise.
      },
    },
  } as unknown as AudienceRepositories;

  const service = new AudienceService({
    unitOfWork: async (fn) => fn(repos),
    storage: {
      async createUploadUrl(input: { key: string }) {
        return { uploadUrl: `https://uploads.test/${input.key}?signed=1`, key: input.key, expiresInSeconds: 900 };
      },
    },
    newId,
    now: () => NOW,
    currentActor: () => ({ type: 'user', id: USER, label: 'Dana Haddad' }),
  });

  return { service, contacts, lists, tags, segments, suppressions, imports };
}

type World = ReturnType<typeof buildWorld>;

function buildApp(service: AudienceService): Express {
  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);
  app.use(
    '/api/v1',
    audienceRoutes({
      audience: service,
      tokens,
      memberships: {
        async findMembership(userId: UserId, workspaceId: WorkspaceId) {
          return userId === USER && workspaceId === WS
            ? { workspaceId: WS, workspaceName: 'Northwind', workspaceSlug: 'northwind', role: 'owner' }
            : null;
        },
      } as unknown as GlobalMembershipRepository,
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
let world: World;
let app: Express;

beforeAll(async () => {
  bearer = await tokens.issueAccessToken({ sub: USER, sid: 'session-1', wsIds: [WS], ver: 1 });
});

/** Every call the browser makes carries these two headers. */
function call(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${bearer}`)
    .set('X-Workspace-Id', WS);
}

/** Seeds one of everything, so no endpoint is asserted against an empty list. */
async function seed(): Promise<{
  contactId: string;
  listId: string;
  tagId: string;
  segmentId: string;
  importId: string;
}> {
  const list = await call('post', '/api/v1/lists').send({ name: 'Newsletter' });
  const tag = await call('post', '/api/v1/tags').send({ name: 'VIP', color: '#3b82f6' });
  const contact = await call('post', '/api/v1/contacts').send({ email: 'amira@example.ae' });
  const segment = await call('post', '/api/v1/segments').send({
    name: 'Subscribed',
    definition: { op: 'status', value: 'subscribed' },
  });
  const job = await call('post', '/api/v1/imports').send({
    filename: 'contacts.csv',
    byteSize: 13_002_342,
    fileType: 'csv',
  });

  const contactId = contact.body.data.id as string;
  const listId = list.body.data.id as string;
  const tagId = tag.body.data.id as string;

  await call('post', `/api/v1/lists/${listId}/contacts`).send({ contactIds: [contactId] });
  await call('post', '/api/v1/contacts/tags').send({ contactIds: [contactId], tagId });
  await call('post', '/api/v1/suppressions').send({ email: 'bounced@example.ae', reason: 'manual' });

  return {
    contactId,
    listId,
    tagId,
    segmentId: segment.body.data.id as string,
    importId: job.body.data.id as string,
  };
}

beforeEach(() => {
  world = buildWorld();
  app = buildApp(world.service);
});

/* ------------------------------------------------------------------ */

describe('contacts', () => {
  it('GET /contacts sends ContactRow[] in data and the cursor in meta', async () => {
    await seed();
    const res = await call('get', '/api/v1/contacts?limit=50');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expectShape(res.body.data[0], CONTACT_ROW, 'contact');

    // `getPage` reads exactly these two, and nothing else in `meta`.
    expect(res.body.meta.hasMore).toBe(true);
    expect(res.body.meta.nextCursor).toBe('cursor-page-2');
    expect(res.body.data[0].nextCursor).toBeUndefined();
  });

  it('GET /contacts fills the three columns D1 draws beside the contact', async () => {
    await seed();
    const res = await call('get', '/api/v1/contacts');
    const row = res.body.data[0];

    // `row.tags.map(...)` and `row.lists.length` are unguarded in
    // apps/web/src/routes/audience/contacts.tsx; absent means a thrown
    // TypeError inside a render, not an empty cell.
    expectShape(row.tags[0], { id: 'string', name: 'string', color: 'string|null' }, 'tag ref');
    expect(row.lists).toEqual(['Newsletter']);
    expect(typeof row.lastEngaged).toBe('string');
  });

  it('GET /contacts/:id sends the whole ContactDetail the drawer reads', async () => {
    const { contactId } = await seed();
    const res = await call('get', `/api/v1/contacts/${contactId}`);

    expect(res.status).toBe(200);
    expectShape(res.body.data, CONTACT_DETAIL, 'contact detail');
    expectShape(
      res.body.data.suppression,
      { suppressed: 'boolean', headline: 'string', detail: 'string', removable: 'boolean' },
      'suppression strip',
    );
    expectShape(
      res.body.data.events[0],
      { id: 'string', state: 'string', when: 'string', detail: 'string' },
      'contact event',
    );
  });

  it('POST /contacts adds wasCreated and suppressed to the contact', async () => {
    const res = await call('post', '/api/v1/contacts').send({ email: 'new@example.ae' });

    expect(res.status).toBe(201);
    expectShape(res.body.data, { ...CONTACT, wasCreated: 'boolean', suppressed: 'boolean' }, 'created contact');
  });

  it('PATCH /contacts/:id sends a Contact and DELETE sends 204', async () => {
    const { contactId } = await seed();

    const patched = await call('patch', `/api/v1/contacts/${contactId}`).send({ status: 'unsubscribed' });
    expect(patched.status).toBe(200);
    expectShape(patched.body.data, CONTACT, 'patched contact');

    const deleted = await call('delete', `/api/v1/contacts/${contactId}`);
    expect(deleted.status).toBe(204);
    expect(deleted.body).toEqual({});
  });

  it('POST and DELETE /contacts/tags both send { affected }', async () => {
    const { contactId, tagId } = await seed();

    for (const method of ['post', 'delete'] as const) {
      const res = await call(method, '/api/v1/contacts/tags').send({ contactIds: [contactId], tagId });
      expect(res.status, method).toBe(200);
      expectShape(res.body.data, { affected: 'number' }, `${method} /contacts/tags`);
    }
  });
});

describe('the audience header and its saved views', () => {
  it('GET /stats sends the four counts D1 prints', async () => {
    const res = await call('get', '/api/v1/stats?status=subscribed');

    expect(res.status).toBe(200);
    expectShape(
      res.body.data,
      { contacts: 'number', subscribed: 'number', suppressed: 'number', matching: 'number' },
      'stats',
    );
  });

  it('GET and POST /saved-views send { key, label } with status only when set', async () => {
    const created = await call('post', '/api/v1/saved-views').send({
      label: 'Recently bounced',
      filters: { status: 'bounced' },
    });

    expect(created.status).toBe(201);
    expectShape(created.body.data, { key: 'string', label: 'string' }, 'saved view');
    expect(created.body.data.status).toBe('bounced');

    const listed = await call('get', '/api/v1/saved-views');
    expect(listed.status).toBe(200);
    expectShape(listed.body.data[0], { key: 'string', label: 'string' }, 'saved view');
  });

  it('POST /exports is 202 with { id, status }', async () => {
    const res = await call('post', '/api/v1/exports').send({ resource: 'contacts' });

    expect(res.status).toBe(202);
    expectShape(res.body.data, { id: 'string', status: 'string' }, 'export job');
  });

  it('POST /exports refuses a resource outside the five the client may ask for', async () => {
    // The contacts page used to post `resource: 'saved-view'` here, which is
    // a 400 every time. This is the assertion that keeps that a 400 rather
    // than something the server quietly accepts.
    const res = await call('post', '/api/v1/exports').send({ resource: 'saved-view' });
    expect(res.status).toBe(400);
  });
});

describe('lists', () => {
  it('every list endpoint sends a ListCard', async () => {
    const { listId } = await seed();

    const listed = await call('get', '/api/v1/lists');
    expect(listed.status).toBe(200);
    expectShape(listed.body.data[0], LIST_CARD, 'list card');

    const renamed = await call('patch', `/api/v1/lists/${listId}`).send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expectShape(renamed.body.data, LIST_CARD, 'renamed list');

    const archived = await call('post', `/api/v1/lists/${listId}/archive`);
    expect(archived.status).toBe(200);
    expectShape(archived.body.data, LIST_CARD, 'archived list');
    expect(archived.body.data.archived).toBe(true);
  });

  it('POST /lists sends the fields ContactList declares', async () => {
    const res = await call('post', '/api/v1/lists').send({ name: 'Nordics', description: 'DK, SE, NO' });

    expect(res.status).toBe(201);
    expectShape(
      res.body.data,
      {
        id: 'string',
        name: 'string',
        description: 'string|null',
        memberCount: 'number',
        createdAt: 'string',
      },
      'created list',
    );
  });

  it('the membership endpoints send { affected, memberCount }', async () => {
    const { contactId, listId } = await seed();

    for (const method of ['post', 'delete'] as const) {
      const res = await call(method, `/api/v1/lists/${listId}/contacts`).send({
        contactIds: [contactId],
      });
      expect(res.status, method).toBe(200);
      expectShape(res.body.data, { affected: 'number', memberCount: 'number' }, `${method} membership`);
    }
  });

  it('DELETE /lists/:id sends 204', async () => {
    const { listId } = await seed();
    expect((await call('delete', `/api/v1/lists/${listId}`)).status).toBe(204);
  });
});

describe('tags', () => {
  it('GET and PATCH /tags send a TagRow with its count and segments', async () => {
    const { tagId } = await seed();

    const listed = await call('get', '/api/v1/tags');
    expect(listed.status).toBe(200);
    expectShape(listed.body.data[0], TAG_ROW, 'tag row');

    const renamed = await call('patch', `/api/v1/tags/${tagId}`).send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expectShape(renamed.body.data, TAG_ROW, 'renamed tag');
  });

  it('POST /tags sends the fields Tag declares', async () => {
    const res = await call('post', '/api/v1/tags').send({ name: 'Loyalty' });

    expect(res.status).toBe(201);
    expectShape(
      res.body.data,
      { id: 'string', name: 'string', color: 'string|null', createdAt: 'string' },
      'created tag',
    );
  });

  it('the merge preview and the merge send what the dialog reads', async () => {
    const { tagId } = await seed();
    const second = await call('post', '/api/v1/tags').send({ name: 'Second' });
    const otherId = second.body.data.id as string;

    const preview = await call('get', `/api/v1/tags/merge-preview?ids=${tagId},${otherId}`);
    expect(preview.status).toBe(200);
    expectShape(preview.body.data, { total: 'number', overlap: 'number' }, 'merge preview');

    const merged = await call('post', '/api/v1/tags/merge').send({ keepId: tagId, mergeIds: [otherId] });
    expect(merged.status).toBe(200);
    expectShape(merged.body.data, { keepId: 'string', contacts: 'number' }, 'merge');
  });

  it('DELETE /tags/:id sends 204', async () => {
    const { tagId } = await seed();
    expect((await call('delete', `/api/v1/tags/${tagId}`)).status).toBe(204);
  });
});

describe('segments', () => {
  it('GET, POST and PATCH /segments all send a Segment with updatedAt', async () => {
    const { segmentId } = await seed();

    const listed = await call('get', '/api/v1/segments');
    expect(listed.status).toBe(200);
    expectShape(listed.body.data[0], SEGMENT, 'segment');
    // D5b's builder parses this with the browser's own AST schema, so it
    // must arrive as the object that was stored, not as a string.
    expect(listed.body.data[0].definition).toEqual({ op: 'status', value: 'subscribed' });

    const patched = await call('patch', `/api/v1/segments/${segmentId}`).send({
      name: 'Still subscribed',
      definition: { op: 'status', value: 'subscribed' },
    });
    expect(patched.status).toBe(200);
    expectShape(patched.body.data, SEGMENT, 'patched segment');
    expect(patched.body.data.name).toBe('Still subscribed');
  });

  it('both preview endpoints send { count, capped, cap, subscribedTotal }', async () => {
    const { segmentId } = await seed();
    const shape: Record<string, Check> = {
      count: 'number',
      capped: 'boolean',
      cap: 'number',
      subscribedTotal: 'number',
    };

    const unsaved = await call('post', '/api/v1/segments/preview').send({
      definition: { op: 'status', value: 'subscribed' },
    });
    expect(unsaved.status).toBe(200);
    expectShape(unsaved.body.data, shape, 'unsaved preview');

    const saved = await call('post', `/api/v1/segments/${segmentId}/preview`);
    expect(saved.status).toBe(200);
    expectShape(saved.body.data, shape, 'saved preview');
  });

  it('DELETE /segments/:id sends 204', async () => {
    const { segmentId } = await seed();
    expect((await call('delete', `/api/v1/segments/${segmentId}`)).status).toBe(204);
  });
});

describe('suppressions', () => {
  it('GET /suppressions sends a SuppressionRow per row', async () => {
    await seed();
    const res = await call('get', '/api/v1/suppressions');

    expect(res.status).toBe(200);
    expectShape(res.body.data[0], SUPPRESSION_ROW, 'suppression row');
    // The source column is the campaign's name, not its id: D7 prints it.
    expect(res.body.data[0].source).toBe('September newsletter');
  });

  it('GET /suppressions honours the three chips D7 sends', async () => {
    await seed();

    const matched = await call('get', '/api/v1/suppressions?reason=manual&source=any&q=bounced');
    expect(matched.status).toBe(200);
    expect(matched.body.data).toHaveLength(1);

    // A filter the server ignored would return the same row here, which is
    // exactly how this endpoint used to behave.
    const missed = await call('get', '/api/v1/suppressions?reason=complaint');
    expect(missed.body.data).toHaveLength(0);
  });

  it('POST /suppressions sends a Suppression whether or not it created one', async () => {
    const first = await call('post', '/api/v1/suppressions').send({
      email: 'again@example.ae',
      reason: 'manual',
    });
    expect(first.status).toBe(201);
    expectShape(first.body.data, SUPPRESSION_ROW, 'new suppression');

    // 200 rather than 201, and the row that already exists — never a
    // second body shape the caller would have to branch on.
    const second = await call('post', '/api/v1/suppressions').send({
      email: 'again@example.ae',
      reason: 'manual',
    });
    expect(second.status).toBe(200);
    expectShape(second.body.data, SUPPRESSION_ROW, 'repeated suppression');
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it('the summary and the source options match their declarations', async () => {
    await seed();

    const summary = await call('get', '/api/v1/suppressions/summary');
    expect(summary.status).toBe(200);
    expectShape(summary.body.data, { total: 'number', byReason: 'array' }, 'summary');
    expectShape(summary.body.data.byReason[0], { reason: 'string', count: 'number' }, 'summary row');

    const sources = await call('get', '/api/v1/suppressions/sources');
    expect(sources.status).toBe(200);
    expectShape(sources.body.data[0], { value: 'string', label: 'string' }, 'source option');
    // "Any campaign" first, because it is the value the chip sends back.
    expect(sources.body.data[0].value).toBe('any');
  });

  it('DELETE /suppressions/:id sends 204', async () => {
    await seed();
    const listed = await call('get', '/api/v1/suppressions');
    const id = listed.body.data[0].id as string;

    expect((await call('delete', `/api/v1/suppressions/${id}`)).status).toBe(204);
  });
});

describe('imports', () => {
  it('POST /imports sends the id, the status and the upload URL', async () => {
    const res = await call('post', '/api/v1/imports').send({
      filename: 'contacts.csv',
      byteSize: 1024,
      fileType: 'csv',
    });

    expect(res.status).toBe(201);
    expectShape(res.body.data, { id: 'string', status: 'string', upload: 'object' }, 'created import');
    // `upload.url`, not `uploadUrl`: the browser PUTs straight to this.
    expectShape(res.body.data.upload, { url: 'string', expiresInSeconds: 'number' }, 'upload');
    expect(IMPORT_STATUSES).toContain(res.body.data.status);
  });

  it('GET /imports and GET /imports/:id send an ImportJob', async () => {
    const { importId } = await seed();

    const listed = await call('get', '/api/v1/imports');
    expect(listed.status).toBe(200);
    expectShape(listed.body.data[0], IMPORT_JOB, 'import job');

    const one = await call('get', `/api/v1/imports/${importId}`);
    expect(one.status).toBe(200);
    expectShape(one.body.data, IMPORT_JOB, 'import job');
    // `columnMapping` is `Record<string, string> | null` on the client and
    // is read before any mapping is set.
    expect(one.body.data.columnMapping).toBeNull();
  });

  it('every status the import flow emits is one the page switches on', async () => {
    const { importId } = await seed();

    const created = await call('get', `/api/v1/imports/${importId}`);
    expect(IMPORT_STATUSES).toContain(created.body.data.status);

    const mapped = await call('post', `/api/v1/imports/${importId}/mapping`).send({
      mapping: { 'Email address': 'email', 'First name': 'firstName' },
      options: {
        updateExisting: true,
        addToListIds: [],
        tagIds: [],
        consentDeclaration: 'Collected at booking confirmation, opt-in checkbox.',
        consentSource: 'imported_from_previous_provider',
      },
    });
    expect(mapped.status).toBe(200);
    expectShape(mapped.body.data, IMPORT_JOB, 'mapped import');
    expect(IMPORT_STATUSES).toContain(mapped.body.data.status);
    expect(mapped.body.data.columnMapping).toEqual({
      'Email address': 'email',
      'First name': 'firstName',
    });

    const cancelled = await call('post', `/api/v1/imports/${importId}/cancel`);
    // 204: the client declares `void` here and re-reads the job through the
    // poller rather than trusting a body that is not sent.
    expect(cancelled.status).toBe(204);

    const after = await call('get', `/api/v1/imports/${importId}`);
    expect(after.body.data.status).toBe('cancelled');
    expect(IMPORT_STATUSES).toContain(after.body.data.status);
  });

  it('GET /imports/:id/errors sends an ImportRowError per row', async () => {
    const { importId } = await seed();
    const res = await call('get', `/api/v1/imports/${importId}/errors`);

    expect(res.status).toBe(200);
    expectShape(
      res.body.data[0],
      { rowNumber: 'number', errorCode: 'string', message: 'string' },
      'row error',
    );
  });
});

describe('the workspace boundary', () => {
  it('gives a non-member 404 for another workspace, never 403', async () => {
    const res = await request(app)
      .get('/api/v1/contacts')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Workspace-Id', 'ws-somebody-else');

    expect(res.status).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).get('/api/v1/contacts')).status).toBe(401);
  });
});
