import type { ReactNode } from 'react';
import { Monogram, type StateStyle } from '@relayd/ui';
import { MONTHS } from '../analytics/format.js';
import {
  PROVIDER_INFO,
  type Connection,
  type Credentials,
  type ProviderType,
  type SenderIdentity,
  type WebhookState,
} from '../../api/providers.js';

/**
 * The pieces sections E1 and E2 both draw.
 *
 * Kept out of the page files because a connection's health badge, its
 * monogram tile and its quota bar appear on the provider card, in the sender
 * table and in the sender drawer, and three copies of the same mapping is
 * how "Degraded" becomes "degraded" on one screen and "Warning" on another.
 */

// ---------------------------------------------------------------- vocabulary

/**
 * Connection status as the frames name it.
 *
 * `HEALTH` in @relayd/ui covers healthy / degraded / failed, which is three
 * of the seven states the API can return; the other four still have to be
 * drawn, so the whole map lives here in the same shape.
 */
const CONNECTION_STATES_ENTRIES = {
  active: { label: 'Healthy', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  error: { label: 'Failed', tone: 'danger' },
  revoked: { label: 'Revoked', tone: 'danger' },
  verifying: { label: 'Verifying', tone: 'info', pulse: true },
  pending: { label: 'Pending', tone: 'neutral' },
  disabled: { label: 'Disabled', tone: 'neutral' },} as const satisfies Record<string, StateStyle>;
// Widened like the maps in @relayd/ui/states: `as const` keeps the keys,
// the annotation keeps `.pulse` readable on entries that do not set it.
export const CONNECTION_STATES: Record<keyof typeof CONNECTION_STATES_ENTRIES, StateStyle> =
  CONNECTION_STATES_ENTRIES;

/** Identity verification, as E2a's "Verification" column names it. */
const VERIFICATION_STATES_ENTRIES = {
  verified: { label: 'Verified', tone: 'success' },
  pending: { label: 'Pending DNS', tone: 'warning', pulse: true },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'danger' },
  unknown: { label: 'No identity', tone: 'neutral' },} as const satisfies Record<string, StateStyle>;
// Widened like the maps in @relayd/ui/states: `as const` keeps the keys,
// the annotation keeps `.pulse` readable on entries that do not set it.
export const VERIFICATION_STATES: Record<keyof typeof VERIFICATION_STATES_ENTRIES, StateStyle> =
  VERIFICATION_STATES_ENTRIES;

/**
 * A sender's own operating state.
 *
 * E2a has no status column — the table answers "can this address send",
 * which is the verification badge — so the one place this can be said is
 * the E2b drawer, where there is room. Saying it somewhere matters: a
 * sender in cooldown is a campaign that will stall, and the author choosing
 * a From address has no other way to find that out. `active` is absent on
 * purpose; a badge on every healthy row is noise.
 */
