/**
 * Section D fixtures: contacts, lists, tags and suppressions.
 *
 * DEMO ONLY. Every row here is read off `.design-rendered/frames/D/*` so the
 * preview looks like the frames: D1's eight contacts, D2a and D2b's two
 * drawers, D3's six list cards, D4's nine tags and D7's eight suppressions.
 * Ids are the ones the other sections already use — `ls_newsletter_eu` is
 * the list the campaign wizard's fixture selects — so a campaign, a segment
 * and a contact all name the same audience.
 *
 * Dates are written as the frames print them rather than derived from the
 * demo clock: the frames show a fixed September 2026 workspace, and a
 * relative date would drift away from the screenshot they are checked
 * against. `lastEngaged` and a timeline entry's `when` are already-rendered
 * strings for the same reason the API type says they are — they mix
 * relative and absolute forms against the workspace's timezone.
 */

const day = (value: string): string => `${value}T09:00:00.000Z`;

/* ---------------------------------------------------------------- tags -- */

const DUBAI = { id: 'tg_dubai', name: 'Dubai', color: 'rgb(14, 165, 233)' };
const DUBAI_LEISURE = { id: 'tg_dubai_leisure', name: 'dubai-leisure', color: 'rgb(14, 165, 233)' };
const VIP = { id: 'tg_vip', name: 'VIP', color: 'rgb(79, 70, 229)' };
const PARIS = { id: 'tg_paris', name: 'Paris', color: 'rgb(16, 185, 129)' };
const ABU_DHABI = { id: 'tg_abu_dhabi', name: 'Abu Dhabi', color: 'rgb(245, 158, 11)' };
const BERLIN = { id: 'tg_berlin', name: 'Berlin', color: 'rgb(220, 38, 38)' };
const FAMILY = { id: 'tg_family', name: 'Family', color: 'rgb(14, 165, 233)' };
const BUSINESS = { id: 'tg_business', name: 'Business', color: 'rgb(107, 114, 128)' };
const LOYALTY_TAG = { id: 'tg_loyalty', name: 'Loyalty', color: 'rgb(139, 92, 246)' };

/** D4's table: contact count and the segments that reference each tag. */
export const tags = [
  { ...DUBAI, contactCount: 12_840, segments: ['EU leisure · engaged', 'UAE leisure', 'F1 waitlist'], createdAt: day('2026-02-14') },
  { ...DUBAI_LEISURE, contactCount: 1_206, segments: [], createdAt: day('2026-09-03') },
  { ...VIP, contactCount: 2_310, segments: ['VIP re-engagement'], createdAt: day('2026-03-12') },
  { ...PARIS, contactCount: 4_120, segments: ['EU leisure · engaged'], createdAt: day('2026-01-03') },
  { ...ABU_DHABI, contactCount: 3_980, segments: ['F1 waitlist'], createdAt: day('2026-08-28') },
  { ...BERLIN, contactCount: 2_870, segments: ['EU leisure · engaged'], createdAt: day('2026-02-15') },
  { ...FAMILY, contactCount: 5_460, segments: ['Family holidays'], createdAt: day('2026-04-20') },
  { ...BUSINESS, contactCount: 1_150, segments: [], createdAt: day('2026-08-08') },
  { ...LOYALTY_TAG, contactCount: 9_412, segments: ['Loyalty tiers'], createdAt: day('2026-06-02') },
];

/* --------------------------------------------------------------- lists -- */

/**
 * D3's sparklines, as values rather than as the frame's y coordinates.
 *
 * The export draws a polyline in a 0–32 box where a smaller y is a larger
 * number, so each point below is `28 − y`: the same shape, in the units the
 * `Sparkline` component normalises.
 */
const trend = (...ys: number[]): number[] => ys.map((y) => 28 - y);

export const lists = [
  {
    id: 'ls_newsletter_eu',
    name: 'Newsletter EU',
    description: 'Monthly newsletter, EU audience',
    memberCount: 31_240,
    archived: false,
    footnote: 'Used by 8 campaigns',
    growth30d: 4.2,
    trend: trend(26, 25, 24, 22, 21, 19, 18, 15, 13, 10, 8),
    createdAt: day('2026-01-03'),
  },
  {
    id: 'ls_uae_offers',
    name: 'UAE offers',
    description: 'Flash sales and seasonal deals, UAE',
    memberCount: 14_880,
    archived: false,
    footnote: 'Used by 5 campaigns',
    growth30d: 9.8,
    trend: trend(28, 27, 26, 24, 20, 18, 17, 14, 10, 7, 4),
    createdAt: day('2026-02-14'),
  },
  {
    id: 'ls_loyalty',
    name: 'Loyalty',
    description: 'Members of the Northwind Miles programme',
    memberCount: 9_412,
    archived: false,
    footnote: 'Synced from CRM',
    growth30d: 1.1,
    trend: trend(18, 18, 17, 17, 16, 16, 16, 15, 15, 15, 14),
    createdAt: day('2026-06-02'),
  },
  {
    id: 'ls_f1_waitlist',
    name: 'Abu Dhabi F1 waitlist',
    description: 'Early-access sign-ups for race weekend',
    memberCount: 9_640,
    archived: false,
    footnote: 'Used by 1 campaign',
    growth30d: 38,
    trend: trend(30, 30, 29, 27, 22, 18, 14, 11, 8, 5, 2),
    createdAt: day('2026-08-28'),
  },
  {
    id: 'ls_partners',
    name: 'Partners & agencies',
    description: 'B2B contacts, trade only',
    memberCount: 420,
    archived: false,
    footnote: 'Manual',
    growth30d: 0,
    trend: trend(16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16),
    createdAt: day('2026-04-10'),
  },
  {
    id: 'ls_summer_2025',
    name: 'Summer 2025 campaign',
    description: null,
    memberCount: 6_120,
    archived: true,
    footnote: 'Archived 1 Sep 2026',
    growth30d: -0.4,
    trend: trend(12, 12, 13, 13, 13, 14, 14, 14, 15, 15, 15),
    createdAt: day('2025-05-02'),
  },
];

