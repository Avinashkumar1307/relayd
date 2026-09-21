import type { Route, Row } from '../state.js';
import { find, id, nowIso, state } from '../state.js';
import { progress, recipients, timelines } from '../data/campaigns.js';

/**
 * Section G demo routes: campaigns and the send-time controls on them.
 *
 * DEMO ONLY. Launch, pause, resume and cancel move the stored status so the
 * list, the wizard and the detail page agree afterwards; the counters come
 * from a fixture rather than being simulated, so the numbers hold still while
 * a screen is being read against its frame.
 *
 * Order matters inside this file and only inside it: `/campaigns/:id` is a
 * prefix of `/campaigns/:id/progress`, so the bare pattern is declared last.
 */

const EMPTY_PROGRESS = {
  total: 0,
  pending: 0,
  queued: 0,
  sending: 0,
  sent: 0,
  failed: 0,
  suppressed: 0,
  uncertain: 0,
  outstanding: 0,
  complete: false,
  deliveryUncertain: 0,
  counts: {},
  clicks: null,
  openRate: null,
};

export const routes: Route[] = [
  { method: 'POST', pattern: /^\/campaigns\/audience-preview$/u, handler: (_m, body) => {
    const input = body as { listIds?: string[]; segmentIds?: string[]; excludeListIds?: string[] };
    const picked = (input.listIds?.length ?? 0) + (input.segmentIds?.length ?? 0);
    if (picked === 0) return { eligible: 0, suppressed: 0, total: 0 };

    // The G2s2 arithmetic: 51,864 included, 6,224 overlap, 1,900 excluded,
    // 2,318 suppressed — 41,422 estimated.
    const included = 51_864;
    const excluded = (input.excludeListIds?.length ?? 0) > 0 ? 1_900 : 0;
    const suppressed = 2_318;
    return { eligible: included - 6_224 - excluded - suppressed, suppressed, total: included };
  } },

  { method: 'GET', pattern: /^\/campaigns$/u, handler: (_m, _b) => ({
    items: state.campaigns,
    nextCursor: null,
  }) },

  { method: 'POST', pattern: /^\/campaigns$/u, handler: (_m, body) => {
    const input = body as { name: string };
    const row: Row = {
      id: id('cmp_'), name: input.name, status: 'draft', subjectOverride: null,
      templateVersionId: null, senderAccountId: null, sendingPoolId: null, audience: {},
      scheduledAt: null, timezone: 'Asia/Dubai', recipientCount: 0, launchedAt: null,
      completedAt: null, createdAt: nowIso(), updatedAt: nowIso(),
      counts: {}, clicks: null, whenLabel: 'Edited just now', senderLabel: '—',
      note: null, metaLabel: 'Draft · created just now', hold: null,
    };
    state.campaigns.unshift(row);
    return row;
  } },

  { method: 'GET', pattern: /^\/campaigns\/([^/]+)\/progress$/u, handler: (m) =>
    (progress[m[1] ?? ''] as unknown) ?? EMPTY_PROGRESS },

  { method: 'GET', pattern: /^\/campaigns\/([^/]+)\/recipients$/u, handler: (_m, _b) => ({
    items: recipients,
    nextCursor: null,
  }) },

  { method: 'GET', pattern: /^\/campaigns\/([^/]+)\/timeline$/u, handler: (m) =>
    timelines[m[1] ?? ''] ?? [] },

  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/launch$/u, handler: (m) => {
    const row = find(state.campaigns, m[1] ?? '');
    if (row !== undefined) {
      row['status'] = 'sending';
      row['launchedAt'] = nowIso();
      row['recipientCount'] = 41_422;
      row['whenLabel'] = 'Started just now';
    }
    return { ok: true, recipientCount: 41_422, suppressedAtSnapshot: 2_318 };
  } },

  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/(pause|resume|cancel)$/u, handler: (m) => {
    const row = find(state.campaigns, m[1] ?? '');
    const next = m[2] === 'pause' ? 'paused' : m[2] === 'resume' ? 'sending' : 'cancelled';
    if (row !== undefined) row['status'] = next;
    return { state: next };
  } },

  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/schedule$/u, handler: (m, body) => {
    const row = find(state.campaigns, m[1] ?? '');
    if (row !== undefined) {
      row['status'] = 'scheduled';
      row['scheduledAt'] = (body as { scheduledAt?: string })?.scheduledAt ?? nowIso();
      row['whenLabel'] = 'Scheduled';
    }
    return row ?? {};
  } },

  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/test-send$/u, handler: () => ({ queued: 1 }) },

  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/retry-failed$/u, handler: () => ({
    retried: 28,
    excluded: { hard_bounce: 3 },
  }) },

  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/clone$/u, handler: (m) => {
    const source = find(state.campaigns, m[1] ?? '');
    const row: Row = {
      ...(source ?? {}),
      id: id('cmp_'),
      name: `${String(source?.['name'] ?? 'Campaign')} (copy)`,
      status: 'draft',
      launchedAt: null,
      completedAt: null,
      scheduledAt: null,
      recipientCount: 0,
      counts: {},
      clicks: null,
      whenLabel: 'Edited just now',
      note: null,
      hold: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.campaigns.unshift(row);
    return row;
  } },

  // G1's Archive action. The real route answers with the campaign row and
  // 409s on one that is still running; the preview only has to agree about
  // the shape.
  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/(archive|unarchive)$/u, handler: (m) => {
    const row = find(state.campaigns, m[1] ?? '');
    if (row !== undefined) {
      row['archivedAt'] = m[2] === 'archive' ? nowIso() : null;
      row['updatedAt'] = nowIso();
    }
    return row ?? {};
  } },

  { method: 'PATCH', pattern: /^\/campaigns\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.campaigns, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object, { updatedAt: nowIso() });
    return row ?? {};
  } },

  { method: 'DELETE', pattern: /^\/campaigns\/([^/]+)$/u, handler: (m) => {
    const at = state.campaigns.findIndex((row) => row.id === m[1]);
    if (at !== -1) state.campaigns.splice(at, 1);
    return {};
  } },

  { method: 'GET', pattern: /^\/campaigns\/([^/]+)$/u, handler: (m) => ({
    campaign: find(state.campaigns, m[1] ?? '') ?? state.campaigns[0],
    counters: (progress[m[1] ?? ''] as unknown) ?? null,
  }) },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/campaigns',
  '/campaigns/new',
  '/campaigns/cmp_8f3k2a',
  '/campaigns/cmp_3h7t6w',
  '/campaigns/cmp_6r9s2e',
  '/campaigns/cmp_9k4p1r/edit/details',
  '/campaigns/cmp_9k4p1r/edit/audience',
  '/campaigns/cmp_9k4p1r/edit/sender',
  '/campaigns/cmp_9k4p1r/edit/content',
  '/campaigns/cmp_9k4p1r/edit/tracking',
  '/campaigns/cmp_9k4p1r/edit/schedule',
  '/campaigns/cmp_9k4p1r/edit/review',
];
