/**
 * Section C fixtures: the dashboard, the workspace report and the campaign
 * report.
 *
 * DEMO ONLY, and every number is read off `design/sample-data.js` and the C
 * and G4 frames rather than invented: the workspace is Northwind Voyages,
 * the period is 1–19 Sep 2026 against a 250,000 plan, the thirty bars of the
 * activity chart are the frame's own series, and the campaign report is
 * `cmp_7q1m9z` — "September newsletter — EU edition" — exactly as G4a draws
 * it, down to the 335 sends SendGrid never confirmed.
 *
 * Analytics is a projection, so there is nothing here to mutate.
 */

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

interface RateInput {
  kind: string;
  numerator: number;
  denominator: number;
  /** Overrides the division when the frame prints a rounded figure. */
  value?: number;
  confidence?: 'reliable' | 'directional';
  botFiltered?: number;
  caveat?: string;
}

const rate = (input: RateInput) => ({
  kind: input.kind,
  numerator: input.numerator,
  denominator: input.denominator,
  // Null, never zero: a campaign that has delivered nothing has no click
  // rate, and 0% says it performed badly rather than "not measured".
  value: input.denominator === 0 ? null : (input.value ?? input.numerator / input.denominator),
  confidence: input.confidence ?? 'reliable',
  botFiltered: input.botFiltered ?? 0,
  ...(input.caveat === undefined ? {} : { caveat: input.caveat }),
});

/* ------------------------------------------------------------------ */
/* C1 — the workspace overview                                         */
/* ------------------------------------------------------------------ */

/** Emails accepted by provider, 21 Aug → 19 Sep 2026. The last day is today. */
const ACTIVITY = [
  1_240, 980, 2_110, 8_420, 3_160, 1_520, 640, 720, 9_840, 4_210, 2_380, 1_160, 880, 12_460, 5_120,
  2_260, 1_040, 760, 690, 11_280, 6_420, 2_840, 1_310, 920, 7_860, 3_440, 1_780, 1_020, 13_120,
  9_760,
];

/** 21 Aug 2026 + index, as a UTC day — the buckets the server returns. */
const day = (index: number): string =>
  new Date(Date.UTC(2026, 7, 21) + index * 86_400_000).toISOString().slice(0, 10);

const points = ACTIVITY.map((sent, index) => ({
  day: day(index),
  sent,
  delivered: Math.round(sent * 0.987),
  bounced: Math.round(sent * 0.009),
  complained: Math.round(sent * 0.0008),
  opensUniqueNonbot: Math.round(sent * 0.412),
  clicksUnique: Math.round(sent * 0.038),
  unsubscribed: Math.round(sent * 0.0016),
}));

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
  from: day(0),
  to: day(ACTIVITY.length - 1),
  points,
  totals,
  // The four figures C1 prints, with the frame's own numerators: 3.8% of
  // 181,890 delivered, and an open rate that is directional by definition.
  rates: {
    click: rate({ kind: 'click', numerator: 6_912, denominator: 181_890, value: 0.038 }),
    open: rate({
      kind: 'open',
      numerator: 74_938,
      denominator: 181_890,
      value: 0.412,
      confidence: 'directional',
      caveat: 'Privacy proxies inflate this.',
    }),
    bounce: rate({ kind: 'bounce', numerator: 1_659, denominator: 184_320, value: 0.009 }),
    complaint: rate({ kind: 'complaint', numerator: 145, denominator: 181_890, value: 0.0008 }),
  },
  // docs/06 §13: an open is evidence an image was fetched, not that a human
  // read anything. The click rate is what a campaign is judged by.
  headline: 'click',
};

/* ------------------------------------------------------------------ */
/* C1–C4 — the dashboard composition (BACKEND PENDING)                 */
/* ------------------------------------------------------------------ */

