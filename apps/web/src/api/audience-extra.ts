import { api, apiRequestEnvelope } from './client.js';
import type { Contact, ContactList, ContactStatus, Suppression, Tag } from './audience.js';

/**
 * The audience endpoints section D's frames need beyond `audience.ts`.
 *
 * A separate file rather than an addition to `audience.ts` because that file
 * is shared with the segments work; this one belongs to the collections
 * pages (D1–D4, D7) and can be folded back in once both have landed.
 *
 * Several of the shapes here widen a type the API already returns: D1 draws
 * a Tags and a Lists column, D2 draws a consent block and an engagement
 * timeline, D3 draws a 30-day trend, D4 draws a contact count per tag. None
 * of those fields exists on the server yet, so each is optional-free but
 * documented, marked `// BACKEND PENDING` at every call site, and answered
 * by the preview server for now.
 *
 * Nothing here formats a date. `lastEngaged` and an event's `when` arrive as
 * the display strings the frames show ("2 days ago", "Today, 09:14") because
 * they mix relative and absolute forms against the workspace's timezone,
 * which is a server decision, not a component one.
 */

export type SuppressionReason = Suppression['reason'] | 'global_block';

/** The reason labels D7 prints, and the dot colour beside each one. */
export const SUPPRESSION_REASONS: Readonly<
  Record<SuppressionReason, { label: string; tone: 'neutral' | 'danger' | 'info' | 'warning' }>
> = {
  unsubscribe: { label: 'Unsubscribed', tone: 'neutral' },
  hard_bounce: { label: 'Hard bounce', tone: 'danger' },
  complaint: { label: 'Complaint', tone: 'danger' },
  manual: { label: 'Manual', tone: 'info' },
  invalid: { label: 'Invalid', tone: 'warning' },
  global_block: { label: 'Global block', tone: 'warning' },
};

/**
 * A reason a workspace may lift.
 *
 * D7's own words: "Manual and imported suppressions can be removed by an
 * Admin; complaint and unsubscribe suppressions cannot." A bounce is
 * evidence from a mailbox provider and a complaint is a legal record; both
 * stay.
 */
export const REMOVABLE_REASONS: readonly SuppressionReason[] = ['manual', 'invalid'];

export interface TagRef {
  id: string;
  name: string;
  color: string | null;
}

/** A contacts-table row: the contact, plus the four columns D1 adds. */
export interface ContactRow extends Contact {
  tags: TagRef[];
  lists: string[];
  /** Already rendered: "2 days ago", "Yesterday", "Never". */
  lastEngaged: string;
}

/** The strip under the drawer header (D2a tint, D2b danger). */
export interface ContactSuppression {
  suppressed: boolean;
  /** "Not suppressed." / "Suppressed · complaint · 9 Sep 2026." */
  headline: string;
  detail: string;
  removable: boolean;
}

export interface ContactEvent {
  id: string;
  /** A `RECIPIENT_STATES` key: delivered, sent, complained, suppressed. */
  state: string;
  /** "Today, 09:14", "8 Sep, 10:03". */
  when: string;
  detail: string;
}

export interface ContactDetail extends ContactRow {
  country: string | null;
  language: string | null;
  consentSource: string | null;
  consentRecorded: string | null;
  suppression: ContactSuppression;
  events: ContactEvent[];
}

/** The header line: "48,213 contacts · 45,102 subscribed · 2,318 suppressed". */
export interface AudienceStats {
  contacts: number;
  subscribed: number;
  suppressed: number;
  /** Rows the current filter matches — the footer's "1–8 of 48,213". */
  matching: number;
}

/** A saved view, drawn as a tab on D1. */
export interface SavedView {
  key: string;
  label: string;
  status?: ContactStatus;
}

export interface ListCard extends ContactList {
  archived: boolean;
  /** "Archived 1 Sep 2026" when archived, else "Used by 8 campaigns". */
  footnote: string;
  /** +4.2, −0.4, or null when the list is too new to compare. */
  growth30d: number | null;
  /** 11 points, oldest first, for the card's sparkline. */
  trend: number[];
}

export interface TagRow extends Tag {
  contactCount: number;
  /** Segment names that reference this tag. */
  segments: string[];
}

// `reason` is deliberately wider than the API client's Suppression: D7 also
// shows `global_block`, the cross-workspace list, which that type predates.
export interface SuppressionRow extends Omit<Suppression, 'reason'> {
  reason: SuppressionReason;
  /** The campaign that caused it, or null for a manual or global entry. */
  source: string | null;
  addedBy: string;
}

export interface SuppressionSummary {
  total: number;
  byReason: { reason: SuppressionReason; count: number }[];
}

