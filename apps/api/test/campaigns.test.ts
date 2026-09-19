import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@relayd/types';
import { audienceFingerprint } from '@relayd/campaigns';
import type { CampaignId } from '@relayd/types';
import type { WorkspaceScope } from '@relayd/db';
import { CampaignService } from '../src/services/campaigns.js';
import type { CampaignRepositories, CampaignServiceOptions } from '../src/services/campaigns.js';

/**
 * The campaign service.
 *
 * Deliberately thin, so this file is short. Everything that decides anything
 * — the guarded claim, the entitlement lock, the snapshot, the lattice — is
 * tested in `packages/campaigns` against ports. What is left is the part that
 * is genuinely an API concern, and the three things worth holding onto here
 * are: which failure becomes which status, what a replayed launch returns,
 * and that nothing in a polling path counts recipients.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const CONSENT = { source: 'signup_form', detail: null, ip: null };

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const ID = 'c1' as CampaignId;

const ERROR_POLICY = {
  rate_limited: { retryable: true },
  invalid_recipient: { retryable: false },
  content_rejected: { retryable: false },
};

const DRAFT = {
  id: ID,
  workspaceId: 'ws-1',
  name: 'Spring',
  status: 'draft',
  subjectOverride: null,
  senderAccountId: null,
  sendingPoolId: null,
  audience: {},
  throttlePerHour: null,
  scheduledAt: null,
  timezone: null,
  recipientCount: 0,
  templateVersionId: null,
  launchedAt: null,
  completedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
};

const COUNTERS = {
  campaignId: ID,
  total: 1000,
  pending: 200,
  queued: 50,
  sending: 10,
  sent: 700,
  failed: 30,
  suppressed: 5,
  uncertain: 5,
  updatedAt: new Date(),
};

function service(over: {
  campaigns?: Partial<CampaignRepositories['campaigns']>;
  launchResult?: Awaited<ReturnType<typeof import('@relayd/campaigns').launchCampaign>>;
  lifecycleResult?: Awaited<ReturnType<typeof import('@relayd/campaigns').applyLifecycleAction>>;
} = {}) {
  const audits: string[] = [];
  const attestations: {
    subjectKind: string;
    source: string;
    attestedBy: string;
    audienceFingerprint: string | null;
  }[] = [];
  const dispatched: string[] = [];

  const campaigns = {
    async list() {
      return { items: [DRAFT], nextCursor: null };
    },
    async findById() {
      return DRAFT;
    },
    async readCounters() {
      return COUNTERS;
    },
    async listRecipients() {
      return { items: [], nextCursor: null };
    },
    async create() {
      return DRAFT;
    },
    async update() {
      return DRAFT;
    },
    async remove() {
      return true;
    },
    async schedule() {
      return DRAFT;
    },
    async clone() {
      return DRAFT;
    },
    async claimLaunchKey() {
      return 'claimed' as const;
    },
    async findLaunchByKey() {
      return null;
    },
    async enqueueTestSend() {
      return { queued: 1 };
    },
    async previewAudienceCount() {
      return { eligible: 900, suppressed: 100 };
    },
    ...over.campaigns,
  } as unknown as CampaignRepositories['campaigns'];

  const repos: CampaignRepositories = {
    campaigns,
    auditLogs: {
      async append(_scope: unknown, entry: { action: string }) {
        audits.push(entry.action);
      },
    } as unknown as CampaignRepositories['auditLogs'],
    consent: {
      async record(
        _scope: unknown,
        input: {
          subjectKind: string;
          source: string;
          attestedBy: string;
          audienceFingerprint: string | null;
        },
      ) {
        attestations.push(input);
        return input;
      },
      async newestFor() {
        return null;
      },
    } as unknown as CampaignRepositories['consent'],
  };

  const launchResult = over.launchResult ?? {
    ok: true as const,
    recipientCount: 1000,
    suppressedAtSnapshot: 12,
  };

  const lifecycleResult = over.lifecycleResult ?? { ok: true as const, state: 'pausing' as const };

  const options: CampaignServiceOptions = {
    unitOfWork: (fn) => fn(repos),
    newId: () => 'generated-id',
    currentActor: () => ({ type: 'user', id: 'u1' }),
    errorPolicy: ERROR_POLICY,
    async enqueueDispatch(input) {
      dispatched.push(input.campaignId);
    },
    ports: {
      // The real engine runs against this port. Each intended failure is
      // produced the way the engine actually reaches it, rather than by
      // short-circuiting `launchCampaign` — otherwise the status mapping is
      // tested against a value this file made up, and the first version of
      // this harness did exactly that and reported every failure as
      // `not_launchable`.
      launch: () => {
        const failure = launchResult.ok ? undefined : launchResult.failure;

        return {
          async claimForLaunch() {
            return failure !== 'not_launchable';
          },
          async readCampaign() {
            return {
              id: ID,
              workspaceId: 'ws-1',
              templateVersionId: failure === 'no_template' ? null : 'v1',
              senderAccountId: failure === 'no_sender' ? null : 'sa-1',
              sendingPoolId: failure === 'pool_routing_unavailable' ? 'pool-1' : null,
              audience: {},
            };
          },
          async readEntitlementForShare() {
            if (failure === 'no_entitlement') return null;
            return failure === 'entitlement_exceeded'
              ? { monthlySendLimit: 10, used: 0 }
              : { monthlySendLimit: null, used: 0 };
          },
          async senderIsUsable() {
            return failure !== 'unverified_sender';
          },
          async ownerEmailIsVerified() {
            return failure !== 'unverified_account';
          },
          async workspaceIsInRamp() {
            return failure === 'pool_routing_unavailable';
          },
          async readEnforcementStage() {
            if (failure === 'enforcement_paused') return 'paused' as const;
            if (failure === 'enforcement_review_required') return 'review_required' as const;
            return 'none' as const;
          },
          async launchIsApproved() {
            return failure !== 'enforcement_review_required';
          },
          async scanContent() {
            return {
              blocked: failure === 'content_blocked',
              findings: [],
              blockedDomains: failure === 'blocked_link_domain' ? ['evil.test'] : [],
              reputationUnavailable: false,
            };
          },
          async readConsentAttestation() {
            if (failure === 'consent_not_attested') return null;
            return {
              source: 'signup_form' as const,
              detail: null,
              audienceFingerprint:
                failure === 'consent_audience_changed'
                  ? 'not-the-current-audience'
                  : audienceFingerprint({}),
              attestedAt: NOW,
              attestedBy: 'user-1',
            };
          },
          async snapshotAudience() {
            return {
              inserted: failure === 'empty_audience' ? 0 : 1000,
              suppressedAtSnapshot: 12,
            };
          },
          async initialiseCounters() {
            /* nothing */
          },
          async markQueueing() {
            /* nothing */
          },
          async releaseClaim() {
            /* nothing */
          },
          async recordEvent() {
            /* nothing */
          },
        } as never;
      },
      lifecycle: () =>
        ({
          async transition() {
            return lifecycleResult.ok ? (lifecycleResult.state ?? 'pausing') : null;
          },
          async setHaltFlag() {
            /* nothing */
          },
          async cancelOutstandingRecipients() {
            return 0;
          },
          async inFlightCount() {
            return 5;
          },
          async enqueueDispatch() {
            /* nothing */
          },
          async recordEvent() {
            /* nothing */
          },
        }) as never,
      retry: () =>
        ({
          async resetRetryableFailures() {
            return 12;
          },
          async countPermanentFailures() {
            return { invalid_recipient: 3 };
          },
          async reopenForDispatch() {
            return true;
          },
          async recordEvent() {
            /* nothing */
          },
        }) as never,
    },
  };

  return { service: new CampaignService(options), audits, dispatched, campaigns, attestations };
}

