import { iso } from './clock.js';

/**
 * Section G fixtures: campaigns, their counters, recipients and timelines.
 *
 * DEMO ONLY. Mirrored from `design/sample-data.js` so the preview looks like
 * the frames: the same seven campaigns of the workspace "Northwind Voyages",
 * plus the three the G script adds in `EXTRA` (a validating one, a cancelled
 * one and a failed one) so every state in `CAMPAIGN_STATES` has a row
 * somebody has actually looked at.
 *
 * The counters are fixtures rather than a simulation. A number that moves
 * while a screen is being read is a number nobody can compare against a
 * frame.
 */

interface Counts {
  delivered?: number;
  pending?: number;
  sending?: number;
  soft?: number;
  hard?: number;
  complaint?: number;
  failed?: number;
  uncertain?: number;
}

interface Fixture {
  id: string;
  name: string;
  status: string;
  counts: Counts;
  recipients: number;
  clicks: number | null;
  whenLabel: string;
  senderLabel: string;
  note?: string;
  metaLabel: string;
  scheduledAt?: string | null;
  launchedAt?: string | null;
}

const FIXTURES: Fixture[] = [
  {
    id: 'cmp_8f3k2a',
    name: 'Autumn Escapes: Dubai → Santorini',
    status: 'sending',
    counts: { delivered: 29_876, sending: 1_240, pending: 16_595, soft: 214, hard: 96, complaint: 12, failed: 0, uncertain: 180 },
    recipients: 48_213,
    clicks: 1_187,
    whenLabel: 'Started today, 09:00',
    senderLabel: 'hello@northwind.travel',
    metaLabel:
      'Launched 19 Sep 2026, 09:00 GST by Farah Al-Mansoori (request from Omar Haddad) · EU marketing pool · Autumn escapes v6',
    launchedAt: iso(0),
  },
  {
    id: 'cmp_1w5e8y',
    name: 'Winter sun preview',
    status: 'validating',
    counts: { pending: 21_040 },
    recipients: 21_040,
    clicks: null,
    whenLabel: 'Launching now',
    senderLabel: 'offers@northwind.travel',
    metaLabel: 'Taking a snapshot of the audience · Northwind Offers',
    launchedAt: iso(0),
  },
  {
    id: 'cmp_7q1m9z',
    name: 'September newsletter — EU edition',
    status: 'completed',
    counts: { delivered: 22_241, soft: 198, hard: 87, complaint: 9, uncertain: 335 },
    recipients: 22_870,
    clicks: 1_023,
    whenLabel: '8 Sep, 10:00',
    senderLabel: 'news@northwind.travel',
    metaLabel: 'Completed 8 Sep 2026, 10:42 GST by Dana Haddad · Northwind News · EU newsletter v12',
    launchedAt: iso(11),
  },
  {
    id: 'cmp_2x8d4c',
    name: 'Abu Dhabi F1 weekend — early access',
    status: 'scheduled',
    counts: { pending: 9_640 },
    recipients: 9_640,
    clicks: null,
    whenLabel: '24 Sep, 09:00 GST',
    senderLabel: 'hello@northwind.travel',
    metaLabel: 'Scheduled 24 Sep 2026, 09:00 GST by Dana Haddad · Northwind Voyages · F1 early access v2',
    scheduledAt: iso(-5),
  },
  {
    id: 'cmp_6r9s2e',
    name: 'Eid al-Etihad flash sale',
    status: 'paused',
    counts: { delivered: 6_120, pending: 12_150, soft: 64, hard: 38, complaint: 21, uncertain: 57 },
    recipients: 18_450,
    clicks: 129,
    whenLabel: 'Paused 16 Sep, 11:12',
    senderLabel: 'offers@northwind.travel',
    note: 'Complaint rate 0.34%',
    metaLabel:
      'Launched 16 Sep 2026, 10:30 GST by Farah Al-Mansoori · Northwind Offers · Flash sale · UAE v5',
    launchedAt: iso(3),
  },
  {
    id: 'cmp_5n2v7b',
    name: 'Loyalty tier upgrade notice',
    status: 'completed_with_errors',
    counts: { delivered: 2_880, soft: 41, hard: 22, complaint: 3, failed: 24, uncertain: 150 },
    recipients: 3_120,
    clicks: 201,
    whenLabel: '5 Sep, 14:30',
    senderLabel: 'members@northwind.travel',
    metaLabel: 'Completed 5 Sep 2026, 15:02 GST by Dana Haddad · Northwind Miles · Loyalty notice v3',
    launchedAt: iso(14),
  },
  {
    id: 'cmp_3h7t6w',
    name: 'Summer sale wrap-up',
    status: 'held',
    counts: { pending: 14_200 },
    recipients: 14_200,
    clicks: null,
    whenLabel: 'Held since 17 Sep',
    senderLabel: 'offers@northwind.travel',
    note: 'Held by billing',
    metaLabel: 'Scheduled 17 Sep 2026, 10:00 GST by Dana Haddad · Northwind Offers · Summer sale v4',
    scheduledAt: iso(2),
  },
  {
    id: 'cmp_9k4p1r',
    name: 'Ramadan 2027 pre-registration',
    status: 'draft',
    counts: {},
    recipients: 0,
    clicks: null,
    whenLabel: 'Edited 2 days ago',
    senderLabel: '—',
    metaLabel: 'Draft · edited 2 days ago by Dana Haddad',
  },
  {
    id: 'cmp_4d2r7u',
    name: 'Partner offer — Skywards double miles',
    status: 'cancelled',
    counts: { delivered: 4_020, pending: 26_190 },
    recipients: 30_210,
    clicks: 88,
    whenLabel: 'Cancelled 2 Sep, 10:14',
    senderLabel: 'news@northwind.travel',
    metaLabel: 'Cancelled 2 Sep 2026, 10:14 GST by Dana Haddad · Northwind News · Partner offer v1',
    launchedAt: iso(17),
  },
  {
    id: 'cmp_0p9o3i',
    name: 'Test: transactional fallback',
    status: 'failed',
    counts: { failed: 120 },
    recipients: 120,
    clicks: null,
    whenLabel: '30 Aug, 16:02',
    senderLabel: 'deals@northwind-deals.com',
    note: 'Sender verification failed',
    metaLabel: 'Failed 30 Aug 2026, 16:02 GST · deals@northwind-deals.com',
    launchedAt: iso(20),
  },
];