/* ------------------------------------------------------------ contacts -- */

export const contacts = [
  {
    id: 'ct_amira',
    email: 'amira.khalil@example.ae',
    firstName: 'Amira',
    lastName: 'Khalil',
    status: 'subscribed',
    tags: [VIP, DUBAI],
    lists: ['Newsletter EU', 'Loyalty'],
    lastEngaged: '2 days ago',
    attributes: { loyalty_tier: 'Gold', home_airport: 'DXB', last_booking: '2026-08-02 · Santorini' },
    createdAt: day('2026-03-12'),
  },
  {
    id: 'ct_julien',
    email: 'j.moreau@example.fr',
    firstName: 'Julien',
    lastName: 'Moreau',
    status: 'subscribed',
    tags: [PARIS],
    lists: ['Newsletter EU'],
    lastEngaged: '5 hours ago',
    attributes: { loyalty_tier: 'Silver', home_airport: 'CDG' },
    createdAt: day('2026-01-03'),
  },
  {
    id: 'ct_noor',
    email: 'noor.s@example.ae',
    firstName: 'Noor',
    lastName: 'Saleh',
    status: 'subscribed',
    tags: [DUBAI, FAMILY],
    lists: ['Newsletter EU', 'UAE offers'],
    lastEngaged: 'Yesterday',
    attributes: { loyalty_tier: 'Gold', home_airport: 'DXB' },
    createdAt: day('2026-09-19'),
  },
  {
    id: 'ct_sade',
    email: 's.okafor@example.co.uk',
    firstName: 'Sade',
    lastName: 'Okafor',
    status: 'unsubscribed',
    tags: [],
    lists: [],
    lastEngaged: '14 Aug 2026',
    attributes: {},
    createdAt: day('2025-11-21'),
  },
  {
    id: 'ct_omar',
    email: 'omar.h@example.ae',
    firstName: 'Omar',
    lastName: 'Haddad',
    status: 'bounced',
    tags: [ABU_DHABI],
    lists: ['Loyalty'],
    lastEngaged: 'Never',
    attributes: { home_airport: 'AUH' },
    createdAt: day('2026-06-02'),
  },
  {
    id: 'ct_lena',
    email: 'lena.b@example.de',
    firstName: 'Lena',
    lastName: 'Bauer',
    status: 'complained',
    tags: [BERLIN],
    lists: ['Newsletter EU'],
    lastEngaged: '9 Sep 2026',
    attributes: { loyalty_tier: 'Silver', home_airport: 'BER', last_booking: '' },
    createdAt: day('2026-02-15'),
  },
  {
    id: 'ct_karim',
    email: 'karim.n@example.ae',
    firstName: 'Karim',
    lastName: 'Nasser',
    status: 'subscribed',
    tags: [VIP, BUSINESS],
    lists: ['Loyalty'],
    lastEngaged: '3 days ago',
    attributes: { loyalty_tier: 'Platinum', home_airport: 'DXB' },
    createdAt: day('2026-08-08'),
  },
  {
    id: 'ct_elise',
    email: 'elise.d@example.be',
    firstName: 'Elise',
    lastName: 'Dubois',
    status: 'subscribed',
    tags: [],
    lists: ['Newsletter EU'],
    lastEngaged: '11 Sep 2026',
    attributes: {},
    createdAt: day('2026-07-30'),
  },
];

/** The header line on D1, and the footer's "1–8 of 48,213". */
export const audienceStats = {
  contacts: 48_213,
  subscribed: 45_102,
  suppressed: 2_318,
  matching: 48_213,
};

/** D1's tab strip, after "All contacts" and "Subscribed". */
export const savedViews = [
  { key: 'engaged-30d', label: 'Engaged · 30d' },
  { key: 'uae-leisure', label: 'UAE leisure' },
  { key: 'needs-attention', label: 'Needs attention' },
];

/**
 * The two drawers the frames draw, by contact id.
 *
 * Only the fields D2 adds on top of the table row: the consent block, the
 * suppression strip and the timeline. Every other contact falls back to a
 * generic detail assembled by the route.
 */
