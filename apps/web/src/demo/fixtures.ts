/**
 * Dummy data for the UI preview.
 *
 * DEMO ONLY. Nothing here is imported by the real application — the demo
 * module is only loaded when `VITE_DEMO=1`, and this branch is not meant to
 * be merged.
 *
 * The numbers are chosen to make the screens legible rather than to be
 * realistic: a campaign mid-send, one that finished, one paused by the
 * enforcement ladder, a draft. Rates sit where the UI's thresholds change
 * colour so the states are visible without waiting for anything.
 */

const now = new Date('2026-09-19T12:00:00.000Z');
const iso = (daysAgo: number): string =>
  new Date(now.getTime() - daysAgo * 86_400_000).toISOString();

export const WORKSPACE_ID = '0192f4a1-0000-7000-8000-000000000001';

export const session = {
  accessToken: 'demo-access-token',
  memberships: [
    {
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Northwind Coffee',
      workspaceSlug: 'northwind-coffee',
      role: 'owner' as const,
    },
    {
      workspaceId: '0192f4a1-0000-7000-8000-000000000002',
      workspaceName: 'Northwind Labs',
      workspaceSlug: 'northwind-labs',
      role: 'admin' as const,
    },
  ],
};

// ------------------------------------------------------------------ audience

export const contacts = [
  { id: 'c1', email: 'aisha.khan@example.com', firstName: 'Aisha', lastName: 'Khan', status: 'subscribed', attributes: { city: 'Leeds' }, createdAt: iso(40) },
  { id: 'c2', email: 'tom.becker@example.com', firstName: 'Tom', lastName: 'Becker', status: 'subscribed', attributes: { city: 'Berlin' }, createdAt: iso(38) },
  { id: 'c3', email: 'priya.nair@example.com', firstName: 'Priya', lastName: 'Nair', status: 'subscribed', attributes: { city: 'Pune' }, createdAt: iso(31) },
  { id: 'c4', email: 'j.oyelaran@example.com', firstName: 'Jide', lastName: 'Oyelaran', status: 'unsubscribed', attributes: {}, createdAt: iso(27) },
  { id: 'c5', email: 'mei.tan@example.com', firstName: 'Mei', lastName: 'Tan', status: 'subscribed', attributes: { city: 'Singapore' }, createdAt: iso(21) },
  { id: 'c6', email: 'bounced@invalid.example', firstName: 'Sam', lastName: 'Ruiz', status: 'bounced', attributes: {}, createdAt: iso(19) },
  { id: 'c7', email: 'lena.fischer@example.com', firstName: 'Lena', lastName: 'Fischer', status: 'subscribed', attributes: { city: 'Vienna' }, createdAt: iso(12) },
  { id: 'c8', email: 'complained@example.com', firstName: 'Ravi', lastName: 'Sharma', status: 'complained', attributes: {}, createdAt: iso(9) },
  { id: 'c9', email: 'nora.lindqvist@example.com', firstName: 'Nora', lastName: 'Lindqvist', status: 'subscribed', attributes: { city: 'Malmö' }, createdAt: iso(4) },
  { id: 'c10', email: 'diego.alvarez@example.com', firstName: 'Diego', lastName: 'Alvarez', status: 'subscribed', attributes: { city: 'Madrid' }, createdAt: iso(1) },
];

export const lists = [
  { id: 'l1', name: 'Newsletter', description: 'Everyone who ticked the box at checkout', memberCount: 18_402, createdAt: iso(120) },
  { id: 'l2', name: 'Wholesale buyers', description: null, memberCount: 341, createdAt: iso(96) },
  { id: 'l3', name: 'Lapsed (12m+)', description: 'No order in a year', memberCount: 4_115, createdAt: iso(45) },
];

export const tags = [
  { id: 't1', name: 'espresso', color: '#8b5cf6', createdAt: iso(90) },
  { id: 't2', name: 'subscription', color: '#0ea5e9', createdAt: iso(88) },
  { id: 't3', name: 'trade', color: '#f59e0b', createdAt: iso(60) },
];

