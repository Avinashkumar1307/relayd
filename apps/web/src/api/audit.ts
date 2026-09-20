import { api } from './client.js';

/**
 * The audit log (section J, frame J6).
 *
 * Served by `apps/api/src/routes/audit.ts`.
 *
 * The page asks for a page of events and a total, not a cursor: J6's footer
 * reads "1–10 of 3,412 events", and a cursor cannot say how many there are.
 * So the response carries `total` in `data` rather than in the envelope's
 * `meta`, which only models `hasMore` and `nextCursor`. The API also accepts
 * `?cursor=` and returns `meta.nextCursor`, which is the form docs/03
 * documents; this page uses the numbered one its footer needs.
 */

export type AuditActorKind = 'user' | 'system' | 'api_key';

export interface AuditActor {
  kind: AuditActorKind;
  /** "Dana Haddad", "Relayd", "Deploy key". */
  name: string;
  /** "DH", "R". */
  initials: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actor: AuditActor;
  /** The dotted event name: `campaign.launched`. */
  action: string;
  /** The object it happened to: `cmp_8f3k2a`. Null for workspace-wide events. */
  resource: string | null;
  details: string;
}

export interface AuditPage {
  events: AuditEvent[];
  total: number;
}

/** What the Actor and Action pickers offer. */
export interface AuditFilterOptions {
  actors: { id: string; name: string }[];
  actions: string[];
}

export type AuditRange = 'last_7' | 'last_30' | 'last_90' | 'all';

export const AUDIT_RANGES: readonly { value: AuditRange; label: string }[] = [
  { value: 'last_7', label: 'Last 7 days' },
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

export interface AuditQuery {
  actor?: string | undefined;
  action?: string | undefined;
  resource?: string | undefined;
  range?: AuditRange | undefined;
  q?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export const auditKeys = {
  all: (workspaceId: string) => ['audit', workspaceId] as const,
  list: (workspaceId: string, query: AuditQuery) => ['audit', workspaceId, 'list', query] as const,
  options: (workspaceId: string) => ['audit', workspaceId, 'options'] as const,
};

export const auditApi = {
  list: (query: AuditQuery) =>
    api.get<AuditPage>('/audit-logs', {
      ...(query.actor === undefined ? {} : { actor: query.actor }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.resource === undefined ? {} : { resource: query.resource }),
      ...(query.range === undefined ? {} : { range: query.range }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    }),

  options: () => api.get<AuditFilterOptions>('/audit-logs/filters'),
};

/** J6's "Export CSV". Streamed by the API, escaped against formula injection. */
export function auditCsvHref(query: AuditQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const rendered = params.toString();
  return `/api/v1/audit-logs.csv${rendered === '' ? '' : `?${rendered}`}`;
}
