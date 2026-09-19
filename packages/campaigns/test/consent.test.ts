import { describe, expect, it } from 'vitest';
import {
  CONSENT_SOURCES,
  MIN_DETAIL_LENGTH,
  attestationAuthorises,
  audienceFingerprint,
  validateAttestationInput,
  type Attestation,
} from '../src/abuse/consent.js';

/**
 * Consent attestation (docs/06 "Anti-abuse"; migration 0016).
 *
 * docs/06: "Every import records a declared consent source; every launch
 * re-confirms it. Stored, timestamped, attributed to a user."
 *
 * An attestation is a claim, not a check — we cannot verify a stranger's
 * list, and pretending to would let a workspace point at our tick box as
 * proof. Its whole value is in being specific and unrepudiable, so most of
 * this file is about the one way a claim stops being specific: being made
 * about an audience other than the one actually being mailed.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const AUDIENCE = { listIds: ['l1', 'l2'], segmentId: 's1' };

function attestation(over: Partial<Attestation> = {}): Attestation {
  return {
    source: 'signup_form',
    detail: null,
    audienceFingerprint: audienceFingerprint(AUDIENCE),
    attestedAt: new Date(NOW.getTime() - 60_000),
    attestedBy: 'user-1',
    ...over,
  };
}

describe('the fingerprint identifies the audience, not its spelling', () => {
  it('is stable across key order', () => {
    // The UI serialises this object; a fingerprint that changed when the key
    // order happened to differ would fail launches for no reason and teach
    // everybody to re-tick reflexively, which is how a control becomes
    // noise.
    expect(audienceFingerprint({ listIds: ['a'], segmentId: 's' })).toBe(
      audienceFingerprint({ segmentId: 's', listIds: ['a'] }),
    );
  });

  it('is stable across array order', () => {
    expect(audienceFingerprint({ listIds: ['a', 'b'] })).toBe(
      audienceFingerprint({ listIds: ['b', 'a'] }),
    );
  });

  it('ignores an explicitly null member', () => {
    expect(audienceFingerprint({ listIds: ['a'] })).toBe(
      audienceFingerprint({ listIds: ['a'], segmentId: null }),
    );
  });

  it('changes when a list is added', () => {
    // The property the whole thing exists for. Without this the two tests
    // above are satisfied by a function that returns a constant.
    expect(audienceFingerprint({ listIds: ['a'] })).not.toBe(
      audienceFingerprint({ listIds: ['a', 'b'] }),
    );
  });

  it('changes when a list is swapped', () => {
    expect(audienceFingerprint({ listIds: ['a'] })).not.toBe(
      audienceFingerprint({ listIds: ['z'] }),
    );
  });

  it('changes when a segment is added', () => {
    expect(audienceFingerprint({ listIds: ['a'] })).not.toBe(
      audienceFingerprint({ listIds: ['a'], segmentId: 's1' }),
    );
  });

  it('does not collide across differently shaped audiences', () => {
    const seen = new Set(
      [
        {},
        { listIds: [] },
        { listIds: ['a'] },
        { listIds: ['a', 'b'] },
        { segmentId: 'a' },
        { listIds: ['a'], segmentId: 'b' },
      ].map(audienceFingerprint),
    );

    expect(seen.size).toBe(6);
  });
});

describe('an attestation authorises one audience', () => {
  it('authorises the audience it was made about', () => {
    expect(attestationAuthorises(attestation(), AUDIENCE)).toEqual({ ok: true });
  });

  it('refuses when the audience changed after the tick', () => {
    // The attack: attest about a small hand-built list, swap the audience
    // for a purchased one, launch. Without binding the claim to an audience
    // it is a claim about a campaign, and a campaign is a row whose audience
    // can be edited.
    const swapped = { listIds: ['purchased'], segmentId: 's1' };

    expect(attestationAuthorises(attestation(), swapped)).toEqual({
      ok: false,
      reason: 'audience_changed',
    });
  });

  it('refuses an attestation with no fingerprint at all', () => {
    // An import attestation has none. Reusing one to authorise a campaign
    // launch would be the cheapest possible bypass.
    expect(attestationAuthorises(attestation({ audienceFingerprint: null }), AUDIENCE)).toEqual(
      { ok: false, reason: 'audience_changed' },
    );
  });

  it('refuses when there is none', () => {
    expect(attestationAuthorises(null, AUDIENCE)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('there is no expiry, and that is deliberate', () => {
  it('accepts an attestation made days ago for the same audience', () => {
    // A campaign scheduled for next Tuesday is launched by the scheduler
    // with nobody present. Any TTL short enough to mean "re-confirmed at
    // launch" would fail every scheduled campaign; one long enough not to
    // would mean nothing. The re-confirmation is structural instead — the
    // launch request carries the attestation — and what is checked here is
    // that it is about the audience being mailed.
    const old = new Date(NOW.getTime() - 7 * 86_400_000);

    expect(attestationAuthorises(attestation({ attestedAt: old }), AUDIENCE)).toEqual({ ok: true });
  });

  it('still refuses that attestation once the audience is swapped', () => {
    // Which is the case that matters for a scheduled campaign: confirmed on
    // Monday, audience changed on Wednesday, sends on Tuesday.
    const old = new Date(NOW.getTime() - 7 * 86_400_000);

    expect(
      attestationAuthorises(attestation({ attestedAt: old }), { listIds: ['purchased'] }),
    ).toEqual({ ok: false, reason: 'audience_changed' });
  });
});

describe('the reason is specific', () => {
  it('distinguishes never confirmed from confirmed about something else', () => {
    // The sender has to do something different in each case, and one
    // message covering both cannot say which.
    expect(attestationAuthorises(null, AUDIENCE).ok).toBe(false);
    expect(attestationAuthorises(attestation(), { listIds: ['other'] })).toEqual({
      ok: false,
      reason: 'audience_changed',
    });
  });
});

describe('the declared source', () => {
  it('is a fixed vocabulary', () => {
    // Free text makes "how many workspaces claim to be sending to a list
    // imported from a previous provider" a reading exercise nobody does.
    expect(CONSENT_SOURCES).toContain('signup_form');
    expect(CONSENT_SOURCES).toContain('imported_from_previous_provider');
    expect(CONSENT_SOURCES).toContain('other');
  });

  it('refuses a source outside it', () => {
    expect(validateAttestationInput({ source: 'trust_me' })).toEqual({
      field: 'source',
      reason: 'unknown_source',
    });
  });

  it('accepts a known source with no detail', () => {
    expect(validateAttestationInput({ source: 'signup_form' })).toBeNull();
  });

  it('requires an explanation for "other"', () => {
    // Without this, `other` becomes the option everybody picks to avoid
    // answering — and an attestation that says "other" and nothing else is a
    // tick box that happens to be stored, not evidence.
    expect(validateAttestationInput({ source: 'other' })).toEqual({
      field: 'detail',
      reason: 'required_for_other',
    });
  });

  it('refuses whitespace as an explanation', () => {
    expect(validateAttestationInput({ source: 'other', detail: '        ' })).toEqual({
      field: 'detail',
      reason: 'required_for_other',
    });
  });

  it('refuses an explanation too short to mean anything', () => {
    expect(validateAttestationInput({ source: 'other', detail: 'a list' })).toEqual({
      field: 'detail',
      reason: 'too_short',
    });
  });

  it('accepts a real explanation', () => {
    expect(
      validateAttestationInput({
        source: 'other',
        detail: 'Collected at our trade stand, paper forms scanned and retained',
      }),
    ).toBeNull();
  });

  it('accepts one exactly at the minimum', () => {
    const detail = 'x'.repeat(MIN_DETAIL_LENGTH);

    expect(validateAttestationInput({ source: 'other', detail })).toBeNull();
  });
});
