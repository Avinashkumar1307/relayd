import { describe, expect, it, vi } from 'vitest';
import { LAUNCHABLE_STATES, launchCampaign, type LaunchPort } from '../src/engine/launch.js';
import { audienceFingerprint } from '../src/abuse/consent.js';

/**
 * Campaign launch (INVARIANTS R28, R29; review findings F28, F29).
 *
 * Launch is where a draft becomes irrevocable. The two failures that matter
 * are launching twice and launching over a limit that changed underneath, and
 * both are races — so most of these tests are about ordering rather than
 * outcomes.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

const CAMPAIGN = {
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
      // An unlimited plan. Null is now a refusal, not an absence of limits,
      // so the default here has to be a real entitlement.
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
    ...overrides,
  };

  return { port: base, calls, events };
}

describe('the guarded claim (R29)', () => {
  it('claims before reading or validating anything', async () => {
    // Two concurrent launches must not both pass validation and both
    // snapshot. The claim is what serialises them.
    const { port: p, calls } = port();

    await launchCampaign('c1', p);

    expect(calls[0]).toBe('claim');
  });

  it('refuses when the campaign is not launchable', async () => {
    const snapshot = vi.fn();
    const { port: p } = port({
      async claimForLaunch() {
        return false;
      },
      snapshotAudience: snapshot as never,
    });

    const result = await launchCampaign('c1', p);

    expect(result).toMatchObject({ ok: false, failure: 'not_launchable' });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('snapshots once when twenty launches race', async () => {
    // R29's proving test: one snapshot, nineteen refusals.
    let claimed = false;
    let snapshots = 0;

    const { port: p } = port({
      async claimForLaunch() {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      async snapshotAudience() {
        snapshots += 1;
        return { inserted: 10, suppressedAtSnapshot: 0 };
      },
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => launchCampaign('c1', p)),
    );

    expect(snapshots).toBe(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.failure === 'not_launchable')).toHaveLength(19);
  });

  it('names the states it may be launched from, once', () => {
    // The guard is the invariant, and two copies of a list is how a guard
    // drifts.
    expect([...LAUNCHABLE_STATES]).toEqual(['draft', 'scheduled']);
  });
});

describe('the entitlement lock (R28)', () => {
  it('reads the entitlement before snapshotting', async () => {
    // F28: checking the limit, then snapshotting, then committing lets a
    // downgrade commit in the gap. The share lock is taken first and held for
    // the rest of the transaction.
    const { port: p, calls } = port();

    await launchCampaign('c1', p);

    expect(calls.indexOf('entitlement')).toBeLessThan(calls.indexOf('snapshot'));
  });

  it('refuses a campaign larger than the remaining allowance', async () => {
    const { port: p } = port({
      async readEntitlementForShare() {
        return { monthlySendLimit: 5000, used: 4500 };
      },
      async snapshotAudience() {
        return { inserted: 1000, suppressedAtSnapshot: 0 };
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.failure).toBe('entitlement_exceeded');
    expect(result.message).toContain('500');
  });

  it('checks the limit against the real snapshot, not an estimate', async () => {
    // An audience estimated before the snapshot is not the audience that was
    // taken — suppression and deduplication change it.
    const { port: p, calls } = port({
      async readEntitlementForShare() {
        return { monthlySendLimit: 5000, used: 0 };
      },
    });

    await launchCampaign('c1', p);

    expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('counters'));
  });

  it('allows a campaign that exactly fits', async () => {
    const { port: p } = port({
      async readEntitlementForShare() {
        return { monthlySendLimit: 1000, used: 0 };
      },
    });

    expect((await launchCampaign('c1', p)).ok).toBe(true);
  });

  it('refuses a workspace with no entitlement at all', async () => {
    // D7: no free tier. Through Phase 6 a null entitlement meant "no limit
    // enforced", which was correct only for as long as billing did not
    // exist — and is a way to send unlimited email for nothing once it does.
    const { port: p } = port({
      async readEntitlementForShare() {
        return null;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('no_entitlement');
  });

  it('does not snapshot a workspace with no entitlement', async () => {
    // A snapshot is the expensive half of a launch and there is nothing to
    // learn from taking one that cannot be sent.
    const { port: p, calls } = port({
      async readEntitlementForShare() {
        return null;
      },
    });

    await launchCampaign('c1', p);

    expect(calls).not.toContain('snapshot');
  });

  it('releases the claim when there is no entitlement', async () => {
    // Otherwise the campaign is stuck in `validating` until the sweeper
    // notices, and the customer cannot edit their way out of it.
    const { port: p, calls } = port({
      async readEntitlementForShare() {
        return null;
      },
    });

    await launchCampaign('c1', p);

    expect(calls).toContain('release');
  });

  it('enforces no limit when there is no entitlement row', async () => {
    // The Phase 6 stub: unlimited until billing arrives in Phase 8.
    const { port: p } = port({
      async snapshotAudience() {
        return { inserted: 10_000_000, suppressedAtSnapshot: 0 };
      },
    });

    expect((await launchCampaign('c1', p)).ok).toBe(true);
  });
});

describe('pre-flight', () => {
  it('refuses a campaign with no template', async () => {
    const { port: p } = port({
      async readCampaign() {
        return { ...CAMPAIGN, templateVersionId: null };
      },
    });

    expect((await launchCampaign('c1', p)).failure).toBe('no_template');
  });

  it('refuses one with neither a sender nor a pool', async () => {
    const { port: p } = port({
      async readCampaign() {
        return { ...CAMPAIGN, senderAccountId: null, sendingPoolId: null };
      },
    });

    expect((await launchCampaign('c1', p)).failure).toBe('no_sender');
  });

  it('accepts a pool without a single sender', async () => {
    const { port: p } = port({
      async readCampaign() {
        return { ...CAMPAIGN, senderAccountId: null, sendingPoolId: 'pool-1' };
      },
    });

    expect((await launchCampaign('c1', p)).ok).toBe(true);
  });

  it('refuses when the sender is no longer usable', async () => {
    // An identity can stop being verified without anyone touching Relayd.
    const { port: p } = port({
      async senderIsUsable() {
        return false;
      },
    });

    expect((await launchCampaign('c1', p)).failure).toBe('unverified_sender');
  });

  it('refuses an empty audience', async () => {
    const { port: p } = port({
      async snapshotAudience() {
        return { inserted: 0, suppressedAtSnapshot: 0 };
      },
    });

    const result = await launchCampaign('c1', p);
    expect(result.failure).toBe('empty_audience');
    expect(result.message).toContain('no contacts');
  });

  it('says so when the audience was entirely suppressed', async () => {
    // A different problem from an empty list, and the customer can act on it.
    const { port: p } = port({
      async snapshotAudience() {
        return { inserted: 0, suppressedAtSnapshot: 4000 };
      },
    });

    expect((await launchCampaign('c1', p)).message).toContain('suppressed');
  });

  it('releases the claim on every failure, so the draft stays editable', async () => {
    // Otherwise a failed pre-flight strands the campaign in `validating` and
    // needs an operator.
    for (const override of [
      { async readCampaign() { return { ...CAMPAIGN, templateVersionId: null }; } },
      { async senderIsUsable() { return false; } },
      { async snapshotAudience() { return { inserted: 0, suppressedAtSnapshot: 0 }; } },
    ]) {
      const { port: p, calls } = port(override as never);
      await launchCampaign('c1', p);

      expect(calls).toContain('release');
    }
  });
});

describe('what a successful launch records', () => {
  it('pins the template version', async () => {
    // A campaign records what it rendered, so a later edit cannot change
    // history.
    let pinned: string | undefined;
    const { port: p } = port({
      async markQueueing(input) {
        pinned = input.templateVersionId;
      },
    });

    await launchCampaign('c1', p);
    expect(pinned).toBe('v1');
  });

  it('initialises the counters from the snapshot', async () => {
    let total: number | undefined;
    const { port: p } = port({
      async initialiseCounters(input) {
        total = input.total;
      },
    });

    await launchCampaign('c1', p);
    expect(total).toBe(1000);
  });

  it('reports what was suppressed at snapshot', async () => {
    const result = await launchCampaign('c1', port().port);
    expect(result).toMatchObject({ ok: true, recipientCount: 1000, suppressedAtSnapshot: 12 });
  });

  it('records the launch as a campaign event', async () => {
    const { port: p, events } = port();
    await launchCampaign('c1', p);
    expect(events).toContain('launch.queued');
  });

  it('records a rejection too', async () => {
    const { port: p, events } = port({
      async senderIsUsable() {
        return false;
      },
    });

    await launchCampaign('c1', p);
    expect(events).toContain('launch.rejected');
  });

  it('counts the snapshot once and only once', async () => {
    const { port: p, calls } = port();
    await launchCampaign('c1', p);

    expect(calls.filter((c) => c === 'snapshot')).toHaveLength(1);
  });
});

describe('the anti-abuse gates (docs/06)', () => {
  it('refuses to launch from an unverified account', async () => {
    // docs/06: "Email verification before any send." Checked at launch, not
    // only at signup: an account can be created, verified, have its email
    // changed, and be launched from.
    const { port: p } = port({
      async ownerEmailIsVerified() {
        return false;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unverified_account');
  });

  it('releases the claim so the draft stays editable', async () => {
    // Every other pre-flight failure does this; a new one that forgot would
    // strand the campaign in `validating` with no dispatcher and no way for
    // the customer to fix it.
    const { port: p, calls } = port({
      async ownerEmailIsVerified() {
        return false;
      },
    });

    await launchCampaign('c1', p);

    expect(calls).toContain('release');
  });

  it('refuses pool routing for a workspace still in its ramp', async () => {
    // docs/06 excludes new accounts from pool routing: a pool spreads a
    // campaign across provider connections, which is how a spammer spreads
    // reputation damage and outruns a per-connection limit.
    const { port: p } = port({
      async readCampaign() {
        return { ...CAMPAIGN, senderAccountId: null, sendingPoolId: 'pool-1' };
      },
      async workspaceIsInRamp() {
        return true;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('pool_routing_unavailable');
  });

  it('refuses rather than silently sending from a single sender', async () => {
    // Quietly sending from somewhere other than where the customer chose is
    // worse than saying no: it works, so nobody asks why, and the first they
    // hear of it is a report attributing sends to the wrong identity.
    const { port: p, calls } = port({
      async readCampaign() {
        return { ...CAMPAIGN, senderAccountId: null, sendingPoolId: 'pool-1' };
      },
      async workspaceIsInRamp() {
        return true;
      },
    });

    await launchCampaign('c1', p);

    expect(calls).not.toContain('snapshot');
  });

  it('allows a ramped workspace to launch from a single sender', async () => {
    // The ramp restricts pools, not sending. Without this, the test above
    // passes just as well with a gate that refuses every launch from a new
    // workspace — which would make the product unusable on day one.
    const { port: p } = port({
      async workspaceIsInRamp() {
        return true;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.ok).toBe(true);
  });

  it('allows an established workspace to use a pool', async () => {
    const { port: p } = port({
      async readCampaign() {
        return { ...CAMPAIGN, senderAccountId: null, sendingPoolId: 'pool-1' };
      },
      async workspaceIsInRamp() {
        return false;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.ok).toBe(true);
  });

  it('checks the account before taking a snapshot', async () => {
    // Order matters for cost: a snapshot of a 500k audience is the
    // expensive part of a launch, and there is nothing to learn from taking
    // one for a workspace that cannot send.
    const { port: p, calls } = port({
      async ownerEmailIsVerified() {
        return false;
      },
    });

    await launchCampaign('c1', p);

    expect(calls.indexOf('ownerVerified')).toBeLessThan(
      calls.indexOf('snapshot') === -1 ? Infinity : calls.indexOf('snapshot'),
    );
    expect(calls).not.toContain('snapshot');
  });
});

describe('consent is re-confirmed at launch (docs/06)', () => {
  it('refuses a campaign with no attestation', async () => {
    const { port: p } = port({
      async readConsentAttestation() {
        return null;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.failure).toBe('consent_not_attested');
  });

  it('refuses one made before the audience changed', async () => {
    // The attack: attest about a small hand-built list, swap the audience
    // for a purchased one, launch.
    const { port: p } = port({
      async readConsentAttestation() {
        return {
          source: 'signup_form' as const,
          detail: null,
          audienceFingerprint: audienceFingerprint({ listIds: ['something-else'] }),
          attestedAt: NOW,
          attestedBy: 'user-1',
        };
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.failure).toBe('consent_audience_changed');
  });

  it('checks consent before taking a snapshot', async () => {
    // A launch that is going to be refused should not first write a
    // recipient row per contact, and the fingerprint is about the audience
    // *definition*, which needs no snapshot to evaluate.
    const { port: p, calls } = port({
      async readConsentAttestation() {
        return null;
      },
    });

    await launchCampaign('c1', p);

    expect(calls).not.toContain('snapshot');
    expect(calls).toContain('release');
  });

  it('launches when consent is fresh and about this audience', async () => {
    // Without this, every test above passes just as well with a gate that
    // refuses every launch.
    const { port: p } = port();

    const result = await launchCampaign('c1', p);

    expect(result.ok).toBe(true);
  });
});

describe('the enforcement ladder stops a launch (docs/06)', () => {
  it('refuses a paused workspace', async () => {
    const { port: p } = port({
      async readEnforcementStage() {
        return 'paused' as const;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.failure).toBe('enforcement_paused');
  });

  it('refuses every stage above paused', async () => {
    for (const stage of ['suspended', 'terminated'] as const) {
      const { port: p } = port({
        async readEnforcementStage() {
          return stage;
        },
      });

      const result = await launchCampaign('c1', p);
      expect(result.failure, stage).toBe('enforcement_paused');
    }
  });

  it('refuses an unapproved campaign while under review', async () => {
    const { port: p } = port({
      async readEnforcementStage() {
        return 'review_required' as const;
      },
      async launchIsApproved() {
        return false;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.failure).toBe('enforcement_review_required');
  });

  it('allows an approved campaign while under review', async () => {
    // Without this, the test above passes just as well with a stage that
    // blocks unconditionally — which would make `review_required` a second
    // name for `paused` and collapse the ladder.
    const { port: p } = port({
      async readEnforcementStage() {
        return 'review_required' as const;
      },
      async launchIsApproved() {
        return true;
      },
    });

    expect((await launchCampaign('c1', p)).ok).toBe(true);
  });

  it('lets a warned workspace send without approval', async () => {
    // A warning that stopped sending would be a pause with a friendlier
    // name, and the five-rung ladder would really have three.
    const { port: p, calls } = port({
      async readEnforcementStage() {
        return 'warned' as const;
      },
    });

    expect((await launchCampaign('c1', p)).ok).toBe(true);
    expect(calls).not.toContain('approved');
  });

  it('checks enforcement before taking a snapshot', async () => {
    // A paused workspace should not first write a recipient row per contact.
    const { port: p, calls } = port({
      async readEnforcementStage() {
        return 'paused' as const;
      },
    });

    await launchCampaign('c1', p);

    expect(calls).not.toContain('snapshot');
    expect(calls).toContain('release');
  });

  it('checks enforcement before consent', async () => {
    // A paused workspace should be told it is paused, not asked to tick a
    // consent box it will then be refused on anyway.
    const { port: p } = port({
      async readEnforcementStage() {
        return 'paused' as const;
      },
      async readConsentAttestation() {
        return null;
      },
    });

    const result = await launchCampaign('c1', p);

    expect(result.failure).toBe('enforcement_paused');
  });
});

describe('content scanning stops a launch (docs/06)', () => {
  it('refuses a campaign the lint blocked', async () => {
    const { port: p } = port({
      async scanContent() {
        return {
          blocked: true,
          findings: [
            {
              code: 'brand_impersonation' as const,
              severity: 'blocking' as const,
              message: 'x',
            },
          ],
          blockedDomains: [],
          reputationUnavailable: false,
        };
      },
    });

    expect((await launchCampaign('c1', p)).failure).toBe('content_blocked');
  });

  it('refuses a campaign linking to a flagged domain', async () => {
    const { port: p } = port({
      async scanContent() {
        return {
          blocked: false,
          findings: [],
          blockedDomains: ['evil.test'],
          reputationUnavailable: false,
        };
      },
    });

    expect((await launchCampaign('c1', p)).failure).toBe('blocked_link_domain');
  });

  it('reports a flagged domain rather than a generic refusal', async () => {
    // The sender has to know which link to remove. "Content blocked" leaves
    // them staring at a campaign with fifteen links.
    const { port: p } = port({
      async scanContent() {
        return {
          blocked: false,
          findings: [],
          blockedDomains: ['evil.test'],
          reputationUnavailable: false,
        };
      },
    });

    expect((await launchCampaign('c1', p)).message).toContain('evil.test');
  });

  it('launches with warnings, and records them', async () => {
    // Most campaigns have something worth saying and nothing worth stopping.
    // A lint that only spoke when it blocked would throw away most of its
    // value: an honest sender fixes a mismatched link, a dishonest one
    // learns we are looking.
    const { port: p, events } = port({
      async scanContent() {
        return {
          blocked: false,
          findings: [
            { code: 'url_shortener' as const, severity: 'warning' as const, message: 'x' },
          ],
          blockedDomains: [],
          reputationUnavailable: false,
        };
      },
    });

    expect((await launchCampaign('c1', p)).ok).toBe(true);
    expect(events).toContain('launch.content_warnings');
  });

  it('records that the reputation feed was unreachable', async () => {
    // The check fails open. That decision has to be visible afterwards, or
    // "was this campaign checked" has no answer.
    const { port: p, events } = port({
      async scanContent() {
        return {
          blocked: false,
          findings: [],
          blockedDomains: [],
          reputationUnavailable: true,
        };
      },
    });

    expect((await launchCampaign('c1', p)).ok).toBe(true);
    expect(events).toContain('launch.reputation_unavailable');
  });

  it('scans before taking a snapshot', async () => {
    const { port: p, calls } = port({
      async scanContent() {
        return {
          blocked: true,
          findings: [],
          blockedDomains: [],
          reputationUnavailable: false,
        };
      },
    });

    await launchCampaign('c1', p);

    expect(calls).not.toContain('snapshot');
    expect(calls).toContain('release');
  });

  it('does not scan a campaign already refused for enforcement', async () => {
    // Rendering the message is the expensive part of the scan, and there is
    // no point paying for it on a launch that was going to be refused.
    const { port: p, calls } = port({
      async readEnforcementStage() {
        return 'paused' as const;
      },
    });

    await launchCampaign('c1', p);

    expect(calls).not.toContain('scan');
  });
});