export const suppressions = [
  { id: 's1', email: 'bounced@invalid.example', reason: 'hard_bounce', notes: '550 5.1.1 unknown recipient', createdAt: iso(19) },
  { id: 's2', email: 'complained@example.com', reason: 'complaint', notes: null, createdAt: iso(9) },
  { id: 's3', email: 'j.oyelaran@example.com', reason: 'unsubscribe', notes: null, createdAt: iso(27) },
];

export const imports = [
  { id: 'i1', originalFilename: 'wholesale-2026.csv', fileType: 'csv', status: 'completed', columnMapping: { A: 'email', B: 'firstName' }, totalRows: 341, processedRows: 341, createdCount: 318, updatedCount: 19, skippedCount: 3, failedCount: 1, createdAt: iso(6), completedAt: iso(6) },
  { id: 'i2', originalFilename: 'newsletter-export.csv', fileType: 'csv', status: 'processing', columnMapping: { A: 'email' }, totalRows: 18_402, processedRows: 11_240, createdCount: 10_980, updatedCount: 260, skippedCount: 0, failedCount: 0, createdAt: iso(0), completedAt: null },
  { id: 'i3', originalFilename: 'old-crm.xlsx', fileType: 'xlsx', status: 'pending', columnMapping: null, totalRows: null, processedRows: 0, createdCount: 0, updatedCount: 0, skippedCount: 0, failedCount: 0, createdAt: iso(0), completedAt: null },
];

// ----------------------------------------------------------------- templates

const html = `<h1>Autumn blend is here</h1>
<p>Hello {{ contact.firstName | default: "there" }},</p>
<p>Our autumn blend landed this morning. Roasted on Tuesday, shipped on Wednesday.</p>
<p><a href="https://northwind.example/autumn">Read the tasting notes</a></p>`;

export const templates = [
  { id: 'tpl1', name: 'Autumn blend announcement', category: 'campaign', currentVersionId: 'v1', createdAt: iso(14), updatedAt: iso(3) },
  { id: 'tpl2', name: 'Wholesale price list', category: 'transactional', currentVersionId: 'v2', createdAt: iso(60), updatedAt: iso(30) },
  { id: 'tpl3', name: 'Win-back (draft)', category: null, currentVersionId: null, createdAt: iso(2), updatedAt: iso(2) },
];

export const templateVersion = {
  id: 'v1',
  templateId: 'tpl1',
  version: 4,
  subject: 'Autumn blend is here, {{ contact.firstName | default: "friend" }}',
  preheader: 'Roasted Tuesday, shipped Wednesday',
  htmlSource: html,
  htmlCompiled: html,
  textBody: 'Autumn blend is here. Read the tasting notes: https://northwind.example/autumn',
  variables: [
    { field: 'firstName', default: 'there', required: false },
    { field: 'email', default: '', required: true },
  ],
  publishedAt: iso(3),
  createdAt: iso(3),
};

// ----------------------------------------------------------------- campaigns

