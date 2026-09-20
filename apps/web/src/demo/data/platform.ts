import { iso } from './clock.js';

/**
 * Section J fixtures: API keys, outbound webhook endpoints and deliveries.
 *
 * DEMO ONLY, and drawn row for row from J3a and J4a so the preview and the
 * frames can be put side by side.
 *
 * The key prefixes are prefixes, never whole keys: the real product shows
 * the secret exactly once and stores a hash, and a fixture that looked like
 * a usable key would be a bad habit on a screenshot.
 *
 * Two clocks, deliberately. Dated values (`2 Jun 2026`) hang off the frozen
 * instant in `clock.ts`, so a screenshot next month still says 2 Jun. The
 * handful of values the frames print as "4 minutes ago" or "2 min ago" hang
 * off the real clock instead, because relative labels are computed at render
 * time and a frozen "now" would print them as "1 day ago".
 */

const recently = (ms: number): string => new Date(Date.now() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* J3a                                                                 */
/* ------------------------------------------------------------------ */

export const apiKeys = [
  {
    id: 'key_01J7Q1',
    name: 'Production sync',
    keyPrefix: 'rk_live_7f3a',
    environment: 'live',
    integration: 'HubSpot',
    createdByName: 'Omar Haddad',
    revokedByName: null,
    scopes: ['contacts:write', 'campaigns:read'],
    lastUsedAt: recently(4 * MINUTE),
    expiresAt: null,
    revokedAt: null,
    createdAt: iso(109),
  },
  {
    id: 'key_01J7Q2',
    name: 'Analytics export',
    keyPrefix: 'rk_live_c21d',
    environment: 'live',
    integration: 'Looker',
    createdByName: 'Dana Haddad',
    revokedByName: null,
    scopes: ['reports:read'],
    lastUsedAt: recently(2 * DAY),
    expiresAt: null,
    revokedAt: null,
    createdAt: iso(66),
  },
  {
    id: 'key_01J7Q3',
    name: 'Staging',
    keyPrefix: 'rk_test_9b0e',
    environment: 'test',
    integration: null,
    createdByName: 'Julien Moreau',
    revokedByName: null,
    scopes: ['contacts:read', 'campaigns:write'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: iso(18),
  },
  {
    id: 'key_01J7Q4',
    name: 'Legacy Zapier',
    keyPrefix: 'rk_live_44aa',
    environment: 'live',
    integration: 'Zapier',
    createdByName: 'Dana Haddad',
    revokedByName: 'Dana Haddad',
    scopes: ['contacts:write'],
    lastUsedAt: recently(41 * DAY),
    expiresAt: null,
    revokedAt: iso(38),
    createdAt: iso(228),
  },
];

/**
 * What this role may grant, in the vocabulary J3b prints.
 *
 * No billing scope appears, and that is the fixture stating the rule rather
 * than the page hiding one: CLAUDE.md section 11 — `billing:write` can never
 * be attached to a key.
 */
export const scopes = [
  'contacts:read',
  'contacts:write',
  'lists:read',
  'lists:write',
  'campaigns:read',
  'campaigns:write',
  'campaigns:launch',
  'templates:read',
  'templates:write',
  'suppressions:read',
  'suppressions:write',
  'reports:read',
  'webhooks:manage',
];

/* ------------------------------------------------------------------ */
/* J4a                                                                 */
/* ------------------------------------------------------------------ */

/**
 * When the staging endpoint was auto-disabled.
 *
 * Stored as an instant and printed in the workspace's own zone, which the
 * demo workspace sets to Asia/Dubai, as design/sample-data.js does — so this
 * instant renders as the frame's "17 Sep 2026, 06:12 GST".
 */
const DISABLED_AT = '2026-09-17T02:12:00.000Z';

export const webhookEndpoints = [
  {
    id: 'whk_01J7Q2',
    url: 'https://api.northwind.travel/relayd/events',
    description: 'Production CRM · delivery + engagement sync',
    events: ['delivered', 'hard_bounced', 'complained', 'unsubscribed', 'clicked'],
    status: 'active',
    consecutiveFailures: 0,
    successRate7d: 99.8,
    lastDeliveryAt: recently(2 * MINUTE),
    lastSuccessAt: recently(2 * MINUTE),
    lastFailureAt: null,
    disabledAt: null,
    disabledReason: null,
    secretMasked: 'whsec_4a1f••••••••••••••••••••••',
    secretCreatedAt: iso(109),
    secretRotatedAt: null,
    undeliveredCount: null,
    replayableUntil: null,
    lastResponse: null,
    createdAt: iso(109),
  },
  {
    id: 'whk_01J7Q5',
    url: 'https://hooks.zapier.com/hooks/catch/48213/x1k9',
    description: 'Slack alerts',
    events: ['campaign.completed', 'campaign.failed'],
    status: 'active',
    consecutiveFailures: 0,
    successRate7d: 100,
    lastDeliveryAt: recently(3 * HOUR),
    lastSuccessAt: recently(3 * HOUR),
    lastFailureAt: null,
    disabledAt: null,
    disabledReason: null,
    secretMasked: 'whsec_9d02••••••••••••••••••••••',
    secretCreatedAt: iso(44),
    secretRotatedAt: null,
    undeliveredCount: null,
    replayableUntil: null,
    lastResponse: null,
    createdAt: iso(44),
  },
  {
    id: 'whk_01J7Q8',
    url: 'https://crm-staging.northwind.travel/hooks',
    description: 'Staging CRM · all events',
    events: ['*'],
    status: 'disabled',
    consecutiveFailures: 50,
    successRate7d: 12.4,
    lastDeliveryAt: DISABLED_AT,
    lastSuccessAt: iso(6),
    lastFailureAt: DISABLED_AT,
    disabledAt: DISABLED_AT,
    disabledReason: '50 consecutive failures',
    secretMasked: 'whsec_1c77••••••••••••••••••••••',
    secretCreatedAt: iso(70),
    secretRotatedAt: null,
    undeliveredCount: 1_284,
    replayableUntil: '2026-09-24T02:12:00.000Z',
    lastResponse:
      'HTTP/1.1 503 Service Unavailable\ncontent-type: text/html\nretry-after: 120\n…upstream connect error…',
    createdAt: iso(70),
  },
  {
    id: 'whk_01J7QA',
    url: 'https://legacy.northwind.travel/wh',
    description: 'Old reporting job · disabled manually 2 Aug',
    events: ['delivered'],
    status: 'paused',
    consecutiveFailures: 0,
    successRate7d: null,
    lastDeliveryAt: iso(48),
    lastSuccessAt: iso(48),
    lastFailureAt: null,
    disabledAt: iso(48),
    disabledReason: null,
    secretMasked: 'whsec_6b31••••••••••••••••••••••',
    secretCreatedAt: iso(300),
    secretRotatedAt: null,
    undeliveredCount: null,
    replayableUntil: null,
    lastResponse: null,
    createdAt: iso(300),
  },
];

/** The event vocabulary J4b groups into Delivery / Engagement / Campaign. */
export const eventTypes = [
  'sent',
  'delivered',
  'soft_bounced',
  'hard_bounced',
  'complained',
  'delivery_uncertain',
  'opened',
  'clicked',
  'unsubscribed',
  'campaign.launched',
  'campaign.paused',
  'campaign.completed',
  'campaign.failed',
  'import.completed',
];

/* ------------------------------------------------------------------ */
/* J4c — the staging endpoint's log, the eight rows the frame shows    */
/* ------------------------------------------------------------------ */

/** UTC instants; the page prints them in the workspace's zone (GST, +4). */
const at = (day: number, time: string): string => `2026-09-${String(day).padStart(2, '0')}T${time}Z`;

export const webhookDeliveries = [
  { id: 8, eventType: 'delivered', eventId: 'evt_01J8ZJ2K9QF3', attempt: 6, status: 'failed', responseCode: 503, responseBody: null, error: null, durationMs: 10_004, nextRetryLabel: 'Endpoint disabled', scheduledFor: at(17, '02:12:04'), deliveredAt: at(17, '02:12:04'), createdAt: at(17, '02:12:04') },
  { id: 7, eventType: 'delivered', eventId: 'evt_01J8ZH8R2MC1', attempt: 5, status: 'failed', responseCode: 503, responseBody: null, error: null, durationMs: 9_998, nextRetryLabel: null, scheduledFor: at(17, '01:42:01'), deliveredAt: at(17, '01:42:01'), createdAt: at(17, '01:42:01') },
  { id: 6, eventType: 'clicked', eventId: 'evt_01J8Z9T4W7VN', attempt: 4, status: 'failed', responseCode: 503, responseBody: null, error: null, durationMs: 10_001, nextRetryLabel: null, scheduledFor: at(16, '23:41:58'), deliveredAt: at(16, '23:41:58'), createdAt: at(16, '23:41:58') },
  { id: 5, eventType: 'hard_bounced', eventId: 'evt_01J8Z7QK1N0P', attempt: 3, status: 'failed', responseCode: null, responseBody: null, error: 'Timeout', durationMs: 10_000, nextRetryLabel: null, scheduledFor: at(16, '23:11:52'), deliveredAt: at(16, '23:11:52'), createdAt: at(16, '23:11:52') },
  { id: 4, eventType: 'delivered', eventId: 'evt_01J8Z6C3XV8A', attempt: 2, status: 'failed', responseCode: 503, responseBody: null, error: null, durationMs: 9_731, nextRetryLabel: null, scheduledFor: at(16, '22:41:50'), deliveredAt: at(16, '22:41:50'), createdAt: at(16, '22:41:50') },
  { id: 3, eventType: 'delivered', eventId: 'evt_01J8Z63HD2QT', attempt: 1, status: 'failed', responseCode: 503, responseBody: null, error: null, durationMs: 8_214, nextRetryLabel: null, scheduledFor: at(16, '22:36:49'), deliveredAt: at(16, '22:36:49'), createdAt: at(16, '22:36:49') },
  { id: 2, eventType: 'campaign.paused', eventId: 'evt_01J8YTM7P4RS', attempt: 1, status: 'delivered', responseCode: 200, responseBody: null, error: null, durationMs: 312, nextRetryLabel: null, scheduledFor: at(16, '19:10:12'), deliveredAt: at(16, '19:10:12'), createdAt: at(16, '19:10:12') },
  { id: 1, eventType: 'complained', eventId: 'evt_01J8YSZ1K6BD', attempt: 1, status: 'delivered', responseCode: 200, responseBody: null, error: null, durationMs: 288, nextRetryLabel: null, scheduledFor: at(16, '18:58:31'), deliveredAt: at(16, '18:58:31'), createdAt: at(16, '18:58:31') },
];

/** J4c prints "of 1,334", which is more than the page it shows. */
export const webhookDeliveryTotal = 1_334;
