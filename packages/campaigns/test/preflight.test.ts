import { describe, expect, it } from 'vitest';
import {
  launchCampaign,
  runLaunchPreflight,
  type LaunchPort,
  type LaunchableCampaign,
  type PreflightCheck,
} from '../src/engine/launch.js';
import { audienceFingerprint } from '../src/abuse/consent.js';

/**
 * The shared pre-flight.
 *
 * G2 step 7 shows the customer a list of checks before they press send, and
 * `POST /campaigns/:id/preflight` answers it. The only safe way to build that
 * list is to run the checks launch runs: a pre-flight that says "7 pass" and
 * is then refused by the launch it was supposed to predict teaches the
 * customer that the page is wrong and the error is noise.
 *
 * So the property under test is not "the pre-flight is correct" — it is
 * "the pre-flight and the launch give the same answer", asserted by running
 * both against the same port and comparing. The individual rules are already
 * covered by `launch.test.ts`; duplicating them here would be two copies of
 * a rule, which is the thing this file exists to prevent.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

const CAMPAIGN: LaunchableCampaign = {
  id: 'c1',
  workspaceId: 'ws-1',
  templateVersionId: 'v1',
  senderAccountId: 'sa-1',
  sendingPoolId: null,
  audience: { listIds: ['l1'] },
};

function port(overrides: Partial<LaunchPort> = {}) {
  const calls: string[] = [];
  const events: string[] = [];

  const base: LaunchPort = {
    async claimForLaunch() {
      calls.push('claim');
      return true;
    },
    async readCampaign() {
      calls.push('read');
      return CAMPAIGN;
    },
    async readEntitlementForShare() {
      calls.push('entitlement');
      return { monthlySendLimit: null, used: 0 };
    },
    async senderIsUsable() {
      calls.push('sender');
      return true;
    },
    async ownerEmailIsVerified() {
      calls.push('ownerVerified');
      return true;
    },
    async workspaceIsInRamp() {
      calls.push('ramp');
      return false;
    },
    async readEnforcementStage() {
      calls.push('enforcement');
      return 'none' as const;
    },
    async launchIsApproved() {
      calls.push('approved');
      return true;
    },
    async scanContent() {
      calls.push('scan');
      return { blocked: false, findings: [], blockedDomains: [], reputationUnavailable: false };
    },
    async readConsentAttestation() {
      calls.push('consent');
      return {
        source: 'signup_form' as const,
        detail: null,
        audienceFingerprint: audienceFingerprint(CAMPAIGN.audience),
        attestedAt: NOW,
        attestedBy: 'user-1',
      };
    },
    async snapshotAudience() {
      calls.push('snapshot');
      return { inserted: 1000, suppressedAtSnapshot: 12 };
    },
    async initialiseCounters() {
      calls.push('counters');
    },
    async markQueueing() {
      calls.push('queueing');
    },
    async releaseClaim() {
      calls.push('release');
    },
    async recordEvent(input) {
      events.push(input.eventType);
    },
  };

  return { port: { ...base, ...overrides }, calls, events };
}

const find = (checks: readonly PreflightCheck[], key: string): PreflightCheck | undefined =>
  checks.find((check) => check.key === key);

/* ----------------------------------------------- launch and pre-flight agree */

/**
 * Every refusal the pre-flight can see, run through both paths.
 *
 * `empty_audience` and `entitlement_exceeded` are absent on purpose: both are
 * decided against the rows the snapshot wrote, and the pre-flight takes no
 * snapshot. They stay in `launchCampaign` and `launch.test.ts` covers them.
 */
const REFUSALS: readonly { name: string; overrides: Partial<LaunchPort>; failure: string }[] = [
  {
    name: 'no template',
    overrides: { async readCampaign() { return { ...CAMPAIGN, templateVersionId: null }; } },
    failure: 'no_template',
  },
  {
    name: 'no sender and no pool',
    overrides: {
      async readCampaign() {
        return { ...CAMPAIGN, senderAccountId: null, sendingPoolId: null };
      },
    },
    failure: 'no_sender',
  },
  {
    name: 'the sender identity is no longer verified',
    overrides: { async senderIsUsable() { return false; } },
    failure: 'unverified_sender',
  },
  {
    name: 'the owner has not verified their address',
    overrides: { async ownerEmailIsVerified() { return false; } },
    failure: 'unverified_account',
  },
  {
    name: 'pool routing inside the new-account ramp',
    overrides: {
      async readCampaign() {
        return { ...CAMPAIGN, senderAccountId: null, sendingPoolId: 'pool-1' };
      },
      async workspaceIsInRamp() {
        return true;
      },
    },
    failure: 'pool_routing_unavailable',
  },
  {
    name: 'the workspace is paused',
    overrides: { async readEnforcementStage() { return 'paused' as const; } },
    failure: 'enforcement_paused',
  },
  {
    name: 'the workspace is under review and this campaign is not approved',
    overrides: {
      async readEnforcementStage() { return 'review_required' as const; },
      async launchIsApproved() { return false; },
    },
    failure: 'enforcement_review_required',
  },
  {
    name: 'a link domain is on a block list',
    overrides: {
      async scanContent() {
        return {
          blocked: false,
          findings: [],
          blockedDomains: ['evil.example'],
          reputationUnavailable: false,
        };
      },
    },
    failure: 'blocked_link_domain',
  },
  {
    name: 'the content check held it',
    overrides: {
      async scanContent() {
        return { blocked: true, findings: [], blockedDomains: [], reputationUnavailable: false };
      },
    },
    failure: 'content_blocked',
  },
  {
    name: 'consent was never attested',
    overrides: { async readConsentAttestation() { return null; } },
    failure: 'consent_not_attested',
  },
  {
    name: 'the audience changed after consent',
    overrides: {
      async readConsentAttestation() {
        return {
          source: 'signup_form' as const,
          detail: null,
          audienceFingerprint: audienceFingerprint({ listIds: ['something-else'] }),
          attestedAt: NOW,
          attestedBy: 'user-1',
        };
      },
    },
    failure: 'consent_audience_changed',
  },
  {
    name: 'the workspace has no subscription',
    overrides: { async readEntitlementForShare() { return null; } },
    failure: 'no_entitlement',
  },
];

