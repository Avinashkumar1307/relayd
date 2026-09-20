import type { Route, Row } from '../state.js';
import { clone, collection, find, id, nowIso, state } from '../state.js';
import {
  AUDIT_TOTAL,
  auditActions,
  auditEvents,
  invitations as invitationSeed,
  profile as profileSeed,
  sessions as sessionSeed,
} from '../data/workspace.js';

/**
 * Section J demo routes: the workspace record, its people, your own account
 * and the audit log.
 *
 * DEMO ONLY.
 *
 * Half of what these answer does not exist on the server yet — there is no
 * `/me`, no session list and no `/audit-logs` router — which is exactly why
 * they are here: the J frames are reviewable against the preview before a
 * line of backend is written, and each page carries a `BACKEND PENDING`
 * marker at the call site so nobody mistakes the preview for the product.
 *
 * ## Seeing the states the frames draw
 *
 * J6e and J6f are the audit log with nothing in it and the audit log
 * failing. The demo transport matches on the path and only ever answers
 * 200, so the empty one is reachable through the SPA's own query string and
 * the failing one is not:
 *
 *   /settings/audit?demo=empty       J6e
 *
 * J6f is covered by the unit test that renders it, which is the honest way
 * to see a state the transport cannot produce.
 */

const invitations = (): Row[] => collection('invitations', () => invitationSeed);
const sessions = (): Row[] => collection('sessions', () => sessionSeed);
const profile = (): Row[] => collection('profile', () => [profileSeed]);

function variant(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') ?? '';
  } catch {
    return '';
  }
}

/** The SPA's own query string is where the audit filters live. */
function filters(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

/** The frozen clock, so "Last 30 days" means the same thing every run. */
const NOW = new Date('2026-09-19T12:00:00.000Z').getTime();
const DAYS: Readonly<Record<string, number>> = { last_7: 7, last_30: 30, last_90: 90 };

function matchingEvents(): Row[] {
  if (variant() === 'empty') return [];

  const query = filters();
  const actor = query.get('actor');
  const action = query.get('action');
  const resource = query.get('resource');
  const text = (query.get('q') ?? '').toLowerCase();
  const days = DAYS[query.get('range') ?? 'last_30'];

  return clone(auditEvents).filter((event) => {
    const row = event as unknown as {
      actor: { name: string };
      action: string;
      resource: string | null;
      details: string;
      occurredAt: string;
    };

    if (actor !== null && actor !== '' && row.actor.name !== actor) return false;
    if (action !== null && action !== '' && row.action !== action) return false;
    if (resource !== null && resource !== '' && row.resource !== resource) return false;
    if (text !== '' && !`${row.details} ${row.action}`.toLowerCase().includes(text)) return false;
    if (days !== undefined && NOW - new Date(row.occurredAt).getTime() > days * 86_400_000) return false;

    return true;
  });
}

export const routes: Route[] = [
  /* ---- the workspace record ---------------------------------------- */

  {
    method: 'GET',
    pattern: /^\/workspaces\/current$/u,
    handler: () => state.workspace,
  },
  {
    method: 'PATCH',
    pattern: /^\/workspaces\/current$/u,
    handler: (_m, body) => {
      Object.assign(state.workspace, body as object);
      return state.workspace;
    },
  },
  { method: 'DELETE', pattern: /^\/workspaces\/current$/u, handler: () => ({}) },
  {
    method: 'POST',
    pattern: /^\/workspaces\/current\/transfer-ownership$/u,
    handler: () => ({ ok: true }),
  },

  /* ---- members ------------------------------------------------------ */

  { method: 'GET', pattern: /^\/workspaces\/current\/members$/u, handler: () => state.team },
  {
    method: 'PATCH',
    pattern: /^\/workspaces\/current\/members\/([^/]+)$/u,
    handler: (match, body) => {
      const row = state.team.find((member) => member['userId'] === match[1]);
      if (row !== undefined) Object.assign(row, body as object);
      return row ?? {};
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/workspaces\/current\/members\/([^/]+)$/u,
    handler: (match) => {
      const at = state.team.findIndex((member) => member['userId'] === match[1]);
      if (at >= 0) state.team.splice(at, 1);
      return {};
    },
  },

  /* ---- invitations -------------------------------------------------- */

  { method: 'GET', pattern: /^\/workspaces\/current\/invitations$/u, handler: () => invitations() },
  {
    method: 'POST',
    pattern: /^\/workspaces\/current\/invitations\/([^/]+)\/resend$/u,
    handler: (match) => find(invitations(), match[1] ?? '') ?? {},
  },
  {
    method: 'POST',
    pattern: /^\/workspaces\/current\/invitations$/u,
    handler: (_m, body) => {
      const input = body as { email?: string; role?: string } | undefined;
      const row: Row = {
        id: id('inv'),
        email: input?.email ?? 'someone@example.com',
        role: input?.role ?? 'editor',
        invitedByName: 'Dana Haddad',
        expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
        createdAt: nowIso(),
      };
      invitations().push(row);
      return row;
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/workspaces\/current\/invitations\/([^/]+)$/u,
    handler: (match) => {
      const rows = invitations();
      const at = rows.findIndex((row) => row.id === match[1]);
      if (at >= 0) rows.splice(at, 1);
      return {};
    },
  },

  /* ---- the signed-in account (J5) ----------------------------------- */

  { method: 'GET', pattern: /^\/me$/u, handler: () => profile()[0] },
  {
    method: 'PATCH',
    pattern: /^\/me$/u,
    handler: (_m, body) => {
      const row = profile()[0];
      if (row !== undefined) Object.assign(row, body as object);
      return row ?? {};
    },
  },
  { method: 'POST', pattern: /^\/me\/password$/u, handler: () => ({ ok: true }) },
  { method: 'GET', pattern: /^\/me\/sessions$/u, handler: () => sessions() },
  {
    method: 'DELETE',
    pattern: /^\/me\/sessions\/([^/]+)$/u,
    handler: (match) => {
      const rows = sessions();
      const at = rows.findIndex((row) => row.id === match[1]);
      if (at >= 0) rows.splice(at, 1);
      return {};
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/me\/sessions$/u,
    handler: () => {
      const rows = sessions();
      const kept = rows.filter((row) => row['current'] === true);
      rows.length = 0;
      rows.push(...kept);
      return {};
    },
  },

  /* ---- the audit log (J6) ------------------------------------------- */

  {
    method: 'GET',
    pattern: /^\/audit-logs\/filters$/u,
    handler: () => ({
      // The picker's value is the actor's name: the demo has no stable
      // actor id for "Relayd", and the frame's chip shows the name anyway.
      actors: [
        ...state.team.map((member) => ({ id: member['name'], name: member['name'] })),
        { id: 'Relayd', name: 'Relayd' },
      ],
      actions: auditActions,
    }),
  },
  {
    method: 'GET',
    pattern: /^\/audit-logs$/u,
    handler: () => {
      const matched = matchingEvents();
      const query = filters();
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const start = (page - 1) * 10;
      const unfiltered = matched.length === auditEvents.length;

      // J6's footer reads "1–10 of 3,412 events" and there are ten
      // fixtures. Unfiltered, the demo reports the frame's total and hands
      // back the same ten rows on every page — the thing worth seeing is
      // that the count and the pager come from the server's number and not
      // from `rows.length`. Filtered, both are honest.
      return {
        events: unfiltered ? matched : matched.slice(start, start + 10),
        total: unfiltered ? AUDIT_TOTAL : matched.length,
      };
    },
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/settings/workspace',
  '/settings/team',
  '/settings/team/permissions',
  '/settings/profile',
  '/settings/audit',
];
