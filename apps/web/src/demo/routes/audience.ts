import type { Route, Row } from '../state.js';
import { find, id, nowIso, state } from '../state.js';
import {
  audienceStats,
  contactDetails,
  savedViews,
  suppressionSummary,
} from '../data/audience.js';

/**
 * Section D demo routes: contacts, lists, tags and suppressions.
 *
 * DEMO ONLY. Contacts is the one paged collection here — the page sends a
 * cursor and expects `{ data, meta }` back, which is what `paged: true`
 * selects.
 *
 * The transport hands a handler the *pathname* only, so none of the query
 * filters the pages send (`status`, `view`, `q`, `reason`) can be read here.
 * That is deliberate rather than missing: the frames all draw the unfiltered
 * view, filtering is the server's job in the real API, and a fake that
 * filtered would make the preview disagree with the screenshots it is
 * checked against.
 */

/** A tag, as the contacts table and the drawer draw it. */
interface DemoTag {
  id: string;
  name: string;
  color: string | null;
}

/** D2's generic drawer, for a contact the frames do not draw by hand. */
function detailFor(row: Row): Row {
  const extra = contactDetails[row.id];
  if (extra !== undefined) return { ...row, ...extra };

  const name = [row['firstName'], row['lastName']].filter((part) => part !== null).join(' ');

  return {
    ...row,
    country: null,
    language: null,
    consentSource: 'Imported list',
    consentRecorded: '—',
    suppression: {
      suppressed: row['status'] === 'complained' || row['status'] === 'bounced',
      headline: row['status'] === 'subscribed' ? 'Not suppressed.' : 'Suppressed · provider event.',
      detail:
        row['status'] === 'subscribed'
          ? `Eligible for every campaign that includes ${name}'s lists or segments.`
          : 'Added from a provider event. Cannot be removed.',
      removable: false,
    },
    events: [],
  };
}