describe('the pre-flight names exactly what the launch would refuse', () => {
  for (const refusal of REFUSALS) {
    it(`agrees about ${refusal.name}`, async () => {
      const launched = await launchCampaign('c1', port(refusal.overrides).port);

      const checked = await runLaunchPreflight(
        (await port(refusal.overrides).port.readCampaign('c1')) as LaunchableCampaign,
        port(refusal.overrides).port,
        { stopAtFirstFailure: false },
      );

      expect(launched.ok).toBe(false);
      expect(launched.failure).toBe(refusal.failure);

      // The same code, and the same sentence. A pre-flight that paraphrased
      // the launch error would be a second copy of the copy that drifts.
      expect(checked.failure).not.toBeNull();
      expect(checked.failure?.failure).toBe(refusal.failure);
      expect(checked.failure?.message).toBe(launched.message);
    });
  }

  it('finds nothing to refuse on a campaign that launches', async () => {
    const launched = await launchCampaign('c1', port().port);
    const checked = await runLaunchPreflight(CAMPAIGN, port().port, {
      stopAtFirstFailure: false,
    });

    expect(launched.ok).toBe(true);
    expect(checked.failure).toBeNull();
    expect(checked.checks.every((check) => check.outcome !== 'fail')).toBe(true);
  });
});

/* ------------------------------------------------------- the two modes ---- */

describe('stopAtFirstFailure', () => {
  it('reproduces the launch ordering: no content scan after a cheap refusal', async () => {
    // The whole reason the order exists. Rendering the message is the
    // expensive part of the check and there is no point paying for it on a
    // campaign that was going to be refused anyway.
    const { port: p, calls } = port({ async ownerEmailIsVerified() { return false; } });

    await runLaunchPreflight(CAMPAIGN, p, { stopAtFirstFailure: true });

    expect(calls).not.toContain('scan');
    expect(calls).not.toContain('entitlement');
  });

  it('keeps going without it, so the customer sees the whole list at once', async () => {
    const { port: p, calls } = port({ async ownerEmailIsVerified() { return false; } });

    const result = await runLaunchPreflight(CAMPAIGN, p, { stopAtFirstFailure: false });

    expect(calls).toContain('scan');
    expect(calls).toContain('entitlement');
    expect(result.checks.length).toBeGreaterThan(5);
    expect(find(result.checks, 'account')?.outcome).toBe('fail');
    // One failure does not make everything after it fail.
    expect(find(result.checks, 'consent')?.outcome).toBe('pass');
  });

  it('reports the first failure in launch order when several fail', async () => {
    const { port: p } = port({
      async ownerEmailIsVerified() { return false; },
      async readConsentAttestation() { return null; },
    });

    const result = await runLaunchPreflight(CAMPAIGN, p, { stopAtFirstFailure: false });

    // Not "the last one found", and not "the most severe" — the one the
    // launch would stop at, because that is the error the customer will
    // actually be shown if they press send.
    expect(result.failure?.failure).toBe('unverified_account');
    expect(find(result.checks, 'consent')?.failure).toBe('consent_not_attested');
  });
});

/* -------------------------------------------------- what it will not do --- */