describe('progress never counts recipients (R13, F13)', () => {
  it('reads the counter row and nothing else', async () => {
    const readCounters = vi.fn(async () => COUNTERS);
    const { service: s } = service({ campaigns: { readCounters } as never });

    await s.progress(SCOPE, ID);

    expect(readCounters).toHaveBeenCalledOnce();
  });

  it('derives outstanding from pending, queued and sending', async () => {
    const { service: s } = service();

    const result = await s.progress(SCOPE, ID);

    expect(result.outstanding).toBe(260);
    expect(result.complete).toBe(false);
  });

  it('calls a campaign complete only when nothing is outstanding', async () => {
    const { service: s } = service({
      campaigns: {
        async readCounters() {
          return { ...COUNTERS, pending: 0, queued: 0, sending: 0 };
        },
      } as never,
    });

    expect((await s.progress(SCOPE, ID)).complete).toBe(true);
  });

  it('reports delivery_uncertain as its own number', async () => {
    // D3 makes these terminal and unbilled. Folding them into failures would
    // tell the customer we could not send when we do not know whether we did.
    const { service: s } = service();

    const result = await s.progress(SCOPE, ID);

    expect(result.deliveryUncertain).toBe(5);
    expect(result.failed).toBe(30);
  });

  it('404s a campaign with no counter row', async () => {
    const { service: s } = service({
      campaigns: { async readCounters() { return null; } } as never,
    });

    await expect(s.progress(SCOPE, ID)).rejects.toThrow(AppError);
  });
});