export const dashboard = {
  period: { label: '1–19 Sep 2026', timezone: 'Asia/Dubai', comparedTo: 'Aug' },
  usage: {
    sent: 184_320,
    limit: 250_000,
    renewsLabel: '74% · renews 1 Oct (12 days)',
    renewsShort: 'Renews 1 Oct',
    // D3: accepted by a provider that never confirmed. Never billed.
    uncertain: 412,
  },
  deltas: { click: 0.4, open: -1.1 },
  bounceSplit: { soft: 0.006, hard: 0.003 },
  complaintThreshold: 0.003,

  providers: [
    {
      connectionId: 'prv_ses_eu1',
      code: 'SES',
      name: 'Amazon SES',
      label: 'eu-west-1 · production',
      health: 'healthy',
      sentToday: 41_200,
      dailyLimit: 50_000,
    },
    {
      connectionId: 'prv_sg_mkt',
      code: 'SG',
      name: 'SendGrid',
      label: 'marketing',
      health: 'degraded',
      sentToday: 12_930,
      dailyLimit: 100_000,
    },
    {
      connectionId: 'prv_smtp_1',
      code: 'SMTP',
      name: 'SMTP',
      label: 'mail.northwind.travel',
      health: 'healthy',
      sentToday: 1_120,
      dailyLimit: 5_000,
    },
  ],

  campaigns: [
    {
      id: 'cmp_8f3k2a',
      name: 'Autumn Escapes: Dubai → Santorini',
      state: 'sending',
      when: 'Started today, 09:00',
      recipients: 48_213,
      counts: { delivered: 29_876, sending: 1_240, pending: 16_595, soft: 214, hard: 96, complaint: 12, failed: 0, uncertain: 180 },
      clickRate: 0.04,
    },
    {
      id: 'cmp_7q1m9z',
      name: 'September newsletter — EU edition',
      state: 'completed',
      when: '8 Sep, 10:00',
      recipients: 22_870,
      counts: { delivered: 22_241, soft: 198, hard: 87, complaint: 9, uncertain: 335 },
      clickRate: 0.046,
    },
    {
      id: 'cmp_2x8d4c',
      name: 'Abu Dhabi F1 weekend — early access',
      state: 'scheduled',
      when: '24 Sep, 09:00 GST',
      recipients: 9_640,
      counts: { pending: 9_640 },
      clickRate: null,
    },
    {
      id: 'cmp_6r9s2e',
      name: 'Eid al-Etihad flash sale',
      state: 'paused',
      when: 'Paused 16 Sep, 11:12 · Complaint rate 0.34%',
      recipients: 18_450,
      counts: { delivered: 6_120, pending: 12_150, soft: 64, hard: 38, complaint: 21, uncertain: 57 },
      clickRate: 0.021,
    },
    {
      id: 'cmp_5n2v7b',
      name: 'Loyalty tier upgrade notice',
      state: 'completed_with_errors',
      when: '5 Sep, 14:30',
      recipients: 3_120,
      counts: { delivered: 2_880, soft: 41, hard: 22, complaint: 3, failed: 24, uncertain: 150 },
      clickRate: 0.07,
    },
    {
      id: 'cmp_3h7t6w',
      name: 'Summer sale wrap-up',
      state: 'held',
      when: 'Held since 17 Sep · Held by billing',
      recipients: 14_200,
      counts: { pending: 14_200 },
      clickRate: null,
    },
    {
      id: 'cmp_9k4p1r',
      name: 'Ramadan 2027 pre-registration',
      state: 'draft',
      when: 'Edited 2 days ago',
      recipients: null,
      counts: {},
      clickRate: null,
    },
  ],

  attention: [
    {
      id: 'att_webhook',
      tone: 'danger',
      title: 'SendGrid · marketing webhook failing',
      detail:
        'No events received since 08:40 GST. Delivery states for 1 campaign will show as uncertain until it is fixed.',
      action: { label: 'Fix connection', href: '/providers/prv_sg_mkt' },
    },
    {
      id: 'att_paused',
      tone: 'warning',
      title: 'Eid al-Etihad flash sale paused automatically',
      detail:
        'Complaint rate reached 0.34%, above the 0.3% threshold. 12,150 recipients have not been sent.',
      action: { label: 'Review campaign', href: '/campaigns/cmp_6r9s2e' },
    },
    {
      id: 'att_billing',
      tone: 'warning',
      title: 'Summer sale wrap-up held by billing',
      detail:
        'Invoice INV-2026-0912 (USD 249.00) is 4 days past due. The campaign launches once payment clears.',
      action: { label: 'Update payment method', href: '/billing/payment-method' },
    },
  ],

  suppressions: { applied: 2_318, note: 'consent attested on all 4 imports' },
};

