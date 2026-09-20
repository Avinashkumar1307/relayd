import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactId, ContactListId, ImportJobId, TagId, WorkspaceId } from '@relayd/types';
import { workspaceScope } from '@relayd/db';
import { AudienceService, type AudienceRepositories } from '../src/services/audience.js';

const WS = 'ws-1' as WorkspaceId;
const scope = workspaceScope(WS);

/**
 * In-memory audience world. Faithful on the parts the service depends on:
 * upsert returns whether it created, guarded deletes report whether they
 * matched, and every read returns a copy so a "before" snapshot cannot mutate.
 */
function buildAudienceWorld() {
  interface FakeContact {
    id: ContactId;
    email: string;
    firstName: string | null;
    lastName: string | null;
    status: string;
    source: string;
    consentStatus: string;
    attributes: Record<string, unknown>;
    deleted: boolean;
    createdAt: Date;
    updatedAt: Date;
  }

  const contacts: FakeContact[] = [];
  const lists: { id: ContactListId; name: string; memberCount: number }[] = [];
  const memberships: { listId: ContactListId; contactId: ContactId }[] = [];
  const tagRows: { id: TagId; name: string }[] = [];
  const tagLinks: { tagId: TagId; contactId: ContactId }[] = [];
  const suppressed = new Set<string>();
  const segments: { id: string; name: string; definition: unknown; cachedCount: number | null }[] = [];
  const imports: { id: string; status: string; s3Key: string }[] = [];
  const audit: Record<string, unknown>[] = [];
  const previewCalls: { sql: string; params: unknown[] }[] = [];

  let previewResult = 0;

  const copy = <T>(row: T): T => ({ ...row });
  const now = () => new Date('2026-09-17T12:00:00Z');

  const attestations: { subjectKind: string; source: string; attestedBy: string }[] = [];

  const repos: AudienceRepositories = {
    consent: {
      async record(_s: unknown, input: { subjectKind: string; source: string; attestedBy: string }) {
        attestations.push(input);
        return input;
      },
      async newestFor() {
        return null;
      },
    } as unknown as AudienceRepositories['consent'],
    contacts: {
      async findByEmail(_s: unknown, email: string) {
        const found = contacts.find((c) => c.email === email && !c.deleted);
        return found === undefined ? null : copy(found);
      },
      async findById(_s: unknown, id: ContactId) {
        const found = contacts.find((c) => c.id === id && !c.deleted);
        return found === undefined ? null : copy(found);
      },
      async upsert(_s: unknown, input: { id: ContactId; email: string; [k: string]: unknown }) {
        const existing = contacts.find((c) => c.email === input.email && !c.deleted);
        if (existing !== undefined) {
          Object.assign(existing, {
            firstName: (input['firstName'] as string) ?? existing.firstName,
          });
          return { contact: copy(existing), created: false };
        }
        const row: FakeContact = {
          id: input.id,
          email: input.email,
          firstName: (input['firstName'] as string) ?? null,
          lastName: (input['lastName'] as string) ?? null,
          status: 'subscribed',
          source: (input['source'] as string) ?? 'manual',
          consentStatus: (input['consentStatus'] as string) ?? 'unknown',
          attributes: (input['attributes'] as Record<string, unknown>) ?? {},
          deleted: false,
          createdAt: now(),
          updatedAt: now(),
        };
        contacts.push(row);
        return { contact: copy(row), created: true };
      },
      async update(_s: unknown, id: ContactId, patch: Record<string, unknown>) {
        const row = contacts.find((c) => c.id === id && !c.deleted);
        if (row === undefined) return null;
        Object.assign(row, patch, { updatedAt: now() });
        return copy(row);
      },
      async softDelete(_s: unknown, id: ContactId) {
        const row = contacts.find((c) => c.id === id && !c.deleted);
        if (row === undefined) return false;
        row.deleted = true;
        return true;
      },
      async list() {
        return { contacts: contacts.filter((c) => !c.deleted).map(copy) };
      },
      async addTag(_s: unknown, ids: ContactId[], tagId: TagId) {
        let added = 0;
        for (const contactId of ids) {
          if (!tagLinks.some((l) => l.tagId === tagId && l.contactId === contactId)) {
            tagLinks.push({ tagId, contactId });
            added += 1;
          }
        }
        return added;
      },
      async removeTag(_s: unknown, ids: ContactId[], tagId: TagId) {
        const before = tagLinks.length;
        for (let i = tagLinks.length - 1; i >= 0; i -= 1) {
          const link = tagLinks[i];
          if (link !== undefined && link.tagId === tagId && ids.includes(link.contactId)) {
            tagLinks.splice(i, 1);
          }
        }
        return before - tagLinks.length;
      },
      async addToList(_s: unknown, ids: ContactId[], listId: ContactListId) {
        let added = 0;
        for (const contactId of ids) {
          if (!memberships.some((m) => m.listId === listId && m.contactId === contactId)) {
            memberships.push({ listId, contactId });
            added += 1;
          }
        }
        return added;
      },
      async removeFromList(_s: unknown, ids: ContactId[], listId: ContactListId) {
        const before = memberships.length;
        for (let i = memberships.length - 1; i >= 0; i -= 1) {
          const m = memberships[i];
          if (m !== undefined && m.listId === listId && ids.includes(m.contactId)) {
            memberships.splice(i, 1);
          }
        }
        return before - memberships.length;
      },
    } as unknown as AudienceRepositories['contacts'],

    lists: {
      async create(_s: unknown, input: { id: ContactListId; name: string }) {
        const row = { id: input.id, name: input.name, memberCount: 0 };
        lists.push(row);
        return copy(row);
      },
      async list() {
        return lists.map(copy);
      },
      async findById(_s: unknown, id: ContactListId) {
        const found = lists.find((l) => l.id === id);
        return found === undefined ? null : copy(found);
      },
      async remove(_s: unknown, id: ContactListId) {
        const index = lists.findIndex((l) => l.id === id);
        if (index === -1) return false;
        lists.splice(index, 1);
        return true;
      },
      async recountMembers(_s: unknown, id: ContactListId) {
        const count = memberships.filter((m) => m.listId === id).length;
        const row = lists.find((l) => l.id === id);
        if (row !== undefined) row.memberCount = count;
        return count;
      },
    } as unknown as AudienceRepositories['lists'],

    tags: {
      async create(_s: unknown, input: { id: TagId; name: string }) {
        const row = { id: input.id, name: input.name };
        tagRows.push(row);
        return copy(row);
      },
      async list() {
        return tagRows.map(copy);
      },
      async findById(_s: unknown, id: TagId) {
        const found = tagRows.find((t) => t.id === id);
        return found === undefined ? null : copy(found);
      },
      async remove(_s: unknown, id: TagId) {
        const index = tagRows.findIndex((t) => t.id === id);
        if (index === -1) return false;
        tagRows.splice(index, 1);
        return true;
      },
    } as unknown as AudienceRepositories['tags'],

    segments: {
      async create(_s: unknown, input: { id: string; name: string; definition: unknown }) {
        const row = { ...input, cachedCount: null };
        segments.push(row);
        return copy(row);
      },
      async list() {
        return segments.map(copy);
      },
      async findById(_s: unknown, id: string) {
        const found = segments.find((x) => x.id === id);
        return found === undefined ? null : copy(found);
      },
      async remove(_s: unknown, id: string) {
        const index = segments.findIndex((x) => x.id === id);
        if (index === -1) return false;
        segments.splice(index, 1);
        return true;
      },
      async previewCount(_s: unknown, compiled: { sql: string; params: unknown[]; cap: number }) {
        previewCalls.push({ sql: compiled.sql, params: compiled.params });
        return {
          count: Math.min(previewResult, compiled.cap),
          capped: previewResult > compiled.cap,
        };
      },
      async cacheCount(_s: unknown, id: string, count: number) {
        const row = segments.find((x) => x.id === id);
        if (row !== undefined) row.cachedCount = count;
      },
    } as unknown as AudienceRepositories['segments'],

    suppressions: {
      async isSuppressed(_s: unknown, email: string) {
        return suppressed.has(email.toLowerCase());
      },
      async add(_s: unknown, input: { id: string; email: string; reason: string }) {
        if (suppressed.has(input.email.toLowerCase())) return null;
        suppressed.add(input.email.toLowerCase());
        return { id: input.id, email: input.email, reason: input.reason };
      },
      async list() {
        return [...suppressed].map((email) => ({ email }));
      },
      async remove(_s: unknown, id: string) {
        return suppressed.delete(id);
      },
    } as unknown as AudienceRepositories['suppressions'],

    imports: {
      async create(_s: unknown, input: { id: string; s3Key: string }) {
        const row = { id: input.id, status: 'pending', s3Key: input.s3Key };
        imports.push(row);
        return copy(row);
      },
      async findById(_s: unknown, id: string) {
        const found = imports.find((i) => i.id === id);
        return found === undefined ? null : copy(found);
      },
      async list() {
        return imports.map(copy);
      },
      async transition(_s: unknown, id: string, from: string[], to: string) {
        const row = imports.find((i) => i.id === id);
        if (row === undefined || !from.includes(row.status)) return false;
        row.status = to;
        return true;
      },
      async listRowErrors() {
        return [];
      },
      async setMapping(_s: unknown, id: string) {
        const row = imports.find((i) => i.id === id);
        if (row === undefined || row.status !== 'pending') return false;
        row.status = 'validating';
        return true;
      },
    } as unknown as AudienceRepositories['imports'],

    auditLogs: {
      async append(_s: unknown, entry: Record<string, unknown>) {
        audit.push(entry);
      },
    } as unknown as AudienceRepositories['auditLogs'],

    // The four repositories section D's extra endpoints added. Stubbed
    // rather than modelled here: the tests in this file exercise CRUD, and
    // audience-extra.test.ts owns the behaviour behind these. They are
    // present because the service's repository bundle requires them, and a
    // stub that throws would fail a test for the wrong reason.
    savedViews: {
      async list() {
        return [];
      },
      async findByKey() {
        return null;
      },
      async create() {
        return null;
      },
    } as unknown as AudienceRepositories['savedViews'],

    exports: {
      async create(_s: unknown, input: { id: string; resource: string }) {
        return { id: input.id, resource: input.resource, status: 'pending', filters: {} };
      },
      async findById() {
        return null;
      },
      async list() {
        return [];
      },
    } as unknown as AudienceRepositories['exports'],

    stats: {
      async contactStats() {
        return { contacts: contacts.length, subscribed: 0, suppressed: suppressed.size, matching: 0 };
      },
      async tagCounts() {
        return tagRows.map((tag) => ({
          tagId: tag.id,
          contactCount: tagLinks.filter((link) => link.tagId === tag.id).length,
        }));
      },
      async segmentsByTag() {
        return [];
      },
      async mergePreview() {
        return { total: 0, overlap: 0 };
      },
      async suppressionSummary() {
        return [];
      },
      async suppressionSources() {
        return [];
      },
    } as unknown as AudienceRepositories['stats'],

    tagMerge: {
      async merge() {
        return { moved: 0, collapsed: 0, segmentsRewritten: 0, contacts: 0 };
      },
    } as unknown as AudienceRepositories['tagMerge'],
  };

  return {
    repos,
    contacts,
    lists,
    memberships,
    tagRows,
    tagLinks,
    suppressed,
    segments,
    imports,
    attestations,
    audit,
    previewCalls,
    setPreviewResult: (n: number) => {
      previewResult = n;
    },
  };
}

