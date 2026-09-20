import type { SenderIdentityRow } from '@relayd/db';

/**
 * The SPF / DKIM / DMARC view behind one sender (design frame E2b).
 *
 * **This module reports; it does not resolve.** It has no DNS client and no
 * provider client. Everything it returns is read off `sender_identities`,
 * which `POST /providers/:id/identities/sync` fills from the adapter's
 * `listVerifiedIdentities` — the verification machinery in
 * `@relayd/email-providers`. Re-implementing a resolver here would give the
 * product two answers to "is DKIM set up", and the provider's answer is the
 * one that decides whether mail actually leaves.
 *
 * The shape is the browser's: `apps/web/src/api/providers.ts`, `SenderDns`.
 */

export type DnsRecordKind = 'SPF' | 'DKIM' | 'DMARC';
export type DnsRecordStatus = 'verified' | 'pending' | 'failed';

export interface DnsRecordView {
  kind: DnsRecordKind;
  purpose: string;
  status: DnsRecordStatus;
  type: string;
  host: string;
  value: string;
  /** What the last lookup actually found. Never a guess. */
  found: string;
}

export interface SenderDnsView {
  senderId: string;
  problem: { title: string; detail: string } | null;
  records: DnsRecordView[];
  lastCheckedAt: string;
  nextCheckInMinutes: number;
}

/** How often the identity sync re-reads a provider's verification state. */
export const DNS_RECHECK_MINUTES = 15;

/** What each record is for, in the words E2b prints under the kind. */
const PURPOSE: Readonly<Record<DnsRecordKind, string>> = {
  SPF: 'authorises the server to send',
  DKIM: 'signs each message',
  DMARC: 'tells inboxes what to do on failure',
};

const KINDS: readonly DnsRecordKind[] = ['SPF', 'DKIM', 'DMARC'];

/**
 * A record as the provider reported it, stored on `sender_identities.dns_records`.
 *
 * Every field optional: providers report wildly different subsets, and a
 * missing host is a missing host rather than a reason to drop the row.
 */
interface StoredRecord {
  type?: unknown;
  host?: unknown;
  value?: unknown;
  found?: unknown;
  status?: unknown;
}

/**
 * Turns one identity row into the drawer.
 *
 * `now` is a parameter so the "next check in" countdown is testable without
 * waiting a quarter of an hour.
 */
export function senderDnsView(input: {
  senderId: string;
  identity: SenderIdentityRow;
  now: Date;
}): SenderDnsView {
  const { identity, now } = input;
  const domain = domainOf(identity);

  const stored = storedRecords(identity.dnsRecords);

  const records = KINDS.map((kind) =>
    recordFor({
      kind,
      domain,
      stored: stored[kind],
      reported: reportedStatus(kind, identity),
    }),
  );

  const lastCheckedAt = identity.lastCheckedAt ?? identity.verifiedAt ?? identity.createdAt;

  return {
    senderId: input.senderId,
    problem: problemFor(records),
    records,
    lastCheckedAt: lastCheckedAt.toISOString(),
    nextCheckInMinutes: minutesUntilNextCheck(lastCheckedAt, now),
  };
}

/** The domain the records live under: the identity itself, or its address's. */
function domainOf(identity: SenderIdentityRow): string {
  const value = identity.value.trim().toLowerCase();
  if (identity.kind === 'domain') return value;

  const at = value.lastIndexOf('@');
  return at === -1 ? value : value.slice(at + 1);
}

function storedRecords(raw: Record<string, unknown> | null): Partial<Record<DnsRecordKind, StoredRecord>> {
  if (raw === null) return {};

  const out: Partial<Record<DnsRecordKind, StoredRecord>> = {};

  for (const kind of KINDS) {
    // Providers are inconsistent about case; accept both rather than showing
    // an empty drawer because one of them wrote "dkim".
    const entry = raw[kind] ?? raw[kind.toLowerCase()];
    if (typeof entry === 'object' && entry !== null) out[kind] = entry as StoredRecord;
  }

  return out;
}

