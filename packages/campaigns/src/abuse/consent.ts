import { createHash } from 'node:crypto';

/**
 * Consent attestation (docs/06 "Anti-abuse"; migration 0016).
 *
 * docs/06: "Every import records a declared consent source; every launch
 * re-confirms it. Stored, timestamped, attributed to a user."
 *
 * docs/02 says what it is for: "This is what lets you defend a workspace when
 * a provider or a regulator asks, and it is what lets you suspend a workspace
 * that lied."
 *
 * ## What an attestation is and is not
 *
 * It is not a consent check. We cannot verify that a stranger's list was
 * opted in, and pretending to would be worse than useless — it would let a
 * workspace point at our tick box as proof.
 *
 * It is a *claim*, made by a named person at a recorded moment about a
 * specific audience. Its value is entirely in being specific and
 * unrepudiable: a workspace that claimed "signup form" about a list that
 * turns out to be purchased has said something false, on the record, and
 * that is a suspension rather than an argument.
 *
 * Everything that follows exists to keep it specific. A claim that could be
 * made once and then reused for any audience is not evidence of anything.
 */

/**
 * The fixed vocabulary, matching the CHECK in migration 0016.
 *
 * Fixed rather than free text because "how many workspaces claim to be
 * sending to a list imported from a previous provider" has to be answerable
 * with a GROUP BY. That is the query that finds the pattern; free text makes
 * it a reading exercise nobody does.
 */
export const CONSENT_SOURCES = [
  'signup_form',
  'checkout_optin',
  'in_person',
  'existing_customer',
  'imported_from_previous_provider',
  'other',
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** `other` must be explained. Matches the CHECK in migration 0016. */
export const MIN_DETAIL_LENGTH = 10;

/**
 * ## Why there is no expiry here
 *
 * The obvious design gives an attestation a short TTL, so that "re-confirms
 * at launch" means "ticked in the last hour". It is wrong, and the reason is
 * scheduled campaigns: a campaign scheduled for next Tuesday is launched by
 * the scheduler with nobody present, and any TTL short enough to mean
 * something would fail every one of them. A TTL long enough not to would
 * mean nothing.
 *
 * So the re-confirmation is structural instead. The launch *request* carries
 * the attestation — see `apps/api/src/services/campaigns.ts`, which records
 * it in the same transaction as the launch — so a launch without a fresh,
 * deliberate assertion cannot be made at all. What this module then checks
 * is that the assertion is about the audience being mailed.
 *
 * **Known limitation, stated rather than hidden:** the fingerprint pins the
 * audience *definition*, not its membership. A campaign scheduled against
 * `list:marketing` and launched a week later mails whoever is in that list
 * then, including contacts imported in between. Catching that needs a
 * membership count pinned at attestation time and compared at snapshot, and
 * it is not built. The import-side attestation is what covers those
 * contacts: they arrived through an import that made its own declaration.
 */

export interface Attestation {
  source: ConsentSource;
  detail: string | null;
  audienceFingerprint: string | null;
  attestedAt: Date;
  attestedBy: string;
}

/**
 * A stable fingerprint of a campaign's audience definition.
 *
 * The attack this closes: attest about a small hand-built list, swap the
 * audience for a purchased one, launch. Without binding the attestation to
 * an audience it is a claim about a campaign — and a campaign is just a row
 * whose audience can be edited.
 *
 * Stable across key order and array order, because neither changes what the
 * audience *is*, and a fingerprint that changed when the UI happened to
 * serialise a list differently would fail launches for no reason and teach
 * everyone to re-attest reflexively.
 */
export function audienceFingerprint(audience: unknown): string {
  return createHash('sha256').update(canonicalise(audience)).digest('hex').slice(0, 32);
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    // Sorted. `{listIds: ['a','b']}` and `{listIds: ['b','a']}` are the same
    // audience, and a fingerprint that disagreed would be noise.
    return `[${[...value].map(canonicalise).sort().join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined and null members are dropped so that adding an explicit
    // `segmentId: null` to a payload does not read as a different audience.
    .filter(([, entry]) => entry !== undefined && entry !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${key}:${canonicalise(entry)}`).join(',')}}`;
}

export type AttestationVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'audience_changed' };

/**
 * Whether an attestation authorises launching this campaign now.
 *
 * Returns a reason rather than a boolean: "why can I not launch" is a
 * question the UI has to answer differently in each case — re-tick, or
 * re-tick *because you changed the audience* — and a boolean collapses them
 * into one unhelpful message.
 */
export function attestationAuthorises(
  attestation: Attestation | null,
  audience: unknown,
): AttestationVerdict {
  if (attestation === null) return { ok: false, reason: 'missing' };

  // An import attestation has no fingerprint, so it can never authorise a
  // launch. That is deliberate: reusing the declaration made about a file
  // to authorise mailing an arbitrary audience would be the cheapest
  // possible bypass, and `null !== <hash>` is what refuses it.
  return attestation.audienceFingerprint === audienceFingerprint(audience)
    ? { ok: true }
    : { ok: false, reason: 'audience_changed' };
}

export type AttestationInputProblem =
  | { field: 'source'; reason: 'unknown_source' }
  | { field: 'detail'; reason: 'required_for_other' | 'too_short' };

/**
 * Validates what a person submitted, before it becomes a row.
 *
 * The `other` rule is the one that matters. Without a required explanation,
 * `other` becomes the option everybody picks to avoid answering — and an
 * attestation that says "other" and nothing else is not evidence, it is a
 * tick box that happens to be stored.
 */
export function validateAttestationInput(input: {
  source: string;
  detail?: string | null;
}): AttestationInputProblem | null {
  if (!(CONSENT_SOURCES as readonly string[]).includes(input.source)) {
    return { field: 'source', reason: 'unknown_source' };
  }

  if (input.source !== 'other') return null;

  const detail = input.detail?.trim() ?? '';
  if (detail === '') return { field: 'detail', reason: 'required_for_other' };
  if (detail.length < MIN_DETAIL_LENGTH) return { field: 'detail', reason: 'too_short' };

  return null;
}