export const campaigns = [
  { id: 'cmp1', name: 'Autumn blend launch', status: 'sending', subjectOverride: null, templateVersionId: 'v1', senderAccountId: 'snd1', sendingPoolId: null, audience: { listIds: ['l1'] }, scheduledAt: null, timezone: 'Europe/London', recipientCount: 18_402, launchedAt: iso(0), completedAt: null, createdAt: iso(2), updatedAt: iso(0) },
  { id: 'cmp2', name: 'September wholesale update', status: 'completed', subjectOverride: null, templateVersionId: 'v2', senderAccountId: 'snd1', sendingPoolId: null, audience: { listIds: ['l2'] }, scheduledAt: null, timezone: 'Europe/London', recipientCount: 341, launchedAt: iso(12), completedAt: iso(12), createdAt: iso(14), updatedAt: iso(12) },
  { id: 'cmp3', name: 'Win-back — lapsed customers', status: 'draft', subjectOverride: null, templateVersionId: null, senderAccountId: null, sendingPoolId: null, audience: {}, scheduledAt: null, timezone: null, recipientCount: 0, launchedAt: null, completedAt: null, createdAt: iso(1), updatedAt: iso(1) },
  { id: 'cmp4', name: 'Black Friday teaser', status: 'scheduled', subjectOverride: null, templateVersionId: 'v1', senderAccountId: 'snd1', sendingPoolId: null, audience: { listIds: ['l1', 'l3'] }, scheduledAt: iso(-7), timezone: 'Europe/London', recipientCount: 22_517, launchedAt: null, completedAt: null, createdAt: iso(5), updatedAt: iso(1) },
  { id: 'cmp5', name: 'Trade show follow-up', status: 'paused', subjectOverride: null, templateVersionId: 'v2', senderAccountId: 'snd1', sendingPoolId: null, audience: { listIds: ['l2'] }, scheduledAt: null, timezone: 'Europe/London', recipientCount: 288, launchedAt: iso(4), completedAt: null, createdAt: iso(6), updatedAt: iso(4) },
];

export const progress: Record<string, unknown> = {
  cmp1: { total: 18_402, pending: 6_140, queued: 420, sending: 38, sent: 11_760, failed: 31, suppressed: 13, uncertain: 0, outstanding: 6_598, complete: false, deliveryUncertain: 0 },
  cmp2: { total: 341, pending: 0, queued: 0, sending: 0, sent: 336, failed: 2, suppressed: 3, uncertain: 0, outstanding: 0, complete: true, deliveryUncertain: 0 },
  cmp5: { total: 288, pending: 190, queued: 0, sending: 0, sent: 96, failed: 1, suppressed: 1, uncertain: 1, outstanding: 190, complete: false, deliveryUncertain: 1 },
};

export const recipients = [
  { id: 'r1', email: 'aisha.khan@example.com', state: 'sent', deliveryState: 'delivered', attemptCount: 1, errorCode: null, sentAt: iso(0) },
  { id: 'r2', email: 'tom.becker@example.com', state: 'sent', deliveryState: 'opened', attemptCount: 1, errorCode: null, sentAt: iso(0) },
  { id: 'r3', email: 'priya.nair@example.com', state: 'sent', deliveryState: 'clicked', attemptCount: 1, errorCode: null, sentAt: iso(0) },
  { id: 'r4', email: 'bounced@invalid.example', state: 'failed', deliveryState: 'bounced', attemptCount: 1, errorCode: 'hard_bounce', sentAt: iso(0) },
  { id: 'r5', email: 'mei.tan@example.com', state: 'queued', deliveryState: null, attemptCount: 0, errorCode: null, sentAt: null },
  { id: 'r6', email: 'lena.fischer@example.com', state: 'pending', deliveryState: null, attemptCount: 0, errorCode: null, sentAt: null },
];

// ----------------------------------------------------------------- analytics

const rate = (kind: string, numerator: number, denominator: number, confidence = 'reliable') => ({
  kind,
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
  confidence,
  botFiltered: kind === 'open' ? 1_204 : 0,
});

const points = Array.from({ length: 14 }, (_, index) => {
  const day = iso(13 - index).slice(0, 10);
  const sent = index === 13 ? 11_760 : Math.round(600 + Math.sin(index) * 260 + index * 40);

  return {
    day,
    sent,
    delivered: Math.round(sent * 0.978),
    bounced: Math.round(sent * 0.011),
    complained: Math.round(sent * 0.0004),
    opensUniqueNonbot: Math.round(sent * 0.41),
    clicksUnique: Math.round(sent * 0.086),
    unsubscribed: Math.round(sent * 0.002),
  };
});

