import { beforeEach, describe, expect, it } from 'vitest';
import type { ContactListId, TagId, UserId, WorkspaceId } from '@relayd/types';
import { AppError } from '@relayd/types';
import { workspaceScope } from '@relayd/db';
import { AudienceService, type AudienceRepositories } from '../src/services/audience.js';

/**
 * The audience endpoints section D needs beyond CRUD.
 *
 * Service level, with fake repositories: what is worth proving here is the
 * decisions, not the SQL. The SQL shape is
 * `packages/db/test/audience-extras-repository.test.ts`; applying either
 * against Postgres lands with the integration suite.
 *
 * The decisions, in the order they matter:
 *
 *   a saved view resolves to a filter, and an unknown one is a 404 rather
 *   than quietly becoming "all contacts" — a tab that shows a different
 *   audience than its name claims is worse than a tab that errors;
 *
 *   the header's `matching` and the list's rows come from the same resolved
 *   filter;
 *
 *   a merge names every tag in the workspace before it touches anything,
 *   so an id from another workspace is a 404 and not an overlap of zero;
 *
 *   everything that changes state a person would want to see later writes
 *   an audit row inside the same unit of work.
 */

const WS = 'ws-1' as WorkspaceId;
const scope = workspaceScope(WS);
const NOW = new Date('2026-09-17T12:00:00Z');