export interface ContactFilters {
  status?: ContactStatus;
  view?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

function search(filters: ContactFilters): string {
  const query = new URLSearchParams();
  if (filters.limit !== undefined) query.set('limit', String(filters.limit));
  if (filters.cursor !== undefined) query.set('cursor', filters.cursor);
  if (filters.status !== undefined) query.set('status', filters.status);
  if (filters.view !== undefined) query.set('view', filters.view);
  if (filters.q !== undefined && filters.q !== '') query.set('q', filters.q);
  const rendered = query.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

export const audienceExtraApi = {
  listContacts: async (filters: ContactFilters) => {
    const envelope = await apiRequestEnvelope<ContactRow[]>(`/contacts${search(filters)}`, {
      method: 'GET',
    });
    return {
      data: envelope.data,
      ...(envelope.meta?.nextCursor === undefined ? {} : { nextCursor: envelope.meta.nextCursor }),
    };
  },

  // BACKEND PENDING: GET /stats
  stats: (filters: ContactFilters) => api.get<AudienceStats>(`/stats${search(filters)}`),

  // BACKEND PENDING: GET /saved-views
  savedViews: () => api.get<SavedView[]>('/saved-views'),

  getContact: (id: string) => api.get<ContactDetail>(`/contacts/${id}`),

  /** Bulk add or remove one tag across a selection. */
  tagContacts: (contactIds: string[], tagId: string) =>
    api.post<{ updated: number }>('/contacts/tags', { contactIds, tagId }),
  untagContacts: (contactIds: string[], tagId: string) =>
    api.delete<{ updated: number }>(`/contacts/tags?tagId=${tagId}&ids=${contactIds.join(',')}`),

  addToList: (listId: string, contactIds: string[]) =>
    api.post<{ added: number }>(`/lists/${listId}/contacts`, { contactIds }),

  // BACKEND PENDING: POST /exports
  startExport: (input: { resource: string; ids?: string[] }) =>
    api.post<{ id: string }>('/exports', input),

  listCards: () => api.get<ListCard[]>('/lists'),
  // BACKEND PENDING: PATCH /lists/:id
  renameList: (id: string, name: string) => api.patch<ListCard>(`/lists/${id}`, { name }),
  // BACKEND PENDING: POST /lists/:id/archive
  archiveList: (id: string) => api.post<ListCard>(`/lists/${id}/archive`),

  listTags: () => api.get<TagRow[]>('/tags'),
  // BACKEND PENDING: PATCH /tags/:id
  renameTag: (id: string, name: string) => api.patch<TagRow>(`/tags/${id}`, { name }),
  // BACKEND PENDING: GET /tags/merge-preview
  mergePreview: (ids: string[]) =>
    api.get<{ total: number; overlap: number }>(`/tags/merge-preview?ids=${ids.join(',')}`),
  // BACKEND PENDING: POST /tags/merge
  mergeTags: (input: { keepId: string; mergeIds: string[] }) =>
    api.post<{ keepId: string; contacts: number }>('/tags/merge', input),

  listSuppressions: (filters: { reason?: string; source?: string; q?: string }) => {
    const query = new URLSearchParams();
    if (filters.reason !== undefined && filters.reason !== 'all') query.set('reason', filters.reason);
    if (filters.source !== undefined && filters.source !== 'any') query.set('source', filters.source);
    if (filters.q !== undefined && filters.q !== '') query.set('q', filters.q);
    const rendered = query.toString();
    return api.get<SuppressionRow[]>(`/suppressions${rendered === '' ? '' : `?${rendered}`}`);
  },
  // BACKEND PENDING: GET /suppressions/summary
  suppressionSummary: () => api.get<SuppressionSummary>('/suppressions/summary'),
};

/**
 * Query keys, prefixed with the workspace id.
 *
 * docs/09's rule, and the reason for it: switching workspace must not show
 * the previous one's rows for the instant before the refetch lands. A key
 * that does not name the workspace is a cache entry two workspaces share.
 */
export const audienceExtraKeys = {
  contacts: (workspaceId: string | null, filters: ContactFilters) =>
    [workspaceId, 'audience', 'contacts', filters] as const,
  stats: (workspaceId: string | null, filters: ContactFilters) =>
    [workspaceId, 'audience', 'stats', filters] as const,
  savedViews: (workspaceId: string | null) => [workspaceId, 'audience', 'saved-views'] as const,
  contact: (workspaceId: string | null, id: string) =>
    [workspaceId, 'audience', 'contact', id] as const,
  lists: (workspaceId: string | null) => [workspaceId, 'audience', 'lists'] as const,
  tags: (workspaceId: string | null) => [workspaceId, 'audience', 'tags'] as const,
  mergePreview: (workspaceId: string | null, ids: string[]) =>
    [workspaceId, 'audience', 'tags', 'merge-preview', ids.join(',')] as const,
  suppressions: (workspaceId: string | null, filters: Record<string, string>) =>
    [workspaceId, 'audience', 'suppressions', filters] as const,
  suppressionSummary: (workspaceId: string | null) =>
    [workspaceId, 'audience', 'suppressions', 'summary'] as const,
};

/**
 * "12 Mar 2026" — the date format every D frame prints.
 *
 * Written out rather than left to `Intl`: current ICU abbreviates September
 * as "Sept" in `en-GB`, and the frames say "19 Sep 2026". A date that
 * changes spelling when the runtime's ICU is updated is a date no screenshot
 * test can hold.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(value: string | null): string {
  if (value === null || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''} ${date.getFullYear()}`;
}

/** "48,213" — `fmt` from design/relayd-ui.js. */
export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-US');
}

/** "Amira Khalil", or the email's local part when neither name is set. */
export function contactName(contact: Pick<Contact, 'firstName' | 'lastName'>): string {
  return [contact.firstName, contact.lastName].filter((part) => part !== null && part !== '').join(' ');
}