const totals = points.reduce(
  (sum, point) => ({
    sent: sum.sent + point.sent,
    delivered: sum.delivered + point.delivered,
    bounced: sum.bounced + point.bounced,
    complained: sum.complained + point.complained,
    opensUniqueNonbot: sum.opensUniqueNonbot + point.opensUniqueNonbot,
    clicksUnique: sum.clicksUnique + point.clicksUnique,
    unsubscribed: sum.unsubscribed + point.unsubscribed,
  }),
  { sent: 0, delivered: 0, bounced: 0, complained: 0, opensUniqueNonbot: 0, clicksUnique: 0, unsubscribed: 0 },
);

export const overview = {
  from: iso(13).slice(0, 10),
  to: iso(0).slice(0, 10),
  points,
  totals,
  rates: {
    // docs/08: click is the headline because an open is evidence an image was
    // fetched, not that a human read anything. The UI labels open as
    // "directional" for the same reason.
    click: rate('click', totals.clicksUnique, totals.delivered),
    open: rate('open', totals.opensUniqueNonbot, totals.delivered, 'directional'),
    bounce: rate('bounce', totals.bounced, totals.sent),
    complaint: rate('complaint', totals.complained, totals.delivered),
  },
  headline: 'click',
};

export const campaignAnalytics = {
  campaignId: 'cmp1',
  counts: {
    sent: 11_760,
    delivered: 11_502,
    bounced: 129,
    complained: 4,
    opensUniqueNonbot: 4_716,
    clicksUnique: 989,
    unsubscribed: 23,
  },
  rates: {
    click: rate('click', 989, 11_502),
    open: rate('open', 4_716, 11_502, 'directional'),
    bounce: rate('bounce', 129, 11_760),
    complaint: rate('complaint', 4, 11_502),
    unsubscribe: rate('unsubscribe', 23, 11_502),
    delivery: rate('delivery', 11_502, 11_760),
  },
  headline: 'click',
  computedAt: iso(0),
  computedBy: 'incremental',
};

export const links = [
  { linkId: 'lk1', url: 'https://northwind.example/autumn', position: 0, clicksTotal: 1_412, clicksUnique: 902, clicksUniqueNonbot: 861, clickRate: rate('click', 861, 11_502) },
  { linkId: 'lk2', url: 'https://northwind.example/shop/subscriptions', position: 1, clicksTotal: 204, clicksUnique: 151, clicksUniqueNonbot: 143, clickRate: rate('click', 143, 11_502) },
  { linkId: 'lk3', url: 'https://northwind.example/unsubscribe-help', position: 2, clicksTotal: 38, clicksUnique: 36, clicksUniqueNonbot: 34, clickRate: rate('click', 34, 11_502) },
];

export const devices = {
  total: 4_716,
  breakdown: [
    { device: 'mobile', count: 2_781, share: 0.59 },
    { device: 'desktop', count: 1_509, share: 0.32 },
    { device: 'tablet', count: 189, share: 0.04 },
    { device: 'unknown', count: 237, share: 0.05 },
  ],
  unknownShare: 0.05,
};

// ----------------------------------------------------------------- providers

export const connections = [
  {
    id: 'pr1', providerType: 'ses', name: 'AWS SES (production)', status: 'active', hasWebhookSecret: true,
    lastVerifiedAt: iso(0), lastError: null,
    quotaSnapshot: { dailyQuota: 200_000, sentLast24h: 12_488, sendRate: 14 },
    capabilities: { templates: false, scheduling: false, batchSend: true },
    createdAt: iso(120),
  },
  {
    id: 'pr2', providerType: 'sendgrid', name: 'SendGrid (backup)', status: 'degraded', hasWebhookSecret: true,
    lastVerifiedAt: iso(1), lastError: { kind: 'rate_limited', message: 'Provider returned 429 on 3 of the last 50 calls' },
    quotaSnapshot: { dailyQuota: 100_000, sentLast24h: 0, sendRate: 10 },
    capabilities: { templates: true, scheduling: true, batchSend: true },
    createdAt: iso(64),
  },
  {
    id: 'pr3', providerType: 'smtp', name: 'Office SMTP relay', status: 'needs_reauth', hasWebhookSecret: false,
    lastVerifiedAt: iso(9), lastError: { kind: 'authentication', message: 'Credentials rejected' },
    quotaSnapshot: { dailyQuota: null, sentLast24h: 0, sendRate: 2 },
    capabilities: { templates: false, scheduling: false, batchSend: false },
    createdAt: iso(30),
  },
];