/* ------------------------------------------------------------------ */
/* G4a — the campaign report                                           */
/* ------------------------------------------------------------------ */

const DELIVERED = 22_241;
const SENT = 22_870;

export const campaignAnalytics = {
  campaignId: 'cmp_7q1m9z',
  counts: {
    recipients: SENT,
    sent: SENT,
    failed: 0,
    suppressed: 246,
    // D3: accepted, never confirmed, never billed. Its own number, always.
    deliveryUncertain: 335,
    delivered: DELIVERED,
    bouncedHard: 87,
    bouncedSoft: 198,
    complained: 9,
    unsubscribed: 41,
    opensTotal: 14_602,
    opensUnique: 11_124,
    opensUniqueNonbot: 9_920,
    clicksTotal: 1_540,
    clicksUnique: 1_023,
    clicksUniqueNonbot: 1_023,
  },
  rates: {
    click: rate({ kind: 'click', numerator: 1_023, denominator: DELIVERED, value: 0.046 }),
    open: rate({
      kind: 'open',
      numerator: 9_920,
      denominator: DELIVERED,
      value: 0.446,
      confidence: 'directional',
      caveat: 'Privacy proxies inflate this.',
    }),
    bounce: rate({ kind: 'bounce', numerator: 285, denominator: SENT }),
    complaint: rate({ kind: 'complaint', numerator: 9, denominator: DELIVERED }),
    unsubscribe: rate({ kind: 'unsubscribe', numerator: 41, denominator: DELIVERED }),
    delivery: rate({ kind: 'delivery', numerator: DELIVERED, denominator: SENT, value: 0.972 }),
  },
  headline: 'click',
  computedAt: '2026-09-20T06:00:00.000Z',
  computedBy: 'hourly',
  comparison: { points: 0.8, label: 'your last 5 newsletters' },
  botExcluded: 1_204,
  proxyShare: 0.61,
  sentLabel: 'Sent 8 Sep 2026, 10:00 GST',
};

/** The first 48 hours of clicks, hour by hour — G4a's own curve. */
const HOURLY = [
  292, 236, 181, 148, 122, 96, 71, 58, 44, 32, 21, 14, 9, 6, 8, 12, 24, 38, 46, 52, 48, 41, 36, 30,
  24, 18, 14, 11, 9, 8, 6, 5, 4, 3, 5, 8, 12, 15, 17, 18, 16, 14, 12, 10, 8, 7, 6, 5,
];

/** 8 Sep 2026, 10:00 GST — the hour the campaign went out. */
const LAUNCH = Date.UTC(2026, 8, 8, 6, 0, 0);

export const hourly = {
  from: new Date(LAUNCH).toISOString(),
  to: new Date(LAUNCH + 47 * 3_600_000).toISOString(),
  bucket: 'hour',
  points: HOURLY.map((clicks, index) => ({
    day: new Date(LAUNCH + index * 3_600_000).toISOString(),
    sent: index === 0 ? SENT : 0,
    delivered: index === 0 ? DELIVERED : 0,
    bounced: 0,
    complained: 0,
    opensUniqueNonbot: Math.round(clicks * 9.7),
    clicksUnique: clicks,
    unsubscribed: 0,
  })),
};

/** G4a's link table. The last two rows are the template's own links. */
export const links = [
  { linkId: 'lnk_santorini', url: 'https://northwind.travel/offers/santorini', position: 0, clicksTotal: 640, clicksUnique: 512, clicksUniqueNonbot: 512, clickRate: rate({ kind: 'click', numerator: 512, denominator: DELIVERED }) },
  { linkId: 'lnk_mykonos', url: 'https://northwind.travel/offers/mykonos', position: 1, clicksTotal: 312, clicksUnique: 260, clicksUniqueNonbot: 260, clickRate: rate({ kind: 'click', numerator: 260, denominator: DELIVERED }) },
  { linkId: 'lnk_crete', url: 'https://northwind.travel/offers/crete', position: 2, clicksTotal: 208, clicksUnique: 171, clicksUniqueNonbot: 171, clickRate: rate({ kind: 'click', numerator: 171, denominator: DELIVERED }) },
  { linkId: 'lnk_gold', url: 'https://northwind.travel/loyalty/gold-benefits', position: 3, clicksTotal: 166, clicksUnique: 140, clicksUniqueNonbot: 140, clickRate: rate({ kind: 'click', numerator: 140, denominator: DELIVERED }) },
  { linkId: 'lnk_prefs', url: 'https://northwind.travel/preferences', position: 4, clicksTotal: 98, clicksUnique: 90, clicksUniqueNonbot: 90, clickRate: rate({ kind: 'click', numerator: 90, denominator: DELIVERED }) },
  { linkId: 'lnk_browser', url: 'https://mail.northwind.travel/view/9f2c', label: 'View in browser', position: 5, clicksTotal: 72, clicksUnique: 68, clicksUniqueNonbot: 68, clickRate: rate({ kind: 'click', numerator: 68, denominator: DELIVERED }) },
  { linkId: 'lnk_unsub', url: 'https://mail.northwind.travel/u/9f2c', label: 'Unsubscribe', position: 6, clicksTotal: 44, clicksUnique: 44, clicksUniqueNonbot: 44, clickRate: rate({ kind: 'click', numerator: 44, denominator: DELIVERED }) },
];

