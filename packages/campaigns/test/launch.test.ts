import { describe, expect, it, vi } from 'vitest';
import { LAUNCHABLE_STATES, launchCampaign, type LaunchPort } from '../src/engine/launch.js';

/**
 * Campaign launch (INVARIANTS R28, R29; review findings F28, F29).
 *
 * Launch is where a draft becomes irrevocable. The two failures that matter
 * are launching twice and launching over a limit that changed underneath, and
 * both are races — so most of these tests are about ordering rather than
 * outcomes.
 */

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