export const identities = [
  { id: 'id1', providerId: 'pr1', kind: 'domain', value: 'northwind.example', verificationStatus: 'verified', dkimStatus: 'pass', spfStatus: 'pass', dmarcStatus: 'pass', verifiedAt: iso(118) },
  { id: 'id2', providerId: 'pr1', kind: 'email', value: 'hello@northwind.example', verificationStatus: 'verified', dkimStatus: 'pass', spfStatus: 'pass', dmarcStatus: null, verifiedAt: iso(118) },
  { id: 'id3', providerId: 'pr2', kind: 'domain', value: 'mail.northwind.example', verificationStatus: 'pending', dkimStatus: null, spfStatus: 'pass', dmarcStatus: null, verifiedAt: null },
];

export const senders = [
  { id: 'snd1', providerId: 'pr1', identityId: 'id2', fromEmail: 'hello@northwind.example', fromName: 'Northwind Coffee', replyTo: 'support@northwind.example', status: 'active', dailyLimit: 50_000, hourlyLimit: 5_000, healthScore: 98, consecutiveFailures: 0, cooldownUntil: null, lastSendAt: iso(0) },
  { id: 'snd2', providerId: 'pr2', identityId: 'id3', fromEmail: 'news@mail.northwind.example', fromName: 'Northwind News', replyTo: null, status: 'cooling_down', dailyLimit: 20_000, hourlyLimit: 2_000, healthScore: 61, consecutiveFailures: 4, cooldownUntil: iso(-0.02), lastSendAt: iso(1) },
];

// ------------------------------------------------------------------- billing

export const plans = [
  { code: 'starter', name: 'Starter', rank: 1, trialDays: 14, limits: { 'emails.sent': 50_000, 'contacts.stored': 2_500, 'team.members': 3 }, flags: { 'feature.sending_pools': false, 'feature.api_access': false } },
  { code: 'pro', name: 'Pro', rank: 2, trialDays: 14, limits: { 'emails.sent': 500_000, 'contacts.stored': 50_000, 'team.members': 10 }, flags: { 'feature.sending_pools': true, 'feature.api_access': true } },
  { code: 'business', name: 'Business', rank: 3, trialDays: 0, limits: { 'emails.sent': 2_000_000, 'contacts.stored': 250_000, 'team.members': null }, flags: { 'feature.sending_pools': true, 'feature.api_access': true } },
];

export const billingOverview = {
  subscription: {
    planCode: 'pro',
    planName: 'Pro',
    interval: 'month',
    status: 'active',
    currentPeriodStart: iso(12),
    currentPeriodEnd: iso(-18),
    cancelAtPeriodEnd: false,
    scheduledPlanCode: null,
    scheduledChangeAt: null,
    trialEnd: null,
  },
  state: { workspaceSuspended: false, subscriptionSuspended: false, pastDue: false, hasSubscription: true },
  usage: [
    { featureKey: 'emails.sent', used: 138_402, included: 500_000, overage: 0, percentUsed: 0.2768, periodEnd: iso(-18) },
    { featureKey: 'contacts.stored', used: 22_858, included: 50_000, overage: 0, percentUsed: 0.457, periodEnd: iso(-18) },
    { featureKey: 'team.members', used: 4, included: 10, overage: 0, percentUsed: 0.4, periodEnd: iso(-18) },
  ],
  paymentMethod: { brand: 'visa', last4: '4242', expMonth: 11, expYear: 2029 },
};

