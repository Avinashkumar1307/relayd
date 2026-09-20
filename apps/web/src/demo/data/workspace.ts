import { iso } from './clock.js';
import { WORKSPACE_ID } from './auth.js';

/**
 * Section J fixtures: the workspace record, the people in it, the signed-in
 * account's sessions, and the audit log.
 *
 * DEMO ONLY. Every value is the one the J frames print, so the preview and
 * the design can be put side by side: six members and two pending
 * invitations against ten seats on Growth (J2a), four sessions with the
 * MacBook marked "This device" (J5), and the ten audit rows of J6.
 *
 * The frozen clock is 19 Sep 2026 12:00 UTC — 16:00 in Asia/Dubai, the
 * workspace's zone.
 */

/* ------------------------------------------------------------------ */
/* The workspace record                                                */
/* ------------------------------------------------------------------ */

export const workspace = {
  id: WORKSPACE_ID,
  name: 'Northwind Voyages',
  slug: 'northwind-voyages',
  timezone: 'Asia/Dubai',
  role: 'owner',
  defaultCurrency: 'AED',
  status: 'active',
  createdAt: '2026-02-14T06:00:00.000Z',
  createdByName: 'Dana Haddad',
  planName: 'Growth',
  seatLimit: 10,
  dataRegion: 'EU (Frankfurt)',
  analyticsRetentionMonths: 13,
  defaultSenderId: 'snd1',
  counts: { contacts: 48_213, campaigns: 126, providerConnections: 3 },
};

/* ------------------------------------------------------------------ */
/* J2a — members and invitations                                       */
/* ------------------------------------------------------------------ */

/**
 * `u1` is the signed-in user, so `auth.ts`'s session id is reused here: the
 * Member column marks exactly one row "You", and it has to be the right one.
 */
export const YOU_ID = '0192f4a1-0000-7000-8000-00000000000a';

export const team = [
  {
    userId: YOU_ID,
    name: 'Dana Haddad',
    email: 'dana@northwind.travel',
    role: 'owner',
    joinedAt: '2026-02-14T06:00:00.000Z',
    lastActiveLabel: 'Active now',
  },
  {
    userId: 'usr_farah',
    name: 'Farah Al-Mansoori',
    email: 'farah@northwind.travel',
    role: 'admin',
    joinedAt: iso(180),
    lastActiveLabel: '2 hours ago',
  },
  {
    userId: 'usr_omar',
    name: 'Omar Haddad',
    email: 'omar.h@northwind.travel',
    role: 'editor',
    joinedAt: iso(150),
    lastActiveLabel: 'Yesterday, 18:40',
  },
  {
    userId: 'usr_julien',
    name: 'Julien Moreau',
    email: 'julien@northwind.travel',
    role: 'editor',
    joinedAt: iso(120),
    lastActiveLabel: '3 days ago',
  },
  {
    userId: 'usr_sade',
    name: 'Sade Okafor',
    email: 'sade@northwind.travel',
    role: 'viewer',
    joinedAt: iso(90),
    lastActiveLabel: '12 Sep 2026',
  },
  {
    userId: 'usr_lena',
    name: 'Lena Bauer',
    email: 'lena@northwind.travel',
    role: 'viewer',
    joinedAt: iso(60),
    lastActiveLabel: '28 Aug 2026',
  },
];

export const invitations = [
  {
    id: 'inv_priya',
    email: 'priya.n@northwind.travel',
    role: 'editor',
    invitedByName: 'Farah Al-Mansoori',
    expiresAt: '2026-09-25T06:00:00.000Z',
    createdAt: iso(1),
  },
  {
    id: 'inv_tom',
    email: 'tom@agency-partner.eu',
    role: 'viewer',
    invitedByName: 'Dana Haddad',
    expiresAt: '2026-09-22T06:00:00.000Z',
    createdAt: iso(4),
  },
];

/* ------------------------------------------------------------------ */
/* J5 — the account and its sessions                                   */
/* ------------------------------------------------------------------ */

export const profile = {
  id: YOU_ID,
  name: 'Dana Haddad',
  email: 'dana@northwind.travel',
  emailVerified: true,
};

export const sessions = [
  {
    id: 'ses_mac',
    device: 'MacBook Pro 14"',
    deviceKind: 'desktop',
    client: 'Chrome 129 · macOS 15',
    location: 'Dubai, United Arab Emirates',
    ip: '94.204.118.22',
    lastActiveLabel: 'Active now',
    current: true,
  },
  {
    id: 'ses_iphone',
    device: 'iPhone 15',
    deviceKind: 'mobile',
    client: 'Relayd for iOS 2.4',
    location: 'Dubai, United Arab Emirates',
    ip: '94.204.118.22',
    lastActiveLabel: '2 hours ago',
    current: false,
  },
  {
    id: 'ses_windows',
    device: 'Windows PC',
    deviceKind: 'desktop',
    client: 'Edge 128 · Windows 11',
    location: 'Berlin, Germany',
    ip: '85.214.9.140',
    lastActiveLabel: '3 days ago',
    current: false,
  },
  {
    id: 'ses_unknown',
    device: 'Unknown device',
    deviceKind: 'unknown',
    client: 'Firefox 130 · Linux',
    location: 'Amsterdam, Netherlands',
    ip: '145.131.7.201',
    lastActiveLabel: '12 Sep 2026',
    current: false,
  },
];