describe('editing after launch', () => {
  it('refuses to update a campaign that has left draft', async () => {
    // A launched campaign has a snapshot and a pinned template behind it.
    // Editing the subject changes what the report says was sent.
    const { service: s } = service({
      campaigns: { async findById() { return { ...DRAFT, status: 'sending' }; } } as never,
    });

    await expect(s.update(SCOPE, ID, { name: 'x' })).rejects.toThrow(/already been launched/u);
  });

  it('allows an update to a scheduled campaign', async () => {
    const { service: s } = service({
      campaigns: { async findById() { return { ...DRAFT, status: 'scheduled' }; } } as never,
    });

    await expect(s.update(SCOPE, ID, { name: 'x' })).resolves.toBeDefined();
  });

  it('refuses to delete a launched campaign', async () => {
    // It is the record of what was sent to whom, which a customer may be
    // legally required to produce.
    const { service: s } = service({
      campaigns: { async findById() { return { ...DRAFT, status: 'completed' }; } } as never,
    });

    await expect(s.remove(SCOPE, ID)).rejects.toThrow(/cannot be deleted/u);
  });
});

describe('scheduling', () => {
  it('refuses a time in the past', async () => {
    const { service: s } = service();

    await expect(
      s.schedule(SCOPE, ID, { scheduledAt: new Date(Date.now() - 1000), timezone: 'UTC' }),
    ).rejects.toThrow(/in the past/u);
  });

  it('409s when the guarded update matches nothing', async () => {
    const { service: s } = service({
      campaigns: { async schedule() { return null; } } as never,
    });

    await expect(
      s.schedule(SCOPE, ID, { scheduledAt: new Date(Date.now() + 60_000), timezone: 'UTC' }),
    ).rejects.toThrow(/cannot be scheduled/u);
  });
});