/** The banners G3b and G3c draw, keyed by the campaign that carries one. */
const HOLDS: Record<string, unknown> = {
  cmp_3h7t6w: {
    tone: 'warning',
    icon: 'lock',
    title: 'Held by billing.',
    body: 'Invoice INV-2026-0912 (USD 249.00) is 18 days past due, so launches are blocked. The campaign keeps its audience and schedule and launches automatically once payment clears.',
    actionLabel: 'Update payment method',
    actionHref: '/billing',
  },
  cmp_6r9s2e: {
    tone: 'warning',
    icon: 'alert',
    title: 'Paused automatically: complaint rate exceeded 0.3%.',
    body: '21 complaints of 6,120 delivered (0.34%). 12,150 recipients have not been sent. Review the audience and content; resuming re-checks the rate every 500 sends.',
    actionLabel: 'Review audience',
    actionHref: '/audience/contacts',
  },
};

export const campaigns = FIXTURES.map((fixture) => ({
  id: fixture.id,
  name: fixture.name,
  status: fixture.status,
  subjectOverride: 'Autumn escapes from {{home_airport|"DXB"}} — Santorini fares open',
  templateVersionId: 'tv_autumn_v6',
  senderAccountId: null,
  sendingPoolId: null,
  audience: { listIds: ['ls_newsletter_eu'], segmentIds: ['sg_eu_engaged'] },
  scheduledAt: fixture.scheduledAt ?? null,
  timezone: 'Asia/Dubai',
  recipientCount: fixture.recipients,
  launchedAt: fixture.launchedAt ?? null,
  completedAt: fixture.status.startsWith('completed') ? iso(11) : null,
  createdAt: iso(21),
  updatedAt: iso(0),
  counts: fixture.counts,
  clicks: fixture.clicks,
  whenLabel: fixture.whenLabel,
  senderLabel: fixture.senderLabel,
  note: fixture.note ?? null,
  metaLabel: fixture.metaLabel,
  hold: HOLDS[fixture.id] ?? null,
}));

/** `GET /campaigns/:id/progress`, from the same counters the list shows. */
export const progress: Record<string, unknown> = Object.fromEntries(
  FIXTURES.map((fixture) => {
    const c = fixture.counts;
    const pending = c.pending ?? 0;
    const sending = c.sending ?? 0;
    const delivered = c.delivered ?? 0;
    const failed = (c.hard ?? 0) + (c.failed ?? 0);

    return [
      fixture.id,
      {
        total: fixture.recipients,
        pending,
        queued: 0,
        sending,
        sent: Math.max(0, fixture.recipients - pending - sending),
        failed,
        suppressed: fixture.recipients === 0 ? 0 : 2_318,
        uncertain: c.uncertain ?? 0,
        outstanding: pending + sending,
        complete: pending + sending === 0,
        deliveryUncertain: c.uncertain ?? 0,
        counts: c,
        clicks: fixture.clicks,
        openRate: delivered === 0 ? null : 38.1,
      },
    ];
  }),
);

