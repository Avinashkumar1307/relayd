/**
 * Section H fixtures: sending pools and the senders they can be built from.
 *
 * DEMO ONLY. Every number is design/sample-data.js and the H frames' own:
 * three connections (`prv_ses_eu1`, `prv_sg_mkt`, `prv_smtp_1`), five
 * verified senders across them, and three pools.
 *
 * The arithmetic in the frames falls out of the connection table rather than
 * being written down, which is the point of the section: the newsletter pool
 * holds two senders and shows *one* connection's 8,800, because both of its
 * senders are on the same SES account. If these numbers are ever edited, edit
 * `CONNECTIONS` and let the pools recompute.
 */

export interface DemoConnection {
  id: string;
  label: string;
  monogram: string;
  /** What the connection has left today. */
  remainingToday: number;
  /** What it has accepted plus what it has left — the day's ceiling. */
  dailyLimit: number;
  perSecond: number;
}

export const CONNECTIONS: Record<string, DemoConnection> = {
  prv_ses_eu1: {
    id: 'prv_ses_eu1',
    label: 'Amazon SES · eu-west-1',
    monogram: 'SES',
    remainingToday: 8_800,
    dailyLimit: 50_000,
    perSecond: 14,
  },
  prv_sg_mkt: {
    id: 'prv_sg_mkt',
    label: 'SendGrid · marketing',
    monogram: 'SG',
    remainingToday: 87_070,
    dailyLimit: 100_000,
    perSecond: 50,
  },
  prv_smtp_1: {
    id: 'prv_smtp_1',
    label: 'SMTP · mail.northwind.travel',
    monogram: 'SMTP',
    remainingToday: 3_880,
    dailyLimit: 5_000,
    perSecond: 2,
  },
};

/** The five senders H1b lists, in the frame's order. */
export const eligibleSenders = [
  { id: 'snd_hello', email: 'hello@northwind.travel', connection: 'prv_ses_eu1', blockedReason: null },
  { id: 'snd_news', email: 'news@northwind.travel', connection: 'prv_ses_eu1', blockedReason: null },
  { id: 'snd_offers', email: 'offers@northwind.travel', connection: 'prv_sg_mkt', blockedReason: null },
  { id: 'snd_deals', email: 'deals@northwind-deals.com', connection: 'prv_sg_mkt', blockedReason: null },
  {
    id: 'snd_members',
    email: 'members@northwind.travel',
    connection: 'prv_smtp_1',
    blockedReason: 'Pending DNS',
  },
];

interface DemoPoolSeed {
  id: string;
  name: string;
  strategy: 'round_robin' | 'failover';
  memberIds: string[];
  /** H1a's line under the headroom bar — the frames word each one. */
  note: string;
  usedBy: string[];
}

export const POOL_SEEDS: DemoPoolSeed[] = [
  {
    id: 'pool_eu_mkt',
    name: 'EU marketing pool',
    strategy: 'round_robin',
    memberIds: ['snd_hello', 'snd_offers'],
    note: '2 connections · counted once each',
    usedBy: ['Autumn Escapes', 'F1 early access', 'September newsletter'],
  },
  {
    id: 'pool_news',
    name: 'Newsletter pool',
    strategy: 'failover',
    memberIds: ['snd_news', 'snd_hello'],
    note: '1 connection · both senders share SES quota',
    usedBy: ['September newsletter'],
  },
  {
    id: 'pool_txn',
    name: 'Transactional fallback',
    strategy: 'failover',
    memberIds: ['snd_deals', 'snd_members'],
    note: 'SMTP member is best-effort',
    usedBy: [],
  },
];
