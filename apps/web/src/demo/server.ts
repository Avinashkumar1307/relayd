import * as fixtures from './fixtures.js';

/**
 * A fake backend for the UI preview.
 *
 * DEMO ONLY — loaded only when `VITE_DEMO=1`, on the `demo/ui-preview`
 * branch, which is not meant to be merged.
 *
 * It replaces `window.fetch` and answers `/api/v1/*` from `fixtures.ts`.
 * Everything else falls through to the real fetch, so Vite's own requests
 * still work.
 *
 * ## The paths and shapes here are read off the client, not guessed
 *
 * That matters more than it sounds. The first version of this file invented
 * `/billing/overview` and `{ contacts: [...] }` — both plausible, both
 * wrong — and the pages rendered their empty and error states instead of
 * the screens. `apps/web/test/demo-smoke.test.tsx` renders every page
 * against this server and fails on any unrouted request, which is what
 * catches that.
 *
 * Two envelope shapes exist and they are not interchangeable:
 *   most routes answer `{ data }`
 *   paged routes answer `{ data, meta }` — marked `paged: true` below
 *
 * Mutations apply to in-memory copies, so the flow is clickable: creating a
 * list adds a row, revoking a key greys it out, launching a campaign moves
 * it to `sending`. Reload and it all goes back.
 */

interface Route {
  method: string;
  /** Matched against the path after `/api/v1`. */
  pattern: RegExp;
  handler: (match: RegExpMatchArray, body: unknown) => unknown;
  /** Answer with the list envelope (`data` + `meta`) rather than `{ data }`. */
  paged?: boolean;
}

/**
 * A demo row.
 *
 * Deliberately loose. The fixtures are object literals, so TypeScript infers
 * the narrowest possible type from each — `color: string` from one entry
 * that happens to be non-null — and every mutation below would then need a
 * cast. The real types live in `src/api/*.ts` and are what the pages are
 * checked against; this harness only has to hand back plausible JSON.
 */
type Row = Record<string, unknown> & { id: string };

/** Deep copies, so a mutation cannot corrupt the fixture for the next reload. */
const clone = (value: unknown): Row[] => JSON.parse(JSON.stringify(value)) as Row[];

interface DemoState {
  contacts: Row[];
  lists: Row[];
  tags: Row[];
  suppressions: Row[];
  imports: Row[];
  templates: Row[];
  campaigns: Row[];
  connections: Row[];
  senders: Row[];
  apiKeys: Row[];
  webhookEndpoints: Row[];
  team: Row[];
  workspace: Row;
}

const state: DemoState = {
  contacts: clone(fixtures.contacts),
  lists: clone(fixtures.lists),
  tags: clone(fixtures.tags),
  suppressions: clone(fixtures.suppressions),
  imports: clone(fixtures.imports),
  templates: clone(fixtures.templates),
  campaigns: clone(fixtures.campaigns),
  connections: clone(fixtures.connections),
  senders: clone(fixtures.senders),
  apiKeys: clone(fixtures.apiKeys),
  webhookEndpoints: clone(fixtures.webhookEndpoints),
  team: clone(fixtures.team),
  workspace: JSON.parse(JSON.stringify(fixtures.workspace)) as Row,
};

let nextId = 1000;
const id = (prefix: string): string => `${prefix}${(nextId += 1)}`;
const nowIso = (): string => new Date().toISOString();

const find = (rows: Row[], wanted: string): Row | undefined =>
  rows.find((row) => row.id === wanted);