describe('launch', () => {
  it('enqueues the dispatch job', async () => {
    const { service: s, dispatched } = service();

    await s.launch(SCOPE, ID);

    expect(dispatched).toEqual([ID]);
  });

  it('returns the winner’s result to a replayed request (F29)', async () => {
    // A retried HTTP request must not get a 409 it cannot distinguish from a
    // real conflict.
    const { service: s, dispatched } = service({
      campaigns: {
        async claimLaunchKey() {
          return 'taken' as const;
        },
        async findLaunchByKey() {
          return { ok: true as const, recipientCount: 1000, suppressedAtSnapshot: 0 };
        },
      } as never,
    });

    const result = await s.launch(SCOPE, ID, { idempotencyKey: 'key-1' });

    expect(result).toMatchObject({ ok: true, recipientCount: 1000 });
    // The replay must not enqueue a second dispatch job.
    expect(dispatched).toEqual([]);
  });

  it('falls through to the engine when a different key holds the campaign', async () => {
    // Not a replay — a second launch of an already-launched campaign, which
    // deserves the ordinary refusal rather than somebody else's result.
    const { service: s } = service({
      campaigns: {
        async claimLaunchKey() {
          return 'taken' as const;
        },
        async findLaunchByKey() {
          return null;
        },
      } as never,
      launchResult: { ok: false, failure: 'not_launchable', message: 'nope' },
    });

    await expect(s.launch(SCOPE, ID, { idempotencyKey: 'other' })).rejects.toThrow(AppError);
  });

  it('maps a state conflict to 409', async () => {
    const { service: s } = service({
      launchResult: { ok: false, failure: 'not_launchable', message: 'nope' },
    });

    await expect(s.launch(SCOPE, ID)).rejects.toMatchObject({ status: 409 });
  });

  it('maps a fixable problem to 422', async () => {
    // The distinction the UI acts on: 409 means look at what someone else
    // did, 422 means the review step will show you where.
    for (const failure of ['no_template', 'no_sender', 'empty_audience', 'unverified_sender']) {
      const { service: s } = service({
        launchResult: { ok: false, failure: failure as never, message: 'nope' },
      });

      await expect(s.launch(SCOPE, ID), failure).rejects.toMatchObject({ status: 422 });
    }
  });

  it('maps an exhausted plan to 402', async () => {
    const { service: s } = service({
      launchResult: { ok: false, failure: 'entitlement_exceeded', message: 'over' },
    });

    await expect(s.launch(SCOPE, ID)).rejects.toMatchObject({ status: 402 });
  });

  it('maps a workspace with no subscription to 402', async () => {
    // D7: no free tier. 402 rather than 403, because the customer fixes this
    // with money and the frontend renders an upgrade prompt for a 402.
    const { service: s } = service({
      launchResult: { ok: false, failure: 'no_entitlement', message: 'no plan' },
    });

    await expect(s.launch(SCOPE, ID)).rejects.toMatchObject({ status: 402 });
  });

  it('does not enqueue a dispatch for a refused launch', async () => {
    const { service: s, dispatched } = service({
      launchResult: { ok: false, failure: 'no_template', message: 'nope' },
    });

    await s.launch(SCOPE, ID).catch(() => undefined);

    expect(dispatched).toEqual([]);
  });

  it('records the launch in the audit log', async () => {
    const { service: s, audits } = service();
    await s.launch(SCOPE, ID);
    expect(audits).toContain('campaign.launched');
  });
});

describe('lifecycle actions', () => {
  it('409s a refused transition', async () => {
    const { service: s } = service({
      lifecycleResult: { ok: false, reason: 'not pausable' },
    });

    await expect(s.lifecycle(SCOPE, ID, 'pause')).rejects.toMatchObject({ status: 409 });
  });

  it('audits the action that happened', async () => {
    const { service: s, audits } = service();
    await s.lifecycle(SCOPE, ID, 'pause');
    expect(audits).toContain('campaign.pause');
  });
});

describe('retry-failed', () => {
  it('restarts the dispatcher when it reopened the campaign', async () => {
    const { service: s, dispatched } = service();

    await s.retryFailed(SCOPE, ID);

    expect(dispatched).toEqual([ID]);
  });

  it('reports what it excluded', async () => {
    const { service: s } = service();

    const result = await s.retryFailed(SCOPE, ID);

    expect(result.excluded).toEqual({ invalid_recipient: 3 });
  });
});

describe('clone', () => {
  it('names the copy after the original by default', async () => {
    let seen: string | undefined;
    const { service: s } = service({
      campaigns: {
        async clone(_scope: unknown, input: { name: string }) {
          seen = input.name;
          return DRAFT;
        },
      } as never,
    });

    await s.clone(SCOPE, ID);

    expect(seen).toBe('Spring (copy)');
  });

  it('takes a name when given one', async () => {
    let seen: string | undefined;
    const { service: s } = service({
      campaigns: {
        async clone(_scope: unknown, input: { name: string }) {
          seen = input.name;
          return DRAFT;
        },
      } as never,
    });

    await s.clone(SCOPE, ID, 'Autumn');

    expect(seen).toBe('Autumn');
  });
});