export const invoices = [
  { id: 'in1', number: 'RLD-0042', status: 'paid', currency: 'gbp', total: 4900, amountDue: 0, periodStart: iso(42), periodEnd: iso(12), paidAt: iso(12), hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(12) },
  { id: 'in2', number: 'RLD-0031', status: 'paid', currency: 'gbp', total: 4900, amountDue: 0, periodStart: iso(72), periodEnd: iso(42), paidAt: iso(42), hostedInvoiceUrl: '#', pdfUrl: '#', createdAt: iso(42) },
];

// ------------------------------------------------------------------ platform

export const apiKeys = [
  { id: 'k1', name: 'CI deploy', keyPrefix: 'rk_live_a1b2c3d4', scopes: ['contact:read', 'campaign:read'], lastUsedAt: iso(0), expiresAt: iso(-300), revokedAt: null, createdAt: iso(60) },
  { id: 'k2', name: 'Zapier', keyPrefix: 'rk_live_9f8e7d6c', scopes: ['contact:read', 'contact:write'], lastUsedAt: iso(3), expiresAt: null, revokedAt: null, createdAt: iso(30) },
  { id: 'k3', name: 'Old integration', keyPrefix: 'rk_live_deadbeef', scopes: ['contact:read'], lastUsedAt: iso(90), expiresAt: null, revokedAt: iso(10), createdAt: iso(200) },
];

export const webhookEndpoints = [
  { id: 'wh1', url: 'https://northwind.example/hooks/relayd', events: ['campaign.completed', 'recipient.bounced'], status: 'active', description: 'Order system', consecutiveFailures: 0, lastSuccessAt: iso(0), lastFailureAt: null, disabledAt: null, disabledReason: null, secretRotatedAt: iso(40), createdAt: iso(90) },
  { id: 'wh2', url: 'https://hooks.partner.example/relayd', events: ['recipient.complained'], status: 'failing', description: null, consecutiveFailures: 7, lastSuccessAt: iso(5), lastFailureAt: iso(0), disabledAt: null, disabledReason: null, secretRotatedAt: null, createdAt: iso(20) },
];

export const webhookDeliveries = [
  { id: 1, eventType: 'campaign.completed', eventId: 'evt_1', attempt: 1, status: 'delivered', responseCode: 200, responseBody: 'ok', error: null, durationMs: 143, scheduledFor: iso(0), deliveredAt: iso(0), createdAt: iso(0) },
  { id: 2, eventType: 'recipient.complained', eventId: 'evt_2', attempt: 3, status: 'failed', responseCode: 503, responseBody: 'upstream unavailable', error: 'HTTP 503', durationMs: 5_002, scheduledFor: iso(0), deliveredAt: null, createdAt: iso(0) },
];

export const team = [
  { userId: 'u1', email: 'you@northwind.example', name: 'You', role: 'owner', joinedAt: iso(200) },
  { userId: 'u2', email: 'marta@northwind.example', name: 'Marta Reyes', role: 'admin', joinedAt: iso(150) },
  { userId: 'u3', email: 'kai@northwind.example', name: 'Kai Osei', role: 'editor', joinedAt: iso(90) },
  { userId: 'u4', email: 'ana@northwind.example', name: 'Ana Silva', role: 'viewer', joinedAt: iso(20) },
];

export const workspace = {
  id: WORKSPACE_ID,
  name: 'Northwind Coffee',
  slug: 'northwind-coffee',
  timezone: 'Europe/London',
  defaultCurrency: 'GBP',
  status: 'active',
  createdAt: iso(200),
};

export const scopes = [
  'contact:read', 'contact:write',
  'campaign:read', 'campaign:write', 'campaign:launch',
  'template:read', 'template:write',
  'analytics:read',
  'provider:read',
  'webhook:read', 'webhook:write',
];