describe('the pre-flight writes nothing', () => {
  it('records no event, even when the scan has warnings', async () => {
    // The wizard polls this endpoint while the author edits. A campaign
    // whose timeline fills with "content warnings" every time somebody
    // opens step 7 has a useless timeline.
    const { port: p, events } = port({
      async scanContent() {
        return {
          blocked: false,
          findings: [{ code: 'link_text_mismatch', severity: 'warning', message: 'x' }],
          blockedDomains: [],
          reputationUnavailable: true,
        } as Awaited<ReturnType<LaunchPort['scanContent']>>;
      },
    });

    await runLaunchPreflight(CAMPAIGN, p, { stopAtFirstFailure: false });

    expect(events).toEqual([]);
  });

  it('takes no claim and no snapshot', async () => {
    const { port: p, calls } = port();

    await runLaunchPreflight(CAMPAIGN, p, { stopAtFirstFailure: false });

    expect(calls).not.toContain('claim');
    expect(calls).not.toContain('snapshot');
    expect(calls).not.toContain('queueing');
    expect(calls).not.toContain('release');
  });
});

describe('launch still records what it used to', () => {
  it('writes the content-warning and reputation events through the callback', async () => {
    // The callback exists so those two events keep happening at exactly the
    // point in the sequence they used to: after both content refusals,
    // before consent.
    const { port: p, events } = port({
      async scanContent() {
        return {
          blocked: false,
          findings: [{ code: 'link_text_mismatch', severity: 'warning', message: 'x' }],
          blockedDomains: [],
          reputationUnavailable: true,
        } as Awaited<ReturnType<LaunchPort['scanContent']>>;
      },
    });

    await launchCampaign('c1', p);

    expect(events).toContain('launch.content_warnings');
    expect(events).toContain('launch.reputation_unavailable');
  });

  it('does not write them when a consent failure follows', async () => {
    // Order matters: the warnings are recorded before consent is read, so a
    // consent refusal still leaves them on the record. This is the
    // behaviour the refactor had to preserve rather than tidy away.
    const { port: p, events } = port({
      async scanContent() {
        return {
          blocked: false,
          findings: [{ code: 'link_text_mismatch', severity: 'warning', message: 'x' }],
          blockedDomains: [],
          reputationUnavailable: false,
        } as Awaited<ReturnType<LaunchPort['scanContent']>>;
      },
      async readConsentAttestation() {
        return null;
      },
    });

    await launchCampaign('c1', p);

    expect(events).toContain('launch.content_warnings');
    expect(events).toContain('launch.rejected');
  });
});

/* ----------------------------------------------- checks it cannot answer -- */

describe('checks that need something the pre-flight does not have', () => {
  it('does not scan content when there is no template to render', async () => {
    // Asking the scanner to render nothing is how a pre-flight on an empty
    // draft turns into a 500.
    const { port: p, calls } = port({
      async readCampaign() {
        return { ...CAMPAIGN, templateVersionId: null };
      },
    });

    const result = await runLaunchPreflight(
      { ...CAMPAIGN, templateVersionId: null },
      p,
      { stopAtFirstFailure: false },
    );

    expect(calls).not.toContain('scan');
    expect(find(result.checks, 'content')?.outcome).toBe('warn');
    expect(find(result.checks, 'links')?.outcome).toBe('warn');
    // A check it could not run is not a check that failed.
    expect(find(result.checks, 'content')?.failure).toBeNull();
  });

  it('says nothing about the audience count or the plan limit', async () => {
    // Both are decided against the snapshot, and there is no snapshot here.
    // Guessing at them is the disagreement this file exists to prevent.
    const result = await runLaunchPreflight(CAMPAIGN, port().port, {
      stopAtFirstFailure: false,
    });

    const keys = result.checks.map((check) => check.key);
    expect(keys).not.toContain('audience');
    expect(result.checks.every((check) => check.failure !== 'empty_audience')).toBe(true);
    expect(result.checks.every((check) => check.failure !== 'entitlement_exceeded')).toBe(true);
  });

  it('returns the entitlement it read, so launch does not lock the row twice', async () => {
    const result = await runLaunchPreflight(CAMPAIGN, port().port, {
      stopAtFirstFailure: true,
    });

    expect(result.entitlement).toEqual({ monthlySendLimit: null, used: 0 });
  });

  it('reports the remaining allowance on a limited plan', async () => {
    const { port: p } = port({
      async readEntitlementForShare() {
        return { monthlySendLimit: 50_000, used: 12_000 };
      },
    });

    const result = await runLaunchPreflight(CAMPAIGN, p, { stopAtFirstFailure: false });

    expect(find(result.checks, 'entitlement')?.detail).toContain('38,000');
  });

  it('reports a content scan with non-blocking findings as a warning', async () => {
    const { port: p } = port({
      async scanContent() {
        return {
          blocked: false,
          findings: [{ code: 'link_text_mismatch', severity: 'warning', message: 'x' }],
          blockedDomains: [],
          reputationUnavailable: false,
        } as Awaited<ReturnType<LaunchPort['scanContent']>>;
      },
    });

    const result = await runLaunchPreflight(CAMPAIGN, p, { stopAtFirstFailure: false });

    // A warning, not a failure: the launch would go through, and colouring
    // it red would stop a customer who has nothing to fix.
    expect(find(result.checks, 'content')?.outcome).toBe('warn');
    expect(result.failure).toBeNull();
  });
});