describe('the audience preview', () => {
  it('reports eligible, suppressed and the total', async () => {
    const { service: s } = service();

    expect(await s.previewAudience(SCOPE, { listIds: ['l1'] })).toEqual({
      eligible: 900,
      suppressed: 100,
      total: 1000,
    });
  });

  it('counts suppression the same way the snapshot will', async () => {
    // A preview that omits the suppression check reads high by exactly the
    // number launch will then refuse to send to, and the author is left
    // wondering where the missing recipients went.
    const { service: s } = service();

    const result = await s.previewAudience(SCOPE, { listIds: ['l1'] });

    expect(result.eligible).toBeLessThan(result.total);
  });
});

describe('the anti-abuse refusals are not validation errors', () => {
  it('maps an unverified account to 403', async () => {
    // 403, not 422. Both are things the customer must change, but 422 says
    // "this request was malformed" — and a support agent reading one goes
    // looking for a bug in the request rather than at the account.
    const { service: s } = service({
      launchResult: { ok: false, failure: 'unverified_account', message: 'verify' },
    });

    await expect(s.launch(SCOPE, ID)).rejects.toMatchObject({ status: 403 });
  });

  it('maps a pool refused to a new workspace to 403', async () => {
    const { service: s } = service({
      launchResult: { ok: false, failure: 'pool_routing_unavailable', message: 'no pools yet' },
    });

    await expect(s.launch(SCOPE, ID)).rejects.toMatchObject({ status: 403 });
  });
});

describe('the launch records the consent declaration (docs/06)', () => {
  const consent = { source: 'signup_form', detail: null, ip: '203.0.113.9' };

  it('writes an attestation, attributed to the actor', async () => {
    // docs/06: "Stored, timestamped, attributed to a user." A validated
    // declaration that is never written is a tick box with extra steps.
    const { service: s, attestations } = service();

    await s.launch(SCOPE, ID, { consent });

    expect(attestations).toEqual([
      expect.objectContaining({ subjectKind: 'campaign', source: 'signup_form' }),
    ]);
  });

  it('records the audience fingerprint', async () => {
    // Without it, the attestation is a claim about a campaign — and a
    // campaign is a row whose audience can be edited afterwards. The engine
    // has nothing to compare against and the swap goes unnoticed.
    const { service: s, attestations } = service();

    await s.launch(SCOPE, ID, { consent });

    expect(attestations[0]?.audienceFingerprint).toEqual(expect.any(String));
    expect(attestations[0]?.audienceFingerprint).not.toBeNull();
  });

  it('refuses an unknown source instead of storing it', async () => {
    // The database CHECK would reject it too, but only after the round trip
    // and inside whatever transaction the launch is holding — and the error
    // a customer would see is a constraint violation.
    const { service: s, attestations } = service();

    await expect(
      s.launch(SCOPE, ID, { consent: { source: 'trust_me', detail: null, ip: null } }),
    ).rejects.toMatchObject({ status: 422 });

    expect(attestations).toEqual([]);
  });

  it('refuses an unexplained "other"', async () => {
    const { service: s } = service();

    await expect(
      s.launch(SCOPE, ID, { consent: { source: 'other', detail: null, ip: null } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('records it even when the launch then fails', async () => {
    // An attestation that only survives a successful launch would be missing
    // from exactly the workspaces worth investigating: the ones whose
    // launches keep being refused.
    const { service: s, attestations } = service({
      launchResult: { ok: false, failure: 'empty_audience', message: 'none' },
    });

    await expect(s.launch(SCOPE, ID, { consent })).rejects.toThrow();

    expect(attestations).toHaveLength(1);
  });
});

describe('enforcement refusals are not validation errors', () => {
  it('maps a paused workspace to 403', async () => {
    // 403: the workspace is not allowed to send right now. Telling somebody
    // their campaign is malformed when their account is paused sends them
    // looking in entirely the wrong place.
    const { service: s } = service({
      launchResult: { ok: false, failure: 'enforcement_paused', message: 'paused' },
    });

    await expect(s.launch(SCOPE, ID, { consent: CONSENT })).rejects.toMatchObject({ status: 403 });
  });

  it('maps a workspace under review to 403', async () => {
    const { service: s } = service({
      launchResult: { ok: false, failure: 'enforcement_review_required', message: 'review' },
    });

    await expect(s.launch(SCOPE, ID, { consent: CONSENT })).rejects.toMatchObject({ status: 403 });
  });
});