export const contactDetails: Record<string, Record<string, unknown>> = {
  ct_amira: {
    country: 'United Arab Emirates',
    language: 'en-AE',
    consentSource: 'Web form (double opt-in)',
    consentRecorded: '12 Mar 2026 · import by Dana Haddad',
    suppression: {
      suppressed: false,
      headline: 'Not suppressed.',
      detail: 'Eligible for every campaign that includes her lists or segments.',
      removable: false,
    },
    events: [
      { id: 'ev1', state: 'delivered', when: 'Today, 09:14', detail: 'Autumn Escapes: Dubai → Santorini · via Amazon SES' },
      { id: 'ev2', state: 'delivered', when: '8 Sep, 10:03', detail: 'September newsletter — EU edition' },
      { id: 'ev3', state: 'delivered', when: '5 Sep, 14:31', detail: 'Loyalty tier upgrade notice' },
      { id: 'ev4', state: 'sent', when: '16 Aug, 09:00', detail: 'Summer sale reminder · click on “Book now” 2 hours later' },
      { id: 'ev5', state: 'delivered', when: '12 Mar, 08:02', detail: 'Welcome to Northwind Miles' },
    ],
  },
  ct_lena: {
    country: 'Germany',
    language: 'de-DE',
    consentSource: 'CRM opt-in',
    consentRecorded: '15 Feb 2026 · import by Farah Al-Mansoori',
    suppression: {
      suppressed: true,
      headline: 'Suppressed · complaint · 9 Sep 2026.',
      detail:
        'Reported “September newsletter — EU edition” as spam via SendGrid feedback loop. Cannot be removed.',
      removable: false,
    },
    events: [
      { id: 'ev1', state: 'suppressed', when: '9 Sep, 11:40', detail: 'Added to suppressions · reason: complaint · source: SendGrid' },
      { id: 'ev2', state: 'complained', when: '9 Sep, 11:40', detail: 'September newsletter — EU edition · feedback loop report' },
      { id: 'ev3', state: 'delivered', when: '8 Sep, 10:03', detail: 'September newsletter — EU edition' },
      { id: 'ev4', state: 'delivered', when: '16 Aug, 09:00', detail: 'Summer sale reminder' },
      { id: 'ev5', state: 'delivered', when: '15 Feb, 08:10', detail: 'Welcome to Northwind Miles' },
    ],
  },
};

/* -------------------------------------------------------- suppressions -- */

export const suppressions = [
  { id: 'sp1', email: 'sade.okafor@example.co.uk', reason: 'unsubscribe', notes: null, source: 'September newsletter — EU edition', addedBy: 'Recipient', createdAt: day('2026-08-14') },
  { id: 'sp2', email: 'omar.h@example.ae', reason: 'hard_bounce', notes: '550 5.1.1 unknown recipient', source: 'Loyalty tier upgrade notice', addedBy: 'Amazon SES', createdAt: day('2026-09-05') },
  { id: 'sp3', email: 'lena.b@example.de', reason: 'complaint', notes: null, source: 'September newsletter — EU edition', addedBy: 'SendGrid', createdAt: day('2026-09-09') },
  { id: 'sp4', email: 'test.user@mailinator.com', reason: 'manual', notes: 'Internal test address', source: null, addedBy: 'Farah Al-Mansoori', createdAt: day('2026-09-12') },
  { id: 'sp5', email: 'no-reply@partner-hotel.ae', reason: 'global_block', notes: null, source: null, addedBy: 'Relayd', createdAt: day('2026-07-01') },
  { id: 'sp6', email: 'm.tan@example.sg', reason: 'hard_bounce', notes: '550 mailbox unavailable', source: 'Eid al-Etihad flash sale', addedBy: 'Amazon SES', createdAt: day('2026-09-16') },
  { id: 'sp7', email: 'h.brown@example.co.uk', reason: 'unsubscribe', notes: null, source: 'Eid al-Etihad flash sale', addedBy: 'Recipient', createdAt: day('2026-09-16') },
  { id: 'sp8', email: 'legal@competitor-travel.com', reason: 'manual', notes: null, source: null, addedBy: 'Dana Haddad', createdAt: day('2026-08-20') },
];

/** D7's "By reason" card. */
export const suppressionSummary = {
  total: 2_318,
  byReason: [
    { reason: 'unsubscribe', count: 1_462 },
    { reason: 'hard_bounce', count: 598 },
    { reason: 'complaint', count: 147 },
    { reason: 'manual', count: 84 },
    { reason: 'global_block', count: 27 },
  ],
};

/** The campaigns D7's Source filter offers. */
export const suppressionSources = [
  { value: 'any', label: 'Any campaign' },
  { value: 'cmp_september_newsletter', label: 'September newsletter — EU edition' },
  { value: 'cmp_eid_flash_sale', label: 'Eid al-Etihad flash sale' },
  { value: 'cmp_loyalty_notice', label: 'Loyalty tier upgrade notice' },
];