let world: ReturnType<typeof buildAudienceWorld>;
let service: AudienceService;
let createUploadUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  world = buildAudienceWorld();
  let counter = 0;

  createUploadUrl = vi.fn(async (input: { key: string }) => ({
    uploadUrl: `https://storage.test/${input.key}?signed=1`,
    key: input.key,
    expiresInSeconds: 900,
  }));

  service = new AudienceService({
    unitOfWork: async (fn) => fn(world.repos),
    storage: { createUploadUrl } as never,
    newId: () => `gen-${++counter}`,
    now: () => new Date('2026-09-17T12:00:00Z'),
    currentActor: () => ({ type: 'user', id: 'user-1' }),
  });
});

describe('contacts', () => {
  const base = { email: 'aisha@example.com', updateIfExists: true };

  it('creates one and reports that it was created', async () => {
    const result = await service.createContact(scope, base);
    expect(result.created).toBe(true);
    expect(world.contacts).toHaveLength(1);
  });

  it('updates rather than duplicating when the address exists', async () => {
    await service.createContact(scope, base);
    const again = await service.createContact(scope, { ...base, firstName: 'Aisha' });

    expect(again.created).toBe(false);
    expect(world.contacts).toHaveLength(1);
  });

  it('409s on a duplicate when updateIfExists is false', async () => {
    await service.createContact(scope, base);
    await expect(
      service.createContact(scope, { ...base, updateIfExists: false }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('ACCEPTS a suppressed address and marks it unsubscribed', async () => {
    // docs/03: writing a suppressed address returns the contact with status
    // unsubscribed rather than an error, "because resurrecting a suppression
    // silently would be worse".
    world.suppressed.add('aisha@example.com');

    const result = await service.createContact(scope, base);

    expect(result.suppressed).toBe(true);
    expect(result.contact.status).toBe('unsubscribed');
  });

  it('does not resurrect a suppression by re-adding the contact', async () => {
    world.suppressed.add('aisha@example.com');
    await service.createContact(scope, base);
    expect(world.suppressed.has('aisha@example.com')).toBe(true);
  });

  it('audits creation and deletion', async () => {
    const { contact } = await service.createContact(scope, base);
    await service.deleteContact(scope, contact.id);

    expect(world.audit.map((e) => e['action'])).toEqual([
      'contact.created',
      'contact.deleted',
    ]);
  });

  it('404s for a contact that is not there', async () => {
    await expect(service.getContact(scope, 'nope' as ContactId)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('bulk tagging', () => {
  it('adds a tag to many contacts and reports how many changed', async () => {
    const tag = await service.createTag(scope, { name: 'vip' });
    const a = await service.createContact(scope, { email: 'a@example.com', updateIfExists: true });
    const b = await service.createContact(scope, { email: 'b@example.com', updateIfExists: true });

    const result = await service.bulkTag(scope, [a.contact.id, b.contact.id], tag.id, 'add');
    expect(result.affected).toBe(2);
  });

  it('is idempotent: tagging twice affects nothing the second time', async () => {
    const tag = await service.createTag(scope, { name: 'vip' });
    const a = await service.createContact(scope, { email: 'a@example.com', updateIfExists: true });

    await service.bulkTag(scope, [a.contact.id], tag.id, 'add');
    const again = await service.bulkTag(scope, [a.contact.id], tag.id, 'add');

    expect(again.affected).toBe(0);
  });

  it('404s for a tag that does not exist, rather than silently doing nothing', async () => {
    await expect(service.bulkTag(scope, ['x'], 'no-such-tag', 'add')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('list membership', () => {
  it('recounts members rather than incrementing', async () => {
    // A recount cannot drift; an increment that fails halfway leaves the
    // denormalised counter permanently wrong.
    const list = await service.createList(scope, { name: 'Newsletter' });
    const a = await service.createContact(scope, { email: 'a@example.com', updateIfExists: true });
    const b = await service.createContact(scope, { email: 'b@example.com', updateIfExists: true });

    const result = await service.changeListMembership(
      scope,
      list.id,
      [a.contact.id, b.contact.id],
      'add',
    );

    expect(result).toEqual({ affected: 2, memberCount: 2 });
  });

  it('removes members and recounts', async () => {
    const list = await service.createList(scope, { name: 'Newsletter' });
    const a = await service.createContact(scope, { email: 'a@example.com', updateIfExists: true });
    await service.changeListMembership(scope, list.id, [a.contact.id], 'add');

    const result = await service.changeListMembership(scope, list.id, [a.contact.id], 'remove');
    expect(result).toEqual({ affected: 1, memberCount: 0 });
  });

  it('404s for a list that does not exist', async () => {
    await expect(
      service.changeListMembership(scope, 'nope' as ContactListId, ['x'], 'add'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('segments', () => {
  const definition = { op: 'status', value: 'subscribed' };

  it('refuses an invalid definition at save time, not at preview time', async () => {
    await expect(
      service.createSegment(scope, { name: 'bad', definition: { op: 'raw_sql' } }),
    ).rejects.toMatchObject({ status: 400 });

    expect(world.segments).toHaveLength(0);
  });

  it('saves a valid definition', async () => {
    await service.createSegment(scope, { name: 'Subscribed', definition });
    expect(world.segments).toHaveLength(1);
  });

  it('previews an unsaved definition', async () => {
    world.setPreviewResult(42);
    const result = await service.previewSegment(scope, { definition });
    expect(result.count).toBe(42);
    expect(result.capped).toBe(false);
  });

  it('caps the preview and says so', async () => {
    world.setPreviewResult(999_999);
    const result = await service.previewSegment(scope, { definition });

    expect(result.capped).toBe(true);
    expect(result.count).toBe(result.cap);
  });

  it('passes parameters to the repository, never inlined SQL', async () => {
    world.setPreviewResult(1);
    await service.previewSegment(scope, {
      definition: { op: 'attr', path: 'country', cmp: 'eq', value: "'; DROP TABLE contacts; --" },
    });

    const call = world.previewCalls[0];
    expect(call?.sql).not.toContain('DROP TABLE');
    expect(call?.params).toContain("'; DROP TABLE contacts; --");
  });

  it('caches an uncapped count for a saved segment', async () => {
    world.setPreviewResult(7);
    const segment = await service.createSegment(scope, { name: 'S', definition });
    await service.previewSegment(scope, { segmentId: segment.id });

    expect(world.segments[0]?.cachedCount).toBe(7);
  });

  it('does NOT cache a capped count', async () => {
    // Caching a capped number would show "10,000" forever for a segment that
    // actually matches four million.
    world.setPreviewResult(999_999);
    const segment = await service.createSegment(scope, { name: 'S', definition });
    await service.previewSegment(scope, { segmentId: segment.id });

    expect(world.segments[0]?.cachedCount).toBeNull();
  });
});

describe('suppressions', () => {
  it('marks an existing contact unsubscribed when the address is suppressed', async () => {
    const { contact } = await service.createContact(scope, {
      email: 'aisha@example.com',
      updateIfExists: true,
    });
    expect(contact.status).toBe('subscribed');

    await service.addSuppression(scope, { email: 'aisha@example.com', reason: 'complaint' });

    expect(world.contacts[0]?.status).toBe('unsubscribed');
  });

  it('suppressing twice is success, not a conflict', async () => {
    // A bounce handler that fails because it ran twice leaves the address
    // sendable, which is the opposite of what it was called to do.
    await service.addSuppression(scope, { email: 'a@example.com', reason: 'hard_bounce' });
    await expect(
      service.addSuppression(scope, { email: 'a@example.com', reason: 'hard_bounce' }),
    ).resolves.toBeNull();
  });
});

describe('imports', () => {
  const file = { filename: 'contacts.csv', byteSize: 1024, fileType: 'csv' as const };

  it('returns a direct upload URL so the file never passes through the API', async () => {
    const { upload } = await service.createImport(scope, file);
    expect(upload.uploadUrl).toContain('signed=1');
    expect(upload.expiresInSeconds).toBeGreaterThan(0);
  });

  it('scopes the storage key to the workspace', async () => {
    await service.createImport(scope, file);
    expect(createUploadUrl.mock.calls[0]?.[0].key).toContain(WS);
  });

  it('SANITISES a traversing filename out of the storage key', async () => {
    // A key is built from user input and lands in a URL path; "../" would
    // otherwise let an upload escape its own prefix.
    await service.createImport(scope, { ...file, filename: '../../etc/passwd' });

    const key = createUploadUrl.mock.calls[0]?.[0].key as string;
    expect(key).not.toContain('..');
    expect(key).toContain(`imports/${WS}/`);
  });

  it('cancels a pending import', async () => {
    const { job } = await service.createImport(scope, file);
    await expect(service.cancelImport(scope, job.id)).resolves.toBeUndefined();
    expect(world.imports[0]?.status).toBe('cancelled');
  });

  it('409s cancelling one that already finished', async () => {
    const { job } = await service.createImport(scope, file);
    const row = world.imports[0];
    if (row !== undefined) row.status = 'completed';

    await expect(service.cancelImport(scope, job.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('an import records a consent attestation (docs/06)', () => {
  async function startImport() {
    const { job } = await service.createImport(scope, {
      filename: 'contacts.csv',
      byteSize: 1024,
      fileType: 'csv',
    });

    return job.id as ImportJobId;
  }

  it('records the declared source, attributed and timestamped', async () => {
    // docs/06: "Every import records a declared consent source ... Stored,
    // timestamped, attributed to a user." The pre-existing
    // `options.consentDeclaration` is a string inside a jsonb blob: it has
    // no timestamp of its own, no attribution, and nothing stops it being
    // edited afterwards to say something else.
    const id = await startImport();

    await service.setImportMapping(scope, id, {
      mapping: { A: 'email' },
      options: {
        updateExisting: true,
        addToListIds: [],
        tagIds: [],
        consentDeclaration: 'Collected through our website signup form since 2024',
        consentSource: 'signup_form',
      },
    });

    expect(world.attestations).toEqual([
      expect.objectContaining({
        subjectKind: 'import',
        source: 'signup_form',
        attestedBy: 'user-1',
      }),
    ]);
  });

  it('keeps the sender\u2019s own words alongside the vocabulary value', async () => {
    // The two are not redundant. The source answers "how many workspaces
    // claim to be importing from a previous provider" with a GROUP BY; the
    // declaration is what a regulator actually reads.
    const id = await startImport();

    await service.setImportMapping(scope, id, {
      mapping: { A: 'email' },
      options: {
        updateExisting: true,
        addToListIds: [],
        tagIds: [],
        consentDeclaration: 'Exported from our previous ESP, double opt-in',
        consentSource: 'imported_from_previous_provider',
      },
    });

    expect(world.attestations[0]).toMatchObject({
      detail: 'Exported from our previous ESP, double opt-in',
    });
  });

  it('carries no audience fingerprint', async () => {
    // The subject is the file, not an audience — and that null is what stops
    // an import attestation being reused to authorise a campaign launch.
    const id = await startImport();

    await service.setImportMapping(scope, id, {
      mapping: { A: 'email' },
      options: {
        updateExisting: true,
        addToListIds: [],
        tagIds: [],
        consentDeclaration: 'Collected in person at trade shows during 2025',
        consentSource: 'in_person',
      },
    });

    expect(world.attestations[0]).not.toHaveProperty('audienceFingerprint');
  });
});