const SENDER_STATES_ENTRIES = {
  paused: { label: 'Paused', tone: 'neutral' },
  cooling_down: { label: 'Cooling down', tone: 'warning', pulse: true },
  disabled: { label: 'Disabled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },} as const satisfies Record<string, StateStyle>;
// Widened like the maps in @relayd/ui/states: `as const` keeps the keys,
// the annotation keeps `.pulse` readable on entries that do not set it.
export const SENDER_STATES: Record<keyof typeof SENDER_STATES_ENTRIES, StateStyle> =
  SENDER_STATES_ENTRIES;

/** The badge in E2b's record header, and in the drawer's own header. */
const RECORD_STATES_ENTRIES = {
  verified: { label: 'Verified', tone: 'success' },
  pending: { label: 'Pending DNS', tone: 'warning', pulse: true },
  failed: { label: 'Failed', tone: 'danger' },} as const satisfies Record<string, StateStyle>;
// Widened like the maps in @relayd/ui/states: `as const` keeps the keys,
// the annotation keeps `.pulse` readable on entries that do not set it.
export const RECORD_STATES: Record<keyof typeof RECORD_STATES_ENTRIES, StateStyle> =
  RECORD_STATES_ENTRIES;

const WEBHOOK_TONE: Record<WebhookState, StateStyle> = {
  receiving: { label: 'Receiving events', tone: 'success' },
  no_events: { label: 'No events', tone: 'danger' },
  best_effort: { label: 'Best-effort · no webhooks', tone: 'info' },
  not_configured: { label: 'Not configured', tone: 'warning' },
};

// -------------------------------------------------------------------- tiles

const TILE: Record<44 | 24 | 16, string> = {
  44: '',
  24: 'grid h-6 w-6 flex-none place-items-center rounded-badge bg-brand-soft font-mono text-[9px] font-medium text-brand',
  16: 'grid h-4 w-4 flex-none place-items-center rounded-4 bg-brand-soft font-mono text-[7px] font-medium text-brand',
};

/**
 * The provider's letters in a soft brand tile.
 *
 * 44px is `Monogram`; 24px (the sender table) and 16px (the drawer's
 * connection chip) are not sizes the sheet's Monogram offers, so they are
 * drawn here from the same tokens rather than by bending a component that
 * does not have them.
 */
export function ProviderTile({
  type,
  size = 44,
}: {
  type: ProviderType;
  size?: 44 | 24 | 16;
}) {
  const info = PROVIDER_INFO[type];

  if (size === 44) {
    return (
      <Monogram size={44} mono>
        {info.monogram}
      </Monogram>
    );
  }

  return (
    <span aria-hidden="true" className={TILE[size]}>
      {info.monogram}
    </span>
  );
}

// ------------------------------------------------------------------ helpers

/**
 * "12 Mar 2026", as every frame in section E writes a date.
 *
 * The month comes from `MONTHS` rather than from the locale because en-GB
 * abbreviates September to "Sept", which is not how any frame spells it.
 */
export function formatDay(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

export const fmtNumber = (value: number): string => value.toLocaleString('en-US');

export interface Quota {
  used: number;
  limit: number | null;
  percent: number;
  /** The line under the bar. */
  note: string;
}

/**
 * A connection's daily quota, and what the bar says about it.
 *
 * `quotaNote` is the sentence the frames write and the API does not send yet
 * (BACKEND PENDING), so a plain "N% used" stands in until it does.
 */
export function quotaOf(connection: Connection): Quota {
  const used = connection.quotaSnapshot?.sentLast24Hours ?? 0;
  const limit = connection.quotaSnapshot?.max24Hour ?? null;
  const percent = limit === null || limit === 0 ? 0 : Math.min(100, (used / limit) * 100);

  return {
    used,
    limit,
    percent,
    note: connection.quotaNote ?? `${Math.round(percent)}% used`,
  };
}

/** Amber once the provider's own cap is in sight; brand below that. */
export const quotaBarClass = (percent: number): string =>
  percent >= 80 ? 'bg-warning' : 'bg-brand';

export interface WebhookView {
  state: StateStyle;
  detail: string;
}

/**
 * The "Inbound webhook" cell.
 *
 * Derived from capabilities when the API has nothing to say, so an SMTP
 * connection still reads "Best-effort · no webhooks" rather than blank.
 */
export function webhookOf(connection: Connection): WebhookView {
  const supplied = connection.webhook;
  if (supplied !== undefined) {
    return {
      state: { ...WEBHOOK_TONE[supplied.state], label: supplied.label },
      detail: supplied.detail,
    };
  }

  if (connection.capabilities.supportsWebhooks === false) {
    return {
      state: WEBHOOK_TONE.best_effort,
      detail: 'No webhooks · delivery is inferred from the SMTP response only',
    };
  }

  if (!connection.hasWebhookSecret) {
    return {
      state: WEBHOOK_TONE.not_configured,
      detail: 'No endpoint configured · bounces and complaints will not reach Relayd',
    };
  }

  return { state: WEBHOOK_TONE.receiving, detail: 'Waiting for the next event' };
}

/** E2a's sub-line under a sender's quota bar. */
export function verificationNote(identity: SenderIdentity | undefined): string {
  if (identity === undefined) return 'No identity on this connection';
  if (identity.verificationStatus === 'verified') return 'shared connection quota';
  if (identity.note !== undefined && identity.note !== null && identity.note !== '') {
    return identity.note;
  }
  return identity.dkimStatus === null ? 'DKIM record missing' : 'DNS check has not passed';
}

// -------------------------------------------------------- credential fields

export interface CredentialField {
  name: string;
  label: string;
  kind?: 'text' | 'password' | 'number' | 'select' | 'checkbox';
  placeholder?: string;
  mono?: boolean;
  options?: readonly { value: string; label: string }[];
  initial?: string;
}

export interface CredentialForm {
  fields: readonly CredentialField[];
  /** E1c's "Required IAM permissions" block, shown beside the fields. */
  chips?: { label: string; items: readonly string[] };
}

const SES_REGIONS = [
  { value: 'us-east-1', label: 'us-east-1 · N. Virginia' },
  { value: 'us-west-2', label: 'us-west-2 · Oregon' },
  { value: 'eu-west-1', label: 'eu-west-1 · Europe (Ireland)' },
  { value: 'eu-central-1', label: 'eu-central-1 · Europe (Frankfurt)' },
  { value: 'me-central-1', label: 'me-central-1 · UAE' },
  { value: 'ap-southeast-2', label: 'ap-southeast-2 · Sydney' },
] as const;

export const CREDENTIALS: Record<ProviderType, CredentialForm> = {
  ses: {
    fields: [
      { name: 'accessKeyId', label: 'Access key ID', mono: true, placeholder: 'AKIA…' },
      { name: 'secretAccessKey', label: 'Secret access key', kind: 'password', mono: true },
      { name: 'region', label: 'Region', kind: 'select', options: SES_REGIONS, initial: 'eu-west-1' },
    ],
    chips: {
      label: 'Required IAM permissions',
      items: ['ses:SendEmail', 'ses:SendRawEmail', 'ses:GetSendQuota', 'sns:Subscribe'],
    },
  },
  sendgrid: {
    fields: [{ name: 'apiKey', label: 'API key', kind: 'password', mono: true }],
    chips: { label: 'Required scopes', items: ['mail.send'] },
  },
  mailgun: {
    fields: [
      { name: 'apiKey', label: 'Sending API key', kind: 'password', mono: true },
      { name: 'domain', label: 'Domain', mono: true, placeholder: 'mg.northwind.travel' },
      {
        name: 'region',
        label: 'Region',
        kind: 'select',
        options: [
          { value: 'us', label: 'us · api.mailgun.net' },
          { value: 'eu', label: 'eu · api.eu.mailgun.net' },
        ],
        initial: 'us',
      },
    ],
  },
  brevo: {
    fields: [{ name: 'apiKey', label: 'API v3 key', kind: 'password', mono: true }],
  },
  smtp: {
    fields: [
      { name: 'host', label: 'Host', mono: true, placeholder: 'smtp.northwind.travel' },
      { name: 'port', label: 'Port', kind: 'number', initial: '587' },
      { name: 'user', label: 'Username', mono: true },
      { name: 'pass', label: 'Password', kind: 'password', mono: true },
      { name: 'secure', label: 'Use TLS from the start (port 465)', kind: 'checkbox' },
    ],
  },
  google: { fields: [] },
};

/** The initial value of every field for a provider, so the form is controlled. */
export function initialCredentialValues(type: ProviderType): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of CREDENTIALS[type].fields) values[field.name] = field.initial ?? '';
  return values;
}

/**
 * Turns the form's strings into the API's discriminated union.
 *
 * `null` means "not complete", which is what disables the submit button —
 * the server validates again, this only stops an obviously empty POST.
 */
export function credentialsFrom(
  type: ProviderType,
  values: Record<string, string>,
): Credentials | null {
  const text = (key: string): string => (values[key] ?? '').trim();
  const filled = (...keys: string[]): boolean => keys.every((key) => text(key) !== '');

  switch (type) {
    case 'ses':
      return filled('accessKeyId', 'secretAccessKey', 'region')
        ? {
            type: 'ses',
            accessKeyId: text('accessKeyId'),
            secretAccessKey: text('secretAccessKey'),
            region: text('region'),
          }
        : null;

    case 'sendgrid':
      return filled('apiKey') ? { type: 'sendgrid', apiKey: text('apiKey') } : null;

    case 'brevo':
      return filled('apiKey') ? { type: 'brevo', apiKey: text('apiKey') } : null;

    case 'mailgun':
      return filled('apiKey', 'domain', 'region')
        ? {
            type: 'mailgun',
            apiKey: text('apiKey'),
            domain: text('domain'),
            region: text('region') === 'eu' ? 'eu' : 'us',
          }
        : null;

    case 'smtp': {
      const port = Number(text('port'));
      if (!filled('host', 'user', 'pass') || !Number.isInteger(port) || port <= 0) return null;
      return {
        type: 'smtp',
        host: text('host'),
        port,
        secure: text('secure') === 'on',
        user: text('user'),
        pass: text('pass'),
      };
    }

    default:
      return null;
  }
}

// ------------------------------------------------------------- small pieces

/** E1b's and E1c's bordered note row, with the info glyph. */
export function NoteRow({
  children,
  variant = 'card',
}: {
  children: ReactNode;
  variant?: 'card' | 'tint';
}) {
  return (
    <div
      className={[
        'flex items-start gap-2 rounded-control',
        variant === 'card'
          ? 'border border-border bg-surface px-3.5 py-3 text-ui text-text-2'
          : 'bg-tint px-3 py-2.5 text-caption text-text-2',
      ].join(' ')}
    >
      <span className="mt-px flex-none text-info-text">
        <svg
          viewBox="0 0 24 24"
          width={variant === 'card' ? 16 : 14}
          height={variant === 'card' ? 16 : 14}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01" />
        </svg>
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * D4, in the badge the frame draws beside an SMTP connection's name.
 *
 * The tooltip is the whole sentence: a customer choosing a sender is
 * deciding what tracking they get, and "best-effort" alone does not say it.
 */
export function BestEffortBadge({ className = '' }: { className?: string }) {
  return (
    <span
      title={PROVIDER_INFO.smtp.note}
      className={`inline-flex h-[22px] cursor-help items-center gap-1 rounded-badge bg-info-soft px-2 text-caption font-medium text-info-text ${className}`}
    >
      Best-effort delivery feedback
      <svg
        viewBox="0 0 24 24"
        width={12}
        height={12}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01" />
      </svg>
    </span>
  );
}