/* ------------------------------------------------------------------ */
/* J6 — the audit log                                                  */
/* ------------------------------------------------------------------ */

const DANA = { kind: 'user', name: 'Dana Haddad', initials: 'DH' };
const FARAH = { kind: 'user', name: 'Farah Al-Mansoori', initials: 'FA' };
const OMAR = { kind: 'user', name: 'Omar Haddad', initials: 'OH' };
/** The navy monogram: an action nobody took by hand. */
const RELAYD = { kind: 'system', name: 'Relayd', initials: 'R' };

/**
 * The ten rows of J6, in the frame's order.
 *
 * `occurredAt` is UTC and the page renders it in Asia/Dubai, which is why
 * 06:42:18Z is drawn as 10:42:18: the audit log is the one place where a
 * time read in the wrong zone changes what somebody concludes.
 */
export const auditEvents = [
  {
    id: 'aud_01',
    occurredAt: '2026-09-19T06:42:18.000Z',
    actor: DANA,
    action: 'api_key.revealed',
    resource: 'rk_live_7f3a…',
    details: 'Revealed once by the creator; masked permanently',
  },
  {
    id: 'aud_02',
    occurredAt: '2026-09-19T05:00:02.000Z',
    actor: RELAYD,
    action: 'campaign.launched',
    resource: 'cmp_8f3k2a',
    details: 'Autumn Escapes · 48,213 recipients · approved launch executed',
  },
  {
    id: 'aud_03',
    occurredAt: '2026-09-18T12:20:41.000Z',
    actor: FARAH,
    action: 'campaign.launch_approved',
    resource: 'cmp_8f3k2a',
    details: 'Request from Omar Haddad approved; scheduled 19 Sep 09:00',
  },
  {
    id: 'aud_04',
    occurredAt: '2026-09-18T11:02:09.000Z',
    actor: OMAR,
    action: 'campaign.launch_requested',
    resource: 'cmp_8f3k2a',
    details: 'Pre-flight: 7 pass, 1 warn (quota headroom)',
  },
  {
    id: 'aud_05',
    occurredAt: '2026-09-17T07:00:00.000Z',
    actor: RELAYD,
    action: 'campaign.held',
    resource: 'cmp_3h7t6w',
    details: 'Summer sale wrap-up held: invoice INV-2026-0912 is 4 days past due',
  },
  {
    id: 'aud_06',
    occurredAt: '2026-09-16T07:12:33.000Z',
    actor: RELAYD,
    action: 'campaign.auto_paused',
    resource: 'cmp_6r9s2e',
    details: 'Complaint rate 0.34% exceeded 0.3% threshold after 6,120 sends',
  },
  {
    id: 'aud_07',
    occurredAt: '2026-09-15T04:30:57.000Z',
    actor: DANA,
    action: 'import.completed',
    resource: 'imp_2a9x7',
    details: '12,480 created · 1,104 updated · 96 skipped · consent attested',
  },
  {
    id: 'aud_08',
    occurredAt: '2026-09-14T10:11:20.000Z',
    actor: FARAH,
    action: 'member.role_changed',
    resource: 'omar.h@northwind.trav…',
    details: 'Viewer → Editor',
  },
  {
    id: 'aud_09',
    occurredAt: '2026-09-12T05:45:05.000Z',
    actor: DANA,
    action: 'provider.credentials_rotated',
    resource: 'prv_sg_mkt',
    details: 'SendGrid · marketing API key rotated',
  },
  {
    id: 'aud_10',
    occurredAt: '2026-09-08T06:00:00.000Z',
    actor: RELAYD,
    action: 'campaign.completed',
    resource: 'cmp_7q1m9z',
    details: 'September newsletter — EU edition · 22,241 delivered · 335 uncertain',
  },
];

/**
 * What the footer counts.
 *
 * J6 says "1–10 of 3,412 events", and ten fixtures cannot add up to that.
 * The demo answers with the frame's total and pages through the ten it has,
 * which is enough to show that the pager and the count are wired to the
 * server's number rather than to `rows.length`.
 */
export const AUDIT_TOTAL = 3412;

export const auditActions = [
  'api_key.revealed',
  'campaign.auto_paused',
  'campaign.completed',
  'campaign.held',
  'campaign.launch_approved',
  'campaign.launch_requested',
  'campaign.launched',
  'import.completed',
  'member.role_changed',
  'provider.credentials_rotated',
];