export const routes: Route[] = [
  /* ------------------------------------------------------------ contacts -- */

  { method: 'GET', pattern: /^\/stats$/u, handler: () => audienceStats },
  { method: 'GET', pattern: /^\/saved-views$/u, handler: () => savedViews },

  { method: 'GET', pattern: /^\/contacts$/u, handler: () => state.contacts, paged: true },
  { method: 'POST', pattern: /^\/contacts\/tags$/u, handler: (_m, body) => {
    const input = body as { contactIds: string[]; tagId: string };
    const tag = find(state.tags, input.tagId);
    for (const contactId of input.contactIds) {
      const row = find(state.contacts, contactId);
      if (row === undefined || tag === undefined) continue;
      const current = (row['tags'] as DemoTag[] | undefined) ?? [];
      if (!current.some((entry) => entry.id === tag.id)) {
        row['tags'] = [...current, { id: tag.id, name: String(tag['name']), color: (tag['color'] as string | null) ?? null }];
      }
    }
    return { updated: input.contactIds.length };
  } },
  { method: 'DELETE', pattern: /^\/contacts\/tags$/u, handler: () => ({ updated: 0 }) },
  { method: 'POST', pattern: /^\/contacts$/u, handler: (_m, body) => {
    const input = body as { email: string; firstName?: string; lastName?: string };
    const row: Row = {
      id: id('ct_'),
      email: input.email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      status: 'subscribed',
      tags: [],
      lists: [],
      lastEngaged: 'Never',
      attributes: {},
      createdAt: nowIso(),
    };
    state.contacts.unshift(row);
    return row;
  } },
  { method: 'GET', pattern: /^\/contacts\/([^/]+)$/u, handler: (m) => {
    const row = find(state.contacts, m[1] ?? '');
    return row === undefined ? {} : detailFor(row);
  } },
  { method: 'PATCH', pattern: /^\/contacts\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.contacts, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/contacts\/([^/]+)$/u, handler: (m) => {
    state.contacts = state.contacts.filter((row) => row.id !== m[1]);
    return {};
  } },

  { method: 'POST', pattern: /^\/exports$/u, handler: () => ({ id: id('exp_') }) },

  /* --------------------------------------------------------------- lists -- */

  { method: 'GET', pattern: /^\/lists$/u, handler: () => state.lists },
  { method: 'POST', pattern: /^\/lists$/u, handler: (_m, body) => {
    const input = body as { name: string; description?: string };
    const row: Row = {
      id: id('ls_'),
      name: input.name,
      description: input.description ?? null,
      memberCount: 0,
      archived: false,
      footnote: 'Manual',
      growth30d: null,
      trend: [],
      createdAt: nowIso(),
    };
    state.lists.unshift(row);
    return row;
  } },
  { method: 'POST', pattern: /^\/lists\/([^/]+)\/archive$/u, handler: (m) => {
    const row = find(state.lists, m[1] ?? '');
    if (row !== undefined) {
      row['archived'] = true;
      row['footnote'] = 'Archived today';
    }
    return row ?? {};
  } },
  { method: 'POST', pattern: /^\/lists\/([^/]+)\/contacts$/u, handler: (_m, body) => ({
    added: ((body as { contactIds?: string[] }).contactIds ?? []).length,
  }) },
  { method: 'PATCH', pattern: /^\/lists\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.lists, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/lists\/([^/]+)$/u, handler: (m) => {
    state.lists = state.lists.filter((row) => row.id !== m[1]);
    return {};
  } },

  /* ---------------------------------------------------------------- tags -- */

  { method: 'GET', pattern: /^\/tags\/merge-preview$/u, handler: () => ({ total: 13_412, overlap: 634 }) },
  { method: 'POST', pattern: /^\/tags\/merge$/u, handler: (_m, body) => {
    const input = body as { keepId: string; mergeIds: string[] };
    const keep = find(state.tags, input.keepId);
    const merged = input.mergeIds.filter((mergeId) => mergeId !== input.keepId);
    const gained = merged.reduce((total, mergeId) => {
      const row = find(state.tags, mergeId);
      return total + Number(row?.['contactCount'] ?? 0);
    }, 0);

    if (keep !== undefined) keep['contactCount'] = Number(keep['contactCount'] ?? 0) + gained - 634;

    for (const mergeId of merged) {
      const at = state.tags.findIndex((row) => row.id === mergeId);
      if (at >= 0) state.tags.splice(at, 1);
    }

    return { keepId: input.keepId, contacts: Number(keep?.['contactCount'] ?? 0) };
  } },
  { method: 'GET', pattern: /^\/tags$/u, handler: () => state.tags },
  { method: 'POST', pattern: /^\/tags$/u, handler: (_m, body) => {
    const input = body as { name: string; color?: string };
    const row: Row = {
      id: id('tg_'),
      name: input.name,
      color: input.color ?? null,
      contactCount: 0,
      segments: [],
      createdAt: nowIso(),
    };
    state.tags.unshift(row);
    return row;
  } },
  { method: 'PATCH', pattern: /^\/tags\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.tags, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/tags\/([^/]+)$/u, handler: (m) => {
    state.tags = state.tags.filter((row) => row.id !== m[1]);
    return {};
  } },

  /* -------------------------------------------------------- suppressions -- */

  { method: 'GET', pattern: /^\/suppressions\/summary$/u, handler: () => suppressionSummary },
  // D7's Source chip. "Any campaign" first, then the campaigns that have
  // actually produced a suppression — which is what the real endpoint
  // answers, so the chip cannot offer a filter that matches nothing.
  { method: 'GET', pattern: /^\/suppressions\/sources$/u, handler: () => [
    { value: 'any', label: 'Any campaign' },
    ...[...new Set(state.suppressions
      .map((row) => row['source'])
      .filter((name): name is string => typeof name === 'string'))]
      .map((name) => ({ value: name, label: name })),
  ] },
  { method: 'GET', pattern: /^\/suppressions$/u, handler: () => state.suppressions },
  { method: 'POST', pattern: /^\/suppressions$/u, handler: (_m, body) => {
    const input = body as { email: string; reason?: string; notes?: string };
    const row: Row = {
      id: id('sp'),
      email: input.email,
      reason: input.reason ?? 'manual',
      notes: input.notes ?? null,
      source: null,
      addedBy: 'Dana Haddad',
      createdAt: nowIso(),
    };
    state.suppressions.unshift(row);
    return row;
  } },
  { method: 'DELETE', pattern: /^\/suppressions\/([^/]+)$/u, handler: (m) => {
    state.suppressions = state.suppressions.filter((row) => row.id !== m[1]);
    return {};
  } },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/audience/contacts',
  '/audience/contacts/ct_amira',
  '/audience/lists',
  '/audience/tags',
  '/audience/suppressions',
];
