// Shared fixtures for Relayd frames. Sample workspace: Northwind Voyages (fictional travel-tech, UAE/EU audience).
export const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

export const workspace = { name: 'Northwind Voyages', monogram: 'NV', plan: 'Growth', slug: 'northwind-voyages', timezone: 'Asia/Dubai', tzLabel: 'GST (UTC+4)', contacts: 48213, contactLimit: 100000, seats: 6, seatLimit: 10 };
export const workspaces = [
  { name: 'Northwind Voyages', monogram: 'NV', plan: 'Growth', role: 'Owner' },
  { name: 'Aurelia Hotels Group', monogram: 'AH', plan: 'Starter', role: 'Admin' },
  { name: 'Kite & Compass Travel', monogram: 'KC', plan: 'Scale', role: 'Editor' },
];
export const user = { name: 'Dana Haddad', initials: 'DH', role: 'Owner', email: 'dana@northwind.travel' };
export const period = { label: '1–19 Sep 2026', renews: '1 Oct 2026', daysLeft: 12, sent: 184320, limit: 250000, uncertain: 412 };
export const rates = { click: 3.8, clickDelta: 0.4, open: 41.2, openDelta: -1.1, bounce: 0.9, soft: 0.6, hard: 0.3, complaint: 0.08, complaintThreshold: 0.3 };

export const providers = [
  { id: 'prv_ses_eu1', kind: 'SES', name: 'Amazon SES', label: 'eu-west-1 · production', health: 'healthy', dailyUsed: 41200, dailyLimit: 50000, perSecond: 14, webhook: 'Receiving events', verified: '12 Mar 2026' },
  { id: 'prv_sg_mkt', kind: 'SG', name: 'SendGrid', label: 'marketing', health: 'degraded', dailyUsed: 12930, dailyLimit: 100000, perSecond: 50, webhook: 'No events since 08:40', verified: '2 Jun 2026' },
  { id: 'prv_smtp_1', kind: 'SMTP', name: 'SMTP', label: 'mail.northwind.travel', health: 'healthy', dailyUsed: 1120, dailyLimit: 5000, perSecond: 2, webhook: 'Best-effort feedback', verified: '20 Aug 2026' },
];

export const campaigns = [
  { id: 'cmp_8f3k2a', name: 'Autumn Escapes: Dubai → Santorini', state: 'sending', recipients: 48213, counts: { delivered: 29876, sending: 1240, pending: 16595, soft: 214, hard: 96, complaint: 12, failed: 0, uncertain: 180 }, clicks: 1187, when: 'Started today, 09:00', sender: 'hello@northwind.travel', pool: 'EU marketing pool' },
  { id: 'cmp_7q1m9z', name: 'September newsletter — EU edition', state: 'completed', recipients: 22870, counts: { delivered: 22241, soft: 198, hard: 87, complaint: 9, uncertain: 335 }, clicks: 1023, when: '8 Sep, 10:00', sender: 'news@northwind.travel' },
  { id: 'cmp_2x8d4c', name: 'Abu Dhabi F1 weekend — early access', state: 'scheduled', recipients: 9640, counts: { pending: 9640 }, clicks: null, when: '24 Sep, 09:00 GST', sender: 'hello@northwind.travel' },
  { id: 'cmp_6r9s2e', name: 'Eid al-Etihad flash sale', state: 'paused', recipients: 18450, counts: { delivered: 6120, pending: 12150, soft: 64, hard: 38, complaint: 21, uncertain: 57 }, clicks: 129, when: 'Paused 16 Sep, 11:12', sender: 'offers@northwind.travel', note: 'Complaint rate 0.34%' },
  { id: 'cmp_5n2v7b', name: 'Loyalty tier upgrade notice', state: 'completed_with_errors', recipients: 3120, counts: { delivered: 2880, soft: 41, hard: 22, complaint: 3, failed: 24, uncertain: 150 }, clicks: 201, when: '5 Sep, 14:30', sender: 'members@northwind.travel' },
  { id: 'cmp_3h7t6w', name: 'Summer sale wrap-up', state: 'held', recipients: 14200, counts: { pending: 14200 }, clicks: null, when: 'Held since 17 Sep', sender: 'offers@northwind.travel', note: 'Held by billing' },
  { id: 'cmp_9k4p1r', name: 'Ramadan 2027 pre-registration', state: 'draft', recipients: null, counts: {}, clicks: null, when: 'Edited 2 days ago', sender: '—' },
];

// Daily emails accepted by provider, 21 Aug → 19 Sep 2026 (index 29 = today, partial)
export const activity = [1240, 980, 2110, 8420, 3160, 1520, 640, 720, 9840, 4210, 2380, 1160, 880, 12460, 5120, 2260, 1040, 760, 690, 11280, 6420, 2840, 1310, 920, 7860, 3440, 1780, 1020, 13120, 9760];
export const activityLabel = (i) => (i < 11 ? `${21 + i} Aug` : `${i - 10} Sep`);

export const attention = [
  { tone: 'danger', title: 'SendGrid · marketing webhook failing', detail: 'No events received since 08:40 GST. Delivery states for 1 campaign will show as uncertain until it is fixed.', action: 'Fix connection' },
  { tone: 'warning', title: 'Eid al-Etihad flash sale paused automatically', detail: 'Complaint rate reached 0.34%, above the 0.3% threshold. 12,150 recipients have not been sent.', action: 'Review campaign' },
  { tone: 'warning', title: 'Summer sale wrap-up held by billing', detail: 'Invoice INV-2026-0912 (USD 249.00) is 4 days past due. The campaign launches once payment clears.', action: 'Update payment method' },
];

export const checklist = [
  { step: 1, title: 'Connect a provider', status: 'done', detail: 'Amazon SES · eu-west-1 connected 12 Mar', action: 'View' },
  { step: 2, title: 'Verify a sender', status: 'pending', detail: 'hello@northwind.travel · waiting for DKIM records', action: 'Check DNS' },
  { step: 3, title: 'Import contacts', status: 'todo', detail: 'CSV or XLSX, up to 50 MB', action: 'Import' },
  { step: 4, title: 'Send a test', status: 'locked', detail: 'Available once a sender is verified', action: 'Send test' },
];