const ROUTES: Route[] = [
  // ------------------------------------------------------------------ auth
  { method: 'POST', pattern: /^\/auth\/(login|register|refresh)$/u, handler: () => fixtures.session },
  { method: 'POST', pattern: /^\/auth\/logout$/u, handler: () => ({}) },
  { method: 'POST', pattern: /^\/auth\/(forgot-password|reset-password|verify-email|resend-verification)$/u, handler: () => ({ ok: true }) },
  { method: 'GET', pattern: /^\/auth\/sessions$/u, handler: () => [
    { id: 'sess1', userAgent: 'Chrome on Windows', ip: '203.0.113.4', current: true, createdAt: nowIso(), lastSeenAt: nowIso() },
  ] },

  // ------------------------------------------------------------ workspaces
  { method: 'GET', pattern: /^\/workspaces\/current\/members$/u, handler: () => state.team },
  { method: 'GET', pattern: /^\/workspaces\/current\/invitations$/u, handler: () => [
    { id: 'inv1', email: 'newhire@northwind.example', role: 'editor', expiresAt: nowIso(), createdAt: nowIso() },
  ] },
  { method: 'POST', pattern: /^\/workspaces\/current\/invitations$/u, handler: (_m, body) => ({
    id: id('inv'),
    email: (body as { email?: string })?.email ?? 'someone@example.com',
    role: (body as { role?: string })?.role ?? 'editor',
    expiresAt: nowIso(),
    createdAt: nowIso(),
  }) },
  { method: 'DELETE', pattern: /^\/workspaces\/current\/invitations\/([^/]+)$/u, handler: () => ({}) },
  { method: 'PATCH', pattern: /^\/workspaces\/current\/members\/([^/]+)$/u, handler: (m, body) => {
    const row = state.team.find((entry) => entry['userId'] === m[1]);
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'GET', pattern: /^\/workspaces\/current$/u, handler: () => state.workspace },
  { method: 'PATCH', pattern: /^\/workspaces\/current$/u, handler: (_m, body) => {
    Object.assign(state.workspace, body as object);
    return state.workspace;
  } },

  // -------------------------------------------------------------- audience
  { method: 'GET', pattern: /^\/audience\/contacts$/u, handler: () => state.contacts, paged: true },
  { method: 'POST', pattern: /^\/audience\/contacts$/u, handler: (_m, body) => {
    const input = body as { email: string; firstName?: string; lastName?: string };
    const row: Row = { id: id('c'), email: input.email, firstName: input.firstName ?? null, lastName: input.lastName ?? null, status: 'subscribed', attributes: {}, createdAt: nowIso() };
    state.contacts.unshift(row);
    return row;
  } },
  { method: 'PATCH', pattern: /^\/audience\/contacts\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.contacts, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/audience\/contacts\/([^/]+)$/u, handler: (m) => {
    state.contacts = state.contacts.filter((row) => row.id !== m[1]);
    return {};
  } },

  { method: 'GET', pattern: /^\/audience\/lists$/u, handler: () => state.lists },
  { method: 'POST', pattern: /^\/audience\/lists$/u, handler: (_m, body) => {
    const input = body as { name: string; description?: string };
    const row: Row = { id: id('l'), name: input.name, description: input.description ?? null, memberCount: 0, createdAt: nowIso() };
    state.lists.unshift(row);
    return row;
  } },
  { method: 'DELETE', pattern: /^\/audience\/lists\/([^/]+)$/u, handler: (m) => {
    state.lists = state.lists.filter((row) => row.id !== m[1]);
    return {};
  } },

  { method: 'GET', pattern: /^\/audience\/tags$/u, handler: () => state.tags },
  { method: 'POST', pattern: /^\/audience\/tags$/u, handler: (_m, body) => {
    const input = body as { name: string; color?: string };
    const row: Row = { id: id('t'), name: input.name, color: input.color ?? null, createdAt: nowIso() };
    state.tags.unshift(row);
    return row;
  } },
  { method: 'DELETE', pattern: /^\/audience\/tags\/([^/]+)$/u, handler: (m) => {
    state.tags = state.tags.filter((row) => row.id !== m[1]);
    return {};
  } },

  { method: 'GET', pattern: /^\/audience\/suppressions$/u, handler: () => state.suppressions },
  { method: 'POST', pattern: /^\/audience\/suppressions$/u, handler: (_m, body) => {
    const input = body as { email: string; reason?: string; notes?: string };
    const row: Row = { id: id('s'), email: input.email, reason: input.reason ?? 'manual', notes: input.notes ?? null, createdAt: nowIso() };
    state.suppressions.unshift(row);
    return row;
  } },
  { method: 'DELETE', pattern: /^\/audience\/suppressions\/([^/]+)$/u, handler: (m) => {
    state.suppressions = state.suppressions.filter((row) => row.id !== m[1]);
    return {};
  } },

  { method: 'GET', pattern: /^\/audience\/imports$/u, handler: () => state.imports },
  { method: 'GET', pattern: /^\/audience\/imports\/([^/]+)\/errors$/u, handler: () => [
    { rowNumber: 14, email: 'not-an-email', errorCode: 'invalid_email', message: 'not-an-email is not a valid address' },
  ] },
  { method: 'GET', pattern: /^\/audience\/imports\/([^/]+)$/u, handler: (m) => find(state.imports, m[1] ?? '') ?? state.imports[0] },
  { method: 'POST', pattern: /^\/audience\/imports\/([^/]+)\/mapping$/u, handler: (m) => {
    const row = find(state.imports, m[1] ?? '');
    if (row !== undefined) row['status'] = 'validating';
    return row ?? {};
  } },
  { method: 'POST', pattern: /^\/audience\/imports\/([^/]+)\/cancel$/u, handler: (m) => {
    const row = find(state.imports, m[1] ?? '');
    if (row !== undefined) row['status'] = 'cancelled';
    return row ?? {};
  } },
  { method: 'POST', pattern: /^\/audience\/imports$/u, handler: (_m, body) => {
    const input = body as { filename: string; fileType: string };
    const job: Row = { id: id('i'), originalFilename: input.filename, fileType: input.fileType, status: 'pending', columnMapping: null, totalRows: null, processedRows: 0, createdCount: 0, updatedCount: 0, skippedCount: 0, failedCount: 0, createdAt: nowIso(), completedAt: null };
    state.imports.unshift(job);
    return { id: job.id, status: 'pending', upload: { url: 'https://example.invalid/upload?signed=1', expiresInSeconds: 900 } };
  } },

  // ------------------------------------------------------------- templates
  { method: 'GET', pattern: /^\/templates$/u, handler: () => state.templates },
  { method: 'POST', pattern: /^\/templates$/u, handler: (_m, body) => {
    const input = body as { name: string; category?: string };
    const template: Row = { id: id('tpl'), name: input.name, category: input.category ?? null, currentVersionId: 'v1', createdAt: nowIso(), updatedAt: nowIso() };
    state.templates.unshift(template);
    return { template, version: fixtures.templateVersion, removed: [] };
  } },
  { method: 'POST', pattern: /^\/templates\/versions\/([^/]+)\/preview$/u, handler: () => ({
    subject: 'Autumn blend is here, Aisha',
    html: fixtures.templateVersion.htmlCompiled.replace('{{ contact.firstName | default: "there" }}', 'Aisha'),
    text: fixtures.templateVersion.textBody,
    templateVersionId: 'v1',
    version: 4,
    published: true,
  }) },
  { method: 'POST', pattern: /^\/templates\/versions\/([^/]+)\/publish$/u, handler: () => ({ ...fixtures.templateVersion, publishedAt: nowIso() }) },
  { method: 'POST', pattern: /^\/templates\/([^/]+)\/versions$/u, handler: () => ({ version: fixtures.templateVersion, removed: [] }) },
  { method: 'PATCH', pattern: /^\/templates\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.templates, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/templates\/([^/]+)$/u, handler: (m) => {
    state.templates = state.templates.filter((row) => row.id !== m[1]);
    return {};
  } },
  { method: 'GET', pattern: /^\/templates\/([^/]+)$/u, handler: (m) => ({
    template: find(state.templates, m[1] ?? '') ?? state.templates[0],
    versions: [fixtures.templateVersion],
  }) },

  // ------------------------------------------------------------- campaigns
  { method: 'POST', pattern: /^\/campaigns\/audience-preview$/u, handler: () => ({ eligible: 18_402, suppressed: 214, total: 18_616 }) },
  { method: 'GET', pattern: /^\/campaigns$/u, handler: () => ({ items: state.campaigns, nextCursor: null }) },
  { method: 'POST', pattern: /^\/campaigns$/u, handler: (_m, body) => {
    const input = body as { name: string };
    const row: Row = { id: id('cmp'), name: input.name, status: 'draft', subjectOverride: null, templateVersionId: null, senderAccountId: null, sendingPoolId: null, audience: {}, scheduledAt: null, timezone: null, recipientCount: 0, launchedAt: null, completedAt: null, createdAt: nowIso(), updatedAt: nowIso() };
    state.campaigns.unshift(row);
    return row;
  } },
  { method: 'GET', pattern: /^\/campaigns\/([^/]+)\/progress$/u, handler: (m) =>
    (fixtures.progress[m[1] ?? ''] as unknown) ??
    { total: 0, pending: 0, queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0, uncertain: 0, outstanding: 0, complete: false, deliveryUncertain: 0 } },
  { method: 'GET', pattern: /^\/campaigns\/([^/]+)\/recipients$/u, handler: () => ({ items: fixtures.recipients, nextCursor: null }) },
  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/launch$/u, handler: (m) => {
    const row = find(state.campaigns, m[1] ?? '');
    if (row !== undefined) {
      row['status'] = 'sending';
      row['launchedAt'] = nowIso();
      row['recipientCount'] = 18_402;
    }
    return { ok: true, recipientCount: 18_402, suppressedAtSnapshot: 214 };
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
    }
    return row ?? {};
  } },
  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/test-send$/u, handler: () => ({ queued: 1 }) },
  { method: 'POST', pattern: /^\/campaigns\/([^/]+)\/retry-failed$/u, handler: () => ({ retried: 28, excluded: { hard_bounce: 3 } }) },
  { method: 'PATCH', pattern: /^\/campaigns\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.campaigns, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/campaigns\/([^/]+)$/u, handler: (m) => {
    state.campaigns = state.campaigns.filter((row) => row.id !== m[1]);
    return {};
  } },
  { method: 'GET', pattern: /^\/campaigns\/([^/]+)$/u, handler: (m) => ({
    campaign: find(state.campaigns, m[1] ?? '') ?? state.campaigns[0],
    counters: (fixtures.progress[m[1] ?? ''] as unknown) ?? null,
  }) },

  { method: 'GET', pattern: /^\/pools$/u, handler: () => [] },
  { method: 'GET', pattern: /^\/pools\/([^/]+)\/health$/u, handler: () => ({ members: [] }) },

  // ------------------------------------------------------------- analytics
  { method: 'GET', pattern: /^\/analytics\/overview$/u, handler: () => fixtures.overview },
  { method: 'GET', pattern: /^\/analytics\/campaigns\/([^/]+)\/links$/u, handler: () => ({ links: fixtures.links }) },
  { method: 'GET', pattern: /^\/analytics\/campaigns\/([^/]+)\/devices$/u, handler: () => fixtures.devices },
  { method: 'GET', pattern: /^\/analytics\/campaigns\/([^/]+)$/u, handler: () => fixtures.campaignAnalytics },

  // ------------------------------------------------------------- providers
  { method: 'GET', pattern: /^\/providers$/u, handler: () => state.connections },
  { method: 'POST', pattern: /^\/providers$/u, handler: (_m, body) => {
    const input = body as { name: string; providerType: string };
    const row: Row = { id: id('pr'), providerType: input.providerType, name: input.name, status: 'active', hasWebhookSecret: true, lastVerifiedAt: nowIso(), lastError: null, quotaSnapshot: { dailyQuota: 50_000, sentLast24h: 0, sendRate: 14 }, capabilities: { templates: false, scheduling: false, batchSend: true }, createdAt: nowIso() };
    state.connections.unshift(row);
    return { ...row, ingestUrl: `https://demo.relayd.test/ingest/v1/${input.providerType}/${id('tok')}`, warnings: [] };
  } },
  { method: 'GET', pattern: /^\/providers\/([^/]+)\/identities$/u, handler: (m) => fixtures.identities.filter((row) => row.providerId === m[1]) },
  { method: 'POST', pattern: /^\/providers\/([^/]+)\/identities\/sync$/u, handler: (m) => fixtures.identities.filter((row) => row.providerId === m[1]) },
  { method: 'POST', pattern: /^\/providers\/([^/]+)\/(verify|rotate)$/u, handler: (m) => {
    const row = find(state.connections, m[1] ?? '');
    if (row !== undefined && m[2] === 'verify') {
      row['status'] = 'active';
      row['lastVerifiedAt'] = nowIso();
      row['lastError'] = null;
    }
    return row ?? {};
  } },
  { method: 'PATCH', pattern: /^\/providers\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.connections, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/providers\/([^/]+)$/u, handler: (m) => {
    state.connections = state.connections.filter((row) => row.id !== m[1]);
    return {};
  } },
  { method: 'GET', pattern: /^\/providers\/([^/]+)$/u, handler: (m) => find(state.connections, m[1] ?? '') ?? state.connections[0] },

  { method: 'GET', pattern: /^\/senders$/u, handler: () => state.senders },
  { method: 'POST', pattern: /^\/senders\/([^/]+)\/test$/u, handler: () => ({ ok: true, messageId: 'demo-message-id' }) },
  { method: 'POST', pattern: /^\/senders$/u, handler: (_m, body) => {
    const input = body as { fromEmail: string; fromName: string; providerId: string };
    const row: Row = { id: id('snd'), providerId: input.providerId, identityId: 'id1', fromEmail: input.fromEmail, fromName: input.fromName, replyTo: null, status: 'active', dailyLimit: null, hourlyLimit: null, healthScore: 100, consecutiveFailures: 0, cooldownUntil: null, lastSendAt: null };
    state.senders.unshift(row);
    return row;
  } },
  { method: 'PATCH', pattern: /^\/senders\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.senders, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/senders\/([^/]+)$/u, handler: (m) => {
    state.senders = state.senders.filter((row) => row.id !== m[1]);
    return {};
  } },

  // --------------------------------------------------------------- billing
  { method: 'GET', pattern: /^\/billing\/plans$/u, handler: () => fixtures.plans },
  { method: 'GET', pattern: /^\/billing\/usage$/u, handler: () => fixtures.billingOverview.usage },
  { method: 'GET', pattern: /^\/billing\/invoices$/u, handler: () => fixtures.invoices },
  { method: 'GET', pattern: /^\/billing\/checkout\/status$/u, handler: () => ({ ready: true, subscription: fixtures.billingOverview.subscription }) },
  { method: 'POST', pattern: /^\/billing\/checkout$/u, handler: () => ({ id: 'cs_demo', url: '/billing/success?demo=1', expiresAt: nowIso() }) },
  { method: 'POST', pattern: /^\/billing\/portal$/u, handler: () => ({ url: '/billing?demo=portal' }) },
  { method: 'GET', pattern: /^\/billing\/plan-change\/preview$/u, handler: () => ({ conflicts: [], prorationAmount: 1_240, currency: 'gbp', effectiveAt: nowIso() }) },
  { method: 'POST', pattern: /^\/billing\/plan-change$/u, handler: () => ({ ok: true }) },
  { method: 'POST', pattern: /^\/billing\/cancel$/u, handler: () => ({ endsAt: fixtures.billingOverview.subscription.currentPeriodEnd }) },
  { method: 'GET', pattern: /^\/billing$/u, handler: () => fixtures.billingOverview },

  // -------------------------------------------------------------- platform
  { method: 'GET', pattern: /^\/api-keys\/scopes$/u, handler: () => ({ scopes: fixtures.scopes }) },
  { method: 'GET', pattern: /^\/api-keys$/u, handler: () => state.apiKeys },
  { method: 'POST', pattern: /^\/api-keys$/u, handler: (_m, body) => {
    const input = body as { name: string; scopes: string[] };
    const row: Row = { id: id('k'), name: input.name, keyPrefix: 'rk_live_demo1234', scopes: input.scopes, lastUsedAt: null, expiresAt: null, revokedAt: null, createdAt: nowIso() };
    state.apiKeys.unshift(row);
    return { ...row, keyShownOnce: 'rk_live_demo1234_ONLY_SHOWN_ONCE_abcdef0123456789' };
  } },
  { method: 'DELETE', pattern: /^\/api-keys\/([^/]+)$/u, handler: (m) => {
    const row = find(state.apiKeys, m[1] ?? '');
    if (row !== undefined) row['revokedAt'] = nowIso();
    return { revoked: true };
  } },

  { method: 'GET', pattern: /^\/webhook-endpoints\/event-types$/u, handler: () => ({ eventTypes: [
    'campaign.launched', 'campaign.completed', 'campaign.paused',
    'recipient.sent', 'recipient.delivered', 'recipient.bounced',
    'recipient.complained', 'recipient.opened', 'recipient.clicked',
    'contact.unsubscribed', 'import.completed', 'sender.disabled',
    'workspace.enforcement_changed',
  ] }) },
  { method: 'GET', pattern: /^\/webhook-endpoints$/u, handler: () => state.webhookEndpoints },
  { method: 'POST', pattern: /^\/webhook-endpoints$/u, handler: (_m, body) => {
    const input = body as { url: string; events: string[]; description?: string };
    const row: Row = { id: id('wh'), url: input.url, events: input.events, status: 'active', description: input.description ?? null, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, disabledAt: null, disabledReason: null, secretRotatedAt: null, createdAt: nowIso() };
    state.webhookEndpoints.unshift(row);
    return { ...row, secretShownOnce: 'whsec_demo_ONLY_SHOWN_ONCE_abcdef0123456789' };
  } },
  { method: 'GET', pattern: /^\/webhook-endpoints\/([^/]+)\/deliveries$/u, handler: () => fixtures.webhookDeliveries },
  { method: 'POST', pattern: /^\/webhook-endpoints\/([^/]+)\/rotate-secret$/u, handler: () => ({ secretShownOnce: 'whsec_demo_ROTATED_abcdef0123456789' }) },
  { method: 'PATCH', pattern: /^\/webhook-endpoints\/([^/]+)$/u, handler: (m, body) => {
    const row = find(state.webhookEndpoints, m[1] ?? '');
    if (row !== undefined) Object.assign(row, body as object);
    return row ?? {};
  } },
  { method: 'DELETE', pattern: /^\/webhook-endpoints\/([^/]+)$/u, handler: (m) => {
    state.webhookEndpoints = state.webhookEndpoints.filter((row) => row.id !== m[1]);
    return {};
  } },
];

function respond(value: unknown, status = 200, paged = false): Response {
  const envelope =
    status >= 400 ? value : paged ? { data: value, meta: { hasMore: false } } : { data: value };

  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function installDemoServer(): void {
  const real = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (!url.includes('/api/v1')) return real(input as RequestInfo, init);

    const path = new URL(url, window.location.origin).pathname.replace(/^\/api\/v1/u, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

    for (const route of ROUTES) {
      if (route.method !== method) continue;

      const match = route.pattern.exec(path);
      if (match === null) continue;

      // A little latency, so loading states are visible rather than flashing
      // past. This is a preview of the flow, and a spinner nobody ever sees
      // is a spinner nobody has checked.
      await new Promise((resolve) => setTimeout(resolve, 80));

      return respond(route.handler(match, body), 200, route.paged === true);
    }

    // Anything unrouted answers with the real error envelope, so an
    // unhandled screen shows the application's own error state rather than a
    // blank page. `demo-smoke.test.tsx` fails on any of these.
    return respond(
      {
        error: {
          code: 'not_found',
          message: `DEMO: no fixture for ${method} ${path}`,
          requestId: 'demo-request',
        },
      },
      404,
    );
  };
}
