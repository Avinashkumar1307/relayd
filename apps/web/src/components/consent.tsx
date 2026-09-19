import { CONSENT_SOURCE_VALUES } from '@relayd/validation';

/**
 * The consent vocabulary, as a person reads it (docs/06 "Anti-abuse").
 *
 * The values come from `@relayd/validation`, which is the same array the API
 * validates against and the same one migration 0016's CHECK constraint
 * holds. The labels live here because they are wording, not policy.
 *
 * ## Why the labels are phrased as they are
 *
 * Each one describes what the sender *did*, not a category they might
 * identify with. "They ticked an opt-in box when buying something" is
 * answerable; "Checkout opt-in" invites a guess. An attestation the sender
 * misread is worse than no attestation, because it looks like evidence and
 * is not.
 */
export type ConsentSource = (typeof CONSENT_SOURCE_VALUES)[number];

export const CONSENT_SOURCE_LABELS: readonly (readonly [ConsentSource, string])[] = [
  ['signup_form', 'They signed up through a form on our site'],
  ['checkout_optin', 'They ticked an opt-in box when buying something'],
  ['in_person', 'They gave us their address in person'],
  ['existing_customer', 'They are existing customers of ours'],
  ['imported_from_previous_provider', 'Imported from our previous email provider'],
  ['other', 'Something else'],
];

/** `other` has to be explained. Matches the API and the database CHECK. */
export const CONSENT_DETAIL_MIN = 10;

/**
 * Whether a declaration is complete enough to submit.
 *
 * Mirrors `validateAttestationInput` on the server. The server is the one
 * that decides — this only stops the round trip.
 */
export function consentIsComplete(source: string, detail: string): boolean {
  if (!(CONSENT_SOURCE_VALUES as readonly string[]).includes(source)) return false;
  if (source !== 'other') return true;

  return detail.trim().length >= CONSENT_DETAIL_MIN;
}