function buildWorld() {
  interface FakeView {
    id: string;
    key: string;
    label: string;
    filters: { status?: string | undefined; q?: string | undefined };
  }

  const views: FakeView[] = [];
  const exports: { id: string; resource: string; filters: Record<string, unknown> }[] = [];
  const lists: {
    id: ContactListId;
    name: string;
    description: string | null;
    memberCount: number;
    createdAt: Date;
    archivedAt: Date | null;
  }[] = [];
  const tagRows: { id: TagId; name: string; color: string | null; createdAt: Date }[] = [];
  const audit: Record<string, unknown>[] = [];

  const listCalls: Record<string, unknown>[] = [];
  const statCalls: Record<string, unknown>[] = [];
  const merges: { keepId: string; mergeIds: readonly string[] }[] = [];

  const copy = <T>(row: T): T => ({ ...row });

  const repos: AudienceRepositories = {
    contacts: {
      async list(_s: unknown, options: Record<string, unknown>) {
        listCalls.push(options);
        return { contacts: [] };
      },
    } as unknown as AudienceRepositories['contacts'],

    lists: {
      async list() {
        return lists.map(copy);
      },
      async findById(_s: unknown, id: ContactListId) {
        const found = lists.find((row) => row.id === id);
        return found === undefined ? null : copy(found);
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
    } as unknown as AudienceRepositories['lists'],

    tags: {
      async list() {
        return tagRows.map(copy);
      },
      async findById(_s: unknown, id: TagId) {
        const found = tagRows.find((row) => row.id === id);
        return found === undefined ? null : copy(found);
      },
      async update(_s: unknown, id: TagId, patch: { name?: string }) {
        const row = tagRows.find((candidate) => candidate.id === id);
        if (row === undefined) return null;
        Object.assign(row, patch);
        return copy(row);
      },
    } as unknown as AudienceRepositories['tags'],

    savedViews: {
      async list() {
        return views.map(copy);
      },
      async findByKey(_s: unknown, key: string) {
        const found = views.find((row) => row.key === key);
        return found === undefined ? null : copy(found);
      },
      async create(
        _s: unknown,
        input: { id: string; key: string; label: string; filters: FakeView['filters'] },
      ) {
        if (views.some((row) => row.key === input.key)) return null;
        const row = { id: input.id, key: input.key, label: input.label, filters: input.filters };
        views.push(row);
        return copy(row);
      },
    } as unknown as AudienceRepositories['savedViews'],

    exports: {
      async create(
        _s: unknown,
        input: { id: string; resource: string; filters: Record<string, unknown> },
      ) {
        const row = { id: input.id, resource: input.resource, filters: input.filters };
        exports.push(row);
        return { ...row, status: 'pending' };
      },
    } as unknown as AudienceRepositories['exports'],

    stats: {
      async contactStats(_s: unknown, filter: Record<string, unknown>) {
        statCalls.push(filter);
        return { contacts: 48_213, subscribed: 45_102, suppressed: 2_318, matching: 8 };
      },
      async tagCounts() {
        return tagRows.map((tag) => ({ tagId: tag.id, contactCount: 3 }));
      },
      async segmentsByTag() {
        return tagRows.map((tag) => ({ tagId: tag.id, name: 'Engaged in 90 days' }));
      },
      async mergePreview() {
        return { total: 912, overlap: 634 };
      },
      async suppressionSummary() {
        return [
          { reason: 'unsubscribe', count: 1_800 },
          { reason: 'hard_bounce', count: 418 },
          { reason: 'complaint', count: 100 },
        ];
      },
      async suppressionSources() {
        return [{ id: 'cmp-1', name: 'September newsletter' }];
      },
      // D1's Tags and Lists columns. Empty here: these tests are about
      // which filter reaches the list, not what decorates its rows.
      async tagsForContacts() {
        return [];
      },
      async listsForContacts() {
        return [];
      },
      async contactActivity() {
        return [];
      },
    } as unknown as AudienceRepositories['stats'],

    tagMerge: {
      async merge(_s: unknown, keepId: string, mergeIds: readonly string[]) {
        merges.push({ keepId, mergeIds });
        return { moved: 278, collapsed: 634, segmentsRewritten: 1, contacts: 912 };
      },
    } as unknown as AudienceRepositories['tagMerge'],

    segments: {} as unknown as AudienceRepositories['segments'],
    suppressions: {} as unknown as AudienceRepositories['suppressions'],
    imports: {} as unknown as AudienceRepositories['imports'],
    consent: {} as unknown as AudienceRepositories['consent'],

    auditLogs: {
      async append(_s: unknown, entry: Record<string, unknown>) {
        audit.push(entry);
      },
    } as unknown as AudienceRepositories['auditLogs'],
  };

  return { repos, views, exports, lists, tagRows, audit, listCalls, statCalls, merges };
}

let world: ReturnType<typeof buildWorld>;
let service: AudienceService;

beforeEach(() => {
  world = buildWorld();
  let counter = 0;

  service = new AudienceService({
    unitOfWork: async (fn) => fn(world.repos),
    storage: { createUploadUrl: async () => ({ uploadUrl: '', key: '', expiresInSeconds: 0 }) },
    newId: () => `gen-${++counter}`,
    now: () => NOW,
    currentActor: () => ({ type: 'user', id: 'user-1' }),
  });
});

const actions = () => world.audit.map((entry) => entry['action']);

/* ------------------------------------------------------------------- stats */

describe('the header counts', () => {
  it('reports the four numbers D1 prints', async () => {
    const stats = await service.stats(scope, {});
    expect(stats).toEqual({
      contacts: 48_213,
      subscribed: 45_102,
      suppressed: 2_318,
      matching: 8,
    });
  });

  it('passes the page filter through to the matching count', async () => {
    await service.stats(scope, { status: 'bounced', q: 'khalil' });
    expect(world.statCalls[0]).toEqual({ status: 'bounced', search: 'khalil' });
  });

  it('asks the same question the list asks', async () => {
    world.views.push({ id: 'v1', key: 'lapsed', label: 'Lapsed', filters: { status: 'unsubscribed' } });

    await service.listContacts(scope, { view: 'lapsed', limit: 50 });
    await service.stats(scope, { view: 'lapsed' });

    // The footer says "of 48,213" about the rows above it. If the two
    // resolved `view` differently, the count would be the size of a set
    // nobody is looking at.
    expect(world.listCalls[0]).toMatchObject({ status: 'unsubscribed' });
    expect(world.statCalls[0]).toEqual({ status: 'unsubscribed' });
  });
});

/* ------------------------------------------------------------- saved views */

describe('saved views', () => {
  it('returns each view as a tab, with the status it filters on', async () => {
    world.views.push({ id: 'v1', key: 'lapsed', label: 'Lapsed', filters: { status: 'unsubscribed' } });
    world.views.push({ id: 'v2', key: 'search', label: 'Search', filters: { q: 'gulf' } });

    expect(await service.listSavedViews(scope)).toEqual([
      { key: 'lapsed', label: 'Lapsed', status: 'unsubscribed' },
      // No `status` key at all rather than an undefined one: the tab strip
      // asks whether the field is present.
      { key: 'search', label: 'Search' },
    ]);
  });

  it('derives the key from the label and audits the creation', async () => {
    const view = await service.createSavedView(scope, {
      label: 'Lapsed in Dubai',
      filters: { status: 'unsubscribed' },
      createdBy: 'user-1' as UserId,
    });

    expect(view).toEqual({ key: 'lapsed-in-dubai', label: 'Lapsed in Dubai', status: 'unsubscribed' });
    expect(actions()).toContain('saved_view.created');
  });

  it('refuses a second view whose label produces the same key', async () => {
    await service.createSavedView(scope, { label: 'Lapsed', filters: {} });

    // Not a silent suffix. Two tabs reading "Lapsed" that filter
    // differently are indistinguishable on the strip.
    await expect(service.createSavedView(scope, { label: 'lapsed!', filters: {} })).rejects.toThrow(
      AppError,
    );
    expect(world.views.length).toBe(1);
  });

  it('refuses to shadow a built-in tab', async () => {
    await expect(service.createSavedView(scope, { label: 'All', filters: {} })).rejects.toThrow(
      /built-in/u,
    );
    await expect(
      service.createSavedView(scope, { label: 'Subscribed', filters: {} }),
    ).rejects.toThrow(/built-in/u);
  });

  it('resolves a view to its filter when the list asks for it', async () => {
    world.views.push({ id: 'v1', key: 'gulf', label: 'Gulf', filters: { q: 'gulf', status: 'subscribed' } });

    await service.listContacts(scope, { view: 'gulf', limit: 25, cursor: 'abc' });

    expect(world.listCalls[0]).toEqual({
      limit: 25,
      cursor: 'abc',
      status: 'subscribed',
      search: 'gulf',
    });
  });

  it('lets an explicit filter narrow the view rather than being discarded', async () => {
    world.views.push({ id: 'v1', key: 'gulf', label: 'Gulf', filters: { q: 'gulf' } });

    await service.listContacts(scope, { view: 'gulf', q: 'khalil' });

    // Typing in the search box while a view is selected must do something.
    expect(world.listCalls[0]).toMatchObject({ search: 'khalil' });
  });

  it('404s an unknown view instead of showing the whole audience', async () => {
    await expect(service.listContacts(scope, { view: 'deleted-view' })).rejects.toThrow(AppError);
    await expect(service.stats(scope, { view: 'deleted-view' })).rejects.toThrow(AppError);
  });

  it('does not look up the two views D1 draws itself', async () => {
    await service.listContacts(scope, { view: 'all' });
    await service.listContacts(scope, { view: 'subscribed' });

    // Neither is stored, so treating them as saved views would 404 the
    // default tab.
    expect(world.listCalls.length).toBe(2);
  });
});

/* ----------------------------------------------------------------- exports */

describe('exports', () => {
  it('records the request and hands back a pending job', async () => {
    const job = await service.startExport(scope, {
      resource: 'contacts',
      ids: ['c1', 'c2'],
      requestedBy: 'user-1' as UserId,
    });

    expect(job.status).toBe('pending');
    expect(world.exports[0]).toMatchObject({ resource: 'contacts', filters: { ids: ['c1', 'c2'] } });
  });

  it('audits it, because an export is the audience leaving the product', async () => {
    await service.startExport(scope, { resource: 'suppressions' });
    expect(actions()).toContain('export.started');
  });
});

/* ------------------------------------------------------------------- lists */

describe('lists', () => {
  beforeEach(() => {
    world.lists.push({
      id: 'l1' as ContactListId,
      name: 'Newsletter',
      description: null,
      memberCount: 8_240,
      createdAt: NOW,
      archivedAt: null,
    });
  });

  it('draws an active card with its member count', async () => {
    const [card] = await service.listLists(scope);
    expect(card).toMatchObject({ archived: false, footnote: '8,240 contacts' });
  });

  it('archives once, and says when', async () => {
    const card = await service.archiveList(scope, 'l1' as ContactListId);

    expect(card).toMatchObject({ archived: true, footnote: 'Archived 17 Sep 2026' });
    expect(actions()).toContain('list.archived');
  });

  it('refuses to archive the same list twice', async () => {
    await service.archiveList(scope, 'l1' as ContactListId);
    // Not idempotent on purpose: a second archive that moved the date would
    // change what the card says for no reason anybody asked for.
    await expect(service.archiveList(scope, 'l1' as ContactListId)).rejects.toThrow(/already/u);
  });

  it('refuses to rename an archived list', async () => {
    await service.archiveList(scope, 'l1' as ContactListId);
    await expect(
      service.renameList(scope, 'l1' as ContactListId, { name: 'Anything' }),
    ).rejects.toThrow(AppError);
  });

  it('renames an active list and audits both names', async () => {
    await service.renameList(scope, 'l1' as ContactListId, { name: 'Weekly digest' });

    const entry = world.audit.find((row) => row['action'] === 'list.renamed');
    expect(entry?.['before']).toEqual({ name: 'Newsletter' });
    expect(entry?.['after']).toEqual({ name: 'Weekly digest' });
  });

  it('404s a list from another workspace rather than 403', async () => {
    await expect(
      service.renameList(scope, 'someone-elses' as ContactListId, { name: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.archiveList(scope, 'someone-elses' as ContactListId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('leaves the trend empty rather than inventing one', async () => {
    const [card] = await service.listLists(scope);
    expect(card?.growth30d).toBeNull();
    expect(card?.trend).toEqual([]);
  });
});

/* -------------------------------------------------------------------- tags */

describe('tags', () => {
  beforeEach(() => {
    world.tagRows.push({ id: 't-keep' as TagId, name: 'Dubai', color: '#3b82f6', createdAt: NOW });
    world.tagRows.push({ id: 't-lose' as TagId, name: 'dubai-leisure', color: null, createdAt: NOW });
  });

  it('carries the contact count and the segments each tag appears in', async () => {
    const rows = await service.listTags(scope);
    expect(rows[0]).toMatchObject({ contactCount: 3, segments: ['Engaged in 90 days'] });
  });

  it('previews a merge', async () => {
    expect(await service.mergePreview(scope, ['t-keep', 't-lose'])).toEqual({
      total: 912,
      overlap: 634,
    });
  });

  it('404s a preview naming a tag this workspace does not have', async () => {
    // Zero overlap and "that tag is not yours" are different answers, and
    // returning the first for the second leaks nothing but tells the caller
    // nothing either.
    await expect(service.mergePreview(scope, ['t-keep', 't-elsewhere'])).rejects.toMatchObject({
      status: 404,
    });
  });

  it('merges, and reports the surviving tag and its new size', async () => {
    const result = await service.mergeTags(scope, { keepId: 't-keep', mergeIds: ['t-lose'] });

    expect(result).toEqual({ keepId: 't-keep', contacts: 912 });
    expect(world.merges[0]).toEqual({ keepId: 't-keep', mergeIds: ['t-lose'] });
  });

  it('records the names of the tags that no longer exist', async () => {
    await service.mergeTags(scope, { keepId: 't-keep', mergeIds: ['t-lose'] });

    const entry = world.audit.find((row) => row['action'] === 'tag.merged');
    // By the time anybody reads the row the losing tags are gone; an entry
    // that says "merged two uuids" answers nothing.
    expect(entry?.['before']).toEqual({ merged: ['dubai-leisure'] });
    expect(entry?.['after']).toMatchObject({ keptTag: 'Dubai', contacts: 912 });
  });

  it('refuses a merge naming an unknown tag, before touching anything', async () => {
    await expect(
      service.mergeTags(scope, { keepId: 't-keep', mergeIds: ['t-elsewhere'] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(world.merges).toEqual([]);
  });

  it('404s a merge whose surviving tag is not ours', async () => {
    await expect(
      service.mergeTags(scope, { keepId: 't-elsewhere', mergeIds: ['t-lose'] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(world.merges).toEqual([]);
  });

  it('renames a tag and audits both names', async () => {
    const tag = await service.renameTag(scope, 't-keep' as TagId, { name: 'Dubai leisure' });

    expect(tag).toMatchObject({ name: 'Dubai leisure', contactCount: 3 });
    const entry = world.audit.find((row) => row['action'] === 'tag.renamed');
    expect(entry?.['before']).toEqual({ name: 'Dubai' });
  });

  it('404s a rename of a tag from another workspace', async () => {
    await expect(
      service.renameTag(scope, 't-elsewhere' as TagId, { name: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/* ------------------------------------------------------------ suppressions */

describe('suppressions', () => {
  it('totals the summary from its own rows rather than a second count', async () => {
    const summary = await service.suppressionSummary(scope);

    // One query, one answer: a separately-counted total can disagree with
    // the reasons printed under it, and D7 shows both on the same card.
    expect(summary.total).toBe(2_318);
    expect(summary.byReason[0]).toEqual({ reason: 'unsubscribe', count: 1_800 });
  });

  it('offers "Any campaign" first, then the campaigns that caused one', async () => {
    expect(await service.suppressionSources(scope)).toEqual([
      { value: 'any', label: 'Any campaign' },
      { value: 'cmp-1', label: 'September newsletter' },
    ]);
  });
});
