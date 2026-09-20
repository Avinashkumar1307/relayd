import type { StateStyle } from '@relayd/ui';

/**
 * Invoice states, in the shape `StateBadge` reads.
 *
 * The design system's state vocabulary (`packages/ui/src/states.ts`) covers
 * campaigns, recipients, contacts and connection health; an invoice's status
 * comes from Stripe and is not in it. The tones are the frames': I7 draws
 * Paid on `--success-soft` and Void on `--neutral-soft`, I1b draws Past due
 * on `--warning-soft`, and an uncollectible invoice is the only one the
 * frames never show — `danger`, because it is the one nobody gets paid for.
 *
 * Keyed by the value the API returns, so nothing has to translate.
 */
export const INVOICE_STATES: Readonly<Record<string, StateStyle>> = {
  draft: { label: 'Draft', tone: 'neutral' },
  open: { label: 'Open', tone: 'info' },
  past_due: { label: 'Past due', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  void: { label: 'Void', tone: 'neutral' },
  uncollectible: { label: 'Uncollectible', tone: 'danger' },
};