/**
 * Device and client, by click.
 *
 * Every client is split across the three device types so the two cards on
 * G4a can be derived from one response: Mobile 61 / Desktop 33 / Tablet 6,
 * and Apple Mail 38 / Gmail 31 / Outlook 18 / Yahoo 5 / Other 8.
 */
const CLICKS_BY_CLIENT: [string, [number, number, number]][] = [
  ['Apple Mail', [430, 120, 35]],
  ['Gmail', [330, 120, 27]],
  ['Outlook', [110, 150, 17]],
  ['Yahoo', [40, 30, 7]],
  ['Other', [29, 88, 7]],
];

const DEVICE_TYPES = ['mobile', 'desktop', 'tablet'] as const;
const TOTAL_CLICKS = 1_540;
const TOTAL_OPENS = 9_920;

export const devices = {
  total: TOTAL_OPENS,
  breakdown: CLICKS_BY_CLIENT.flatMap(([clientFamily, byDevice]) =>
    byDevice.map((clicks, index) => ({
      deviceType: DEVICE_TYPES[index] ?? 'unknown',
      clientFamily,
      opens: Math.round((clicks / TOTAL_CLICKS) * TOTAL_OPENS),
      clicks,
      share: clicks / TOTAL_CLICKS,
      isUnknown: false,
    })),
  ),
  unknownShare: 0,
};

/** G4a's provider breakdown (BACKEND PENDING). */
export const campaignProviders = {
  poolLabel: 'EU marketing pool',
  routing: 'round-robin',
  providers: [
    {
      connectionId: 'prv_ses_eu1',
      code: 'SES',
      name: 'Amazon SES · eu-west-1',
      delivered: 14_120,
      bounceRate: 0.008,
      clickRate: 0.048,
      uncertain: 0,
    },
    {
      connectionId: 'prv_sg_mkt',
      code: 'SG',
      name: 'SendGrid · marketing',
      delivered: 8_121,
      bounceRate: 0.011,
      clickRate: 0.042,
      uncertain: 335,
    },
  ],
  note: "SendGrid's webhook was down for 22 minutes on 8 Sep; 335 sends could not be confirmed and are counted as delivery uncertain, not delivered.",
};

/* ------------------------------------------------------------------ */
/* /reports — delivery per connection                                  */
/* ------------------------------------------------------------------ */

const providerRow = (
  providerConnectionId: string,
  sent: number,
  delivered: number,
  bouncedHard: number,
  complained: number,
) => ({
  providerConnectionId,
  sent,
  delivered,
  bouncedHard,
  complained,
  deliveryRate: rate({ kind: 'delivery', numerator: delivered, denominator: sent }),
  bounceRate: rate({ kind: 'bounce', numerator: bouncedHard, denominator: sent }),
  complaintRate: rate({ kind: 'complaint', numerator: complained, denominator: delivered }),
});

export const providerStats = {
  from: day(0),
  to: day(ACTIVITY.length - 1),
  providers: [
    providerRow('prv_ses_eu1', 128_410, 127_190, 612, 96),
    providerRow('prv_sg_mkt', 48_720, 47_640, 486, 41),
    providerRow('prv_smtp_1', 7_190, 7_060, 88, 8),
  ],
};