/** The recipient sample, from the G script's `RECIP` table. */
export const recipients = [
  { id: 'r1', email: 'amira.khalil@example.ae', state: 'delivered', deliveryState: 'delivered', attemptCount: 1, errorCode: null, sentAt: iso(0), providerMessageId: '0100019a3f2b4c5d-7e8f9a0b-1c2d-4e5f-8a9b-0c1d2e3f4a5b-000000', lastEvent: 'Delivered 09:14:02', senderUsed: 'hello@ · SES' },
  { id: 'r2', email: 'j.moreau@example.fr', state: 'delivered', deliveryState: 'clicked', attemptCount: 1, errorCode: null, sentAt: iso(0), providerMessageId: 'sg.Xk3nQ2pRTS-9fLmA1c4bQg.filterdrecv-…', lastEvent: 'Delivered 09:14:05 · clicked 09:41', senderUsed: 'offers@ · SendGrid' },
  { id: 'r3', email: 'noor.s@example.ae', state: 'sending', deliveryState: null, attemptCount: 1, errorCode: null, sentAt: null, providerMessageId: null, lastEvent: 'Handed to SES 11:02:41', senderUsed: 'hello@ · SES' },
  { id: 'r4', email: 'h.brown@example.co.uk', state: 'soft_bounced', deliveryState: 'bounced', attemptCount: 2, errorCode: 'mailbox_full', sentAt: iso(0), providerMessageId: '0100019a3f2c9e1a-4b7d2c3e-9f0a-4b1c-8d2e-3f4a5b6c7d8e-000000', lastEvent: 'Mailbox full · retry 13:15', senderUsed: 'hello@ · SES' },
  { id: 'r5', email: 'm.tan@example.sg', state: 'hard_bounced', deliveryState: 'bounced', attemptCount: 1, errorCode: 'unknown_recipient', sentAt: iso(0), providerMessageId: 'sg.Rt7vP1qLS0O2xY9wB3nKfA.filterdrecv-…', lastEvent: 'Unknown recipient · suppressed', senderUsed: 'offers@ · SendGrid' },
  { id: 'r6', email: 'lena.b@example.de', state: 'suppressed', deliveryState: null, attemptCount: 0, errorCode: null, sentAt: null, providerMessageId: null, lastEvent: 'Skipped at launch · complaint 9 Sep', senderUsed: null },
  { id: 'r7', email: 'karim.n@example.ae', state: 'delivery_uncertain', deliveryState: null, attemptCount: 1, errorCode: null, sentAt: iso(0), providerMessageId: 'sg.Zq2mW8yNRp6Kd4Hs0Lc1Tg.filterdrecv-…', lastEvent: 'Accepted 09:41 · no webhook since', senderUsed: 'offers@ · SendGrid' },
  { id: 'r8', email: 'elise.d@example.be', state: 'queued', deliveryState: null, attemptCount: 0, errorCode: null, sentAt: null, providerMessageId: null, lastEvent: 'Queued · position 14,220', senderUsed: null },
];

/** `GET /campaigns/:id/timeline`, per campaign. The sending one is G3a's. */
export const timelines: Record<string, unknown[]> = {
  cmp_8f3k2a: [
    { id: 't1', title: 'Sending · 66% processed', time: '11:02', detail: '31,618 of 48,213 handed to providers. About 5 minutes left at the current 58 emails/s.', tone: 'brand' },
    { id: 't2', title: 'SendGrid webhook stopped', time: '09:41', detail: '180 sends accepted by SendGrid could not be confirmed and are shown as delivery uncertain. They are not billed.', tone: 'danger' },
    { id: 't3', title: 'Complaint rate 0.04%', time: '10:15', detail: '12 complaints of 29,876 delivered. Auto-pause triggers at 0.3%.', tone: 'success' },
    { id: 't4', title: 'Sending started', time: '09:00', detail: 'EU marketing pool · round-robin across hello@ (SES, 14/s) and offers@ (SendGrid, 50/s).', tone: 'brand' },
    { id: 't5', title: 'Queued', time: '08:58', detail: '50,531 in audience · 2,318 suppressed removed · 48,213 recipients.', tone: 'neutral' },
    { id: 't6', title: 'Launch approved', time: '18 Sep, 16:20', detail: 'Farah Al-Mansoori approved Omar Haddad’s request. Consent attested; pre-flight 7 pass, 1 warn.', tone: 'success' },
  ],
  cmp_3h7t6w: [
    { id: 't1', title: 'Held by billing', time: '17 Sep, 11:00', detail: 'Restricted state reached (15+ days past due). Scheduled send at 10:00 did not start.', tone: 'warning' },
    { id: 't2', title: 'Payment retry failed', time: '17 Sep, 06:00', detail: 'Card ending 4242 declined a second time.', tone: 'danger' },
    { id: 't3', title: 'Scheduled', time: '10 Sep, 15:22', detail: 'Dana Haddad scheduled for 17 Sep, 10:00 GST · 14,200 recipients.', tone: 'neutral' },
  ],
  cmp_6r9s2e: [
    { id: 't1', title: 'Paused automatically', time: '11:12', detail: 'Complaint rate reached 0.34%, above the 0.3% threshold. Sending stopped within 4 seconds.', tone: 'warning' },
    { id: 't2', title: 'Complaint rate 0.28%', time: '11:05', detail: '17 complaints of 6,020 delivered · approaching threshold.', tone: 'warning' },
    { id: 't3', title: 'Sending started', time: '10:30', detail: 'Northwind Offers via SendGrid · marketing · 50/s.', tone: 'brand' },
    { id: 't4', title: 'Queued', time: '10:29', detail: '19,011 in audience · 561 suppressed removed · 18,450 recipients.', tone: 'neutral' },
  ],
};
