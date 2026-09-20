/**
 * State names, labels and tones (design/relayd-ui.js).
 *
 * Mirrored, not reinterpreted. `packages/ui/test/states.test.ts` reads
 * relayd-ui.js and fails if any key, label or tone here differs from it —
 * that file is the single source of truth (CLAUDE.md section 15), and the
 * point of the mirror is that the UI and the design can never disagree about
 * what "Completed with errors" is called or what colour it is.
 *
 * The keys are also the engine's state names (`campaign_recipients.state`,
 * `campaigns.status`), so a badge is looked up by the value the API returns
 * and never by a translation table somebody has to keep in step.
 */

export type Tone =
  | 'neutral'
  | 'info'
  | 'brand'
  | 'warning'
  | 'success'
  | 'danger'
  | 'uncertain'
  | 'bot';

export interface StateStyle {
  label: string;
  tone: Tone;
  /** Transitional: the dot pulses. */
  pulse?: boolean;
  /** Completed with errors: outlined badge with a warning dot. */
  outline?: boolean;
  dot?: Tone;
  /** Held by billing: a lock icon after the label. */
  lock?: boolean;
}

/**
 * Per-tone colours. `fg`/`bg` are CSS variable references so they follow the
 * theme; `dot` is a fixed hue because the semantic colours are identical in
 * both modes (the sheet's Colour section).
 */
export const TONES: Readonly<Record<Tone, { fg: string; bg: string; dot: string; dashed?: boolean }>> = {
  neutral: { fg: 'var(--neutral-text)', bg: 'var(--neutral-soft)', dot: '#6B7280' },
  info: { fg: 'var(--info-text)', bg: 'var(--info-soft)', dot: '#0EA5E9' },
  brand: { fg: 'var(--brand)', bg: 'var(--brand-soft)', dot: 'var(--brand)' },
  warning: { fg: 'var(--warning-text)', bg: 'var(--warning-soft)', dot: '#F59E0B' },
  success: { fg: 'var(--success-text)', bg: 'var(--success-soft)', dot: '#10B981' },
  danger: { fg: 'var(--danger-text)', bg: 'var(--danger-soft)', dot: '#DC2626' },
  uncertain: {
    fg: 'var(--neutral-text)',
    bg: 'repeating-linear-gradient(135deg,rgba(100,116,139,.35) 0 2px,transparent 2px 5px)',
    dot: '#64748B',
    dashed: true,
  },
  bot: {
    fg: 'var(--neutral-text)',
    bg: 'repeating-linear-gradient(135deg,rgba(156,163,175,.4) 0 2px,transparent 2px 5px)',
    dot: '#9CA3AF',
    dashed: true,
  },
};

export const CAMPAIGN_STATES = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  validating: { label: 'Validating', tone: 'info', pulse: true },
  queueing: { label: 'Queueing', tone: 'info', pulse: true },
  sending: { label: 'Sending', tone: 'brand', pulse: true },
  pausing: { label: 'Pausing', tone: 'warning' },
  paused: { label: 'Paused', tone: 'warning' },
  cancelling: { label: 'Cancelling', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'success' },
  completed_with_errors: { label: 'Completed with errors', tone: 'success', outline: true, dot: 'warning' },
  held: { label: 'Held', tone: 'warning', lock: true },
  failed: { label: 'Failed', tone: 'danger' },
} as const satisfies Record<string, StateStyle>;

export const RECIPIENT_STATES = {
  pending: { label: 'Pending', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'info' },
  sending: { label: 'Sending', tone: 'brand', pulse: true },
  sent: { label: 'Sent', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  soft_bounced: { label: 'Soft bounced', tone: 'warning' },
  hard_bounced: { label: 'Hard bounced', tone: 'danger' },
  complained: { label: 'Complained', tone: 'danger' },
  suppressed: { label: 'Suppressed', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  delivery_uncertain: { label: 'Delivery uncertain', tone: 'uncertain' },
} as const satisfies Record<string, StateStyle>;

export const CONTACT_STATES = {
  subscribed: { label: 'Subscribed', tone: 'success' },
  unsubscribed: { label: 'Unsubscribed', tone: 'neutral' },
  bounced: { label: 'Bounced', tone: 'danger' },
  complained: { label: 'Complained', tone: 'danger' },
} as const satisfies Record<string, StateStyle>;

export const HEALTH = {
  healthy: { label: 'Healthy', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
} as const satisfies Record<string, StateStyle>;

export type CampaignState = keyof typeof CAMPAIGN_STATES;
export type RecipientState = keyof typeof RECIPIENT_STATES;
export type ContactState = keyof typeof CONTACT_STATES;
export type Health = keyof typeof HEALTH;

/**
 * Resolves a state key to its style, with the fallback relayd-ui.js uses: an
 * unknown key is shown as itself in neutral, never hidden. A state the UI
 * has not heard of is exactly the one somebody needs to see.
 */
export function stateStyle(map: Readonly<Record<string, StateStyle>>, key: string): StateStyle {
  return map[key] ?? { label: key, tone: 'neutral' };
}