function recordFor(input: {
  kind: DnsRecordKind;
  domain: string;
  stored: StoredRecord | undefined;
  reported: DnsRecordStatus | null;
}): DnsRecordView {
  const stored = input.stored ?? {};

  const status =
    normaliseStatus(stored.status) ?? input.reported ?? 'pending';

  const host = text(stored.host) ?? defaultHost(input.kind, input.domain);
  const value = text(stored.value) ?? '';

  return {
    kind: input.kind,
    purpose: PURPOSE[input.kind],
    status,
    type: text(stored.type) ?? 'TXT',
    host,
    value,
    // Never invented. When the provider told us nothing, the honest answer is
    // that nothing has been looked up — not a fabricated "record found".
    found:
      text(stored.found) ??
      (status === 'verified'
        ? `${input.kind} accepted by the provider`
        : 'Not checked yet — sync this connection’s identities to fetch it'),
  };
}

/**
 * Where the record belongs, when the provider did not say.
 *
 * DKIM is left blank on purpose: its host carries a provider-chosen selector
 * (`rl1._domainkey.…`, `s1._domainkey.…`), and printing a made-up selector
 * would have a customer publish a record that can never verify.
 */
function defaultHost(kind: DnsRecordKind, domain: string): string {
  if (kind === 'SPF') return domain;
  if (kind === 'DMARC') return `_dmarc.${domain}`;
  return '';
}

/** The identity column for this record kind, if the provider filled one in. */
function reportedStatus(kind: DnsRecordKind, identity: SenderIdentityRow): DnsRecordStatus | null {
  const raw =
    kind === 'SPF'
      ? identity.spfStatus
      : kind === 'DKIM'
        ? identity.dkimStatus
        : identity.dmarcStatus;

  const parsed = normaliseStatus(raw);
  if (parsed !== null) return parsed;

  // Nothing per-record. A fully verified identity means the provider is
  // willing to send from it, which is weaker than "this record is right" —
  // so it maps to verified, and anything else stays pending rather than
  // being reported as a failure nobody observed.
  return identity.verificationStatus === 'verified' ? 'verified' : null;
}

/**
 * Provider vocabulary, folded onto three states.
 *
 * SES says `Success` / `Pending` / `Failed` / `TemporaryFailure`, SendGrid
 * says `valid`, Mailgun says `active`. Matching on substrings rather than an
 * exhaustive table because the alternative is a new provider string showing
 * the customer a blank cell.
 */
export function normaliseStatus(raw: unknown): DnsRecordStatus | null {
  if (typeof raw !== 'string') return null;

  const value = raw.trim().toLowerCase();
  if (value === '') return null;

  if (/(verified|success|valid|active|pass|ok|true)/u.test(value)) return 'verified';
  if (/(fail|error|invalid|missing|not found|expired|revoked)/u.test(value)) return 'failed';

  return 'pending';
}

/** The strip under the drawer header. Null when all three are verified. */
function problemFor(records: readonly DnsRecordView[]): { title: string; detail: string } | null {
  const failed = records.filter((record) => record.status === 'failed');
  const pending = records.filter((record) => record.status === 'pending');

  if (failed.length === 0 && pending.length === 0) return null;

  const worst = failed.length > 0 ? failed : pending;
  const kinds = worst.map((record) => record.kind);

  return {
    title:
      failed.length > 0
        ? `${list(kinds)} ${kinds.length === 1 ? 'record was' : 'records were'} not found.`
        : `${list(kinds)} ${kinds.length === 1 ? 'is' : 'are'} still pending.`,
    detail: `Add ${kinds.length === 1 ? 'it' : 'them'} at your DNS host, then check again. Propagation can take up to 48 hours; we re-check every ${DNS_RECHECK_MINUTES} minutes.`,
  };
}

function list(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1] ?? ''}`;
}

function minutesUntilNextCheck(lastCheckedAt: Date, now: Date): number {
  const elapsed = (now.getTime() - lastCheckedAt.getTime()) / 60_000;
  // Floored at zero rather than going negative, and at the full interval when
  // the clock is somehow ahead of the last check.
  if (!Number.isFinite(elapsed) || elapsed < 0) return DNS_RECHECK_MINUTES;

  return Math.max(0, Math.ceil(DNS_RECHECK_MINUTES - elapsed));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
