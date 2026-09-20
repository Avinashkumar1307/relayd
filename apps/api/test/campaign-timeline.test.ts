import { describe, expect, it } from 'vitest';
import { audienceFingerprint } from '@relayd/campaigns';
import type { CampaignEventRow, WorkspaceScope } from '@relayd/db';
import type { CampaignId } from '@relayd/types';
import {
  CampaignService,
  describeCampaignEvent,
  type CampaignRepositories,
} from '../src/services/campaigns.js';

/**
 * G3's event timeline, G1's Archive action, and G2 step 7's pre-flight.
 *
 * Three properties matter here and are not covered anywhere else:
 *
 *   The timeline quotes the numbers the event carried, never a live count.
 *   "31,618 of 48,213 handed to providers" has to still read correctly when
 *   the page is reopened next week — and R13 forbids counting recipients in
 *   a request path in any case.
 *
 *   Archiving answers three different refusals for three different
 *   situations, because the customer has to do something different in each.
 *
 *   The pre-flight takes no claim, writes no event and takes no snapshot.
 *   The wizard polls it.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const ID = 'c1' as CampaignId;
const NOW = new Date('2026-09-19T12:00:00.000Z');

const CAMPAIGN = {
  id: ID,
  workspaceId: 'ws-1',
  name: 'Autumn escapes',
  status: 'completed',
  subjectOverride: null,
  senderAccountId: 'sa-1',
  sendingPoolId: null,
  audience: {},
  throttlePerHour: null,
  scheduledAt: null,
  timezone: 'Asia/Dubai',
  recipientCount: 48_213,
  templateVersionId: 'v1',
  launchedAt: null,
  completedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  archivedAt: null,
};

const ERROR_POLICY = { rate_limited: { retryable: true } };

function event(over: Partial<CampaignEventRow> = {}): CampaignEventRow {
  return {
    id: '1',
    eventType: 'launch.queued',
    actorType: 'system',
    actorId: null,
    actorName: null,
    detail: {},
    createdAt: NOW,
    ...over,
  };
}

function service(
  over: {
    campaign?: Record<string, unknown> | null;
    events?: CampaignEventRow[];
    archive?: () => Promise<unknown>;
    unarchive?: () => Promise<unknown>;
    launchPort?: Record<string, unknown>;
  } = {},
) {
  const audits: { action: string }[] = [];
  const portCalls: string[] = [];

  const campaign = over.campaign === undefined ? CAMPAIGN : over.campaign;

  const campaigns = {
    async findById() {
      return campaign;
    },
    async listEvents() {
      return over.events ?? [];
    },
    async archive() {
      return over.archive === undefined ? { ...CAMPAIGN, archivedAt: NOW } : over.archive();
    },
    async unarchive() {
      return over.unarchive === undefined ? { ...CAMPAIGN, archivedAt: null } : over.unarchive();
    },
  } as unknown as CampaignRepositories['campaigns'];

  const repos: CampaignRepositories = {
    campaigns,
    auditLogs: {
      async append(_scope: unknown, entry: { action: string }) {
        audits.push(entry);
      },
    } as unknown as CampaignRepositories['auditLogs'],
    consent: {} as unknown as CampaignRepositories['consent'],
  };

  const launchPort = {
    async claimForLaunch() {
      portCalls.push('claim');
      return true;
    },
    async readCampaign() {
      portCalls.push('read');
      return campaign === null
        ? null
        : {
            id: ID,
            workspaceId: 'ws-1',
            templateVersionId: 'v1',
            senderAccountId: 'sa-1',
            sendingPoolId: null,
            audience: {},
          };
    },
    async readEntitlementForShare() {
      portCalls.push('entitlement');
      return { monthlySendLimit: null, used: 0 };
    },
    async senderIsUsable() {
      return true;
    },
    async ownerEmailIsVerified() {
      return true;
    },
    async workspaceIsInRamp() {
      return false;
    },
    async readEnforcementStage() {
      return 'none' as const;
    },
    async launchIsApproved() {
      return true;
    },
    async scanContent() {
      portCalls.push('scan');
      return { blocked: false, findings: [], blockedDomains: [], reputationUnavailable: false };
    },
    async readConsentAttestation() {
      return null;
    },
    async snapshotAudience() {
      portCalls.push('snapshot');
      return { inserted: 1, suppressedAtSnapshot: 0 };
    },
    async initialiseCounters() {
      portCalls.push('counters');
    },
    async markQueueing() {
      portCalls.push('queueing');
    },
    async releaseClaim() {
      portCalls.push('release');
    },
    async recordEvent() {
      portCalls.push('event');
    },
    ...over.launchPort,
  };

  const instance = new CampaignService({
    unitOfWork: (fn) => fn(repos),
    newId: () => 'generated-id',
    currentActor: () => ({ type: 'user', id: 'u1' }),
    errorPolicy: ERROR_POLICY,
    async enqueueDispatch() {
      portCalls.push('dispatch');
    },
    now: () => NOW,
    ports: {
      launch: () => launchPort as never,
      lifecycle: () => ({}) as never,
      retry: () => ({}) as never,
    },
  });

  return { service: instance, audits, portCalls };
}

/* --------------------------------------------------------- the describer -- */

describe('rendering one timeline entry', () => {
  const context = { zone: 'Asia/Dubai', now: NOW };

  it('gives a known event its title and tone', () => {
    const row = describeCampaignEvent(event({ eventType: 'campaign.paused' }), context);

    expect(row.title).toBe('Paused automatically');
    expect(row.tone).toBe('warning');
  });

  it('does not drop an event type nobody thought about', () => {
    // A timeline that silently omits the entry explaining why a campaign
    // stopped is worse than one that prints a clumsy title.
    const row = describeCampaignEvent(event({ eventType: 'something.new' }), context);

    expect(row.title).toBe('Something new');
    expect(row.tone).toBe('neutral');
  });

  it('quotes the numbers the event carried', () => {
    const row = describeCampaignEvent(
      event({ detail: { recipientCount: 48_213, suppressedAtSnapshot: 2318 } }),
      context,
    );

    expect(row.detail).toContain('48,213');
    expect(row.detail).toContain('2,318');
  });

  it('survives a detail blob written by an older version of the code', () => {
    // The column is jsonb. A row whose shape we no longer produce is not a
    // reason to fail the page it appears on.
    expect(() => describeCampaignEvent(event({ detail: null }), context)).not.toThrow();
    expect(() => describeCampaignEvent(event({ detail: 'nonsense' }), context)).not.toThrow();
    expect(() =>
      describeCampaignEvent(event({ detail: { recipientCount: 'lots' } }), context),
    ).not.toThrow();
  });

  it('names the person, not their id', () => {
    const row = describeCampaignEvent(
      event({ actorType: 'user', actorId: 'u1', actorName: 'Farah Al-Mansoori' }),
      context,
    );

    expect(row.detail).toContain('Farah Al-Mansoori');
    expect(row.detail).not.toContain('u1');
  });

  it('says something useful for a user whose name did not resolve', () => {
    const row = describeCampaignEvent(event({ actorType: 'user', actorId: 'u1' }), context);
    expect(row.detail).toContain('A member of this workspace');
  });

  it('attributes an API key and a provider without inventing a person', () => {
    expect(describeCampaignEvent(event({ actorType: 'api_key' }), context).detail).toContain(
      'An API key',
    );
    expect(describeCampaignEvent(event({ actorType: 'provider' }), context).detail).toContain(
      'The provider',
    );
  });

  it('says nothing about who for a system event', () => {
    const row = describeCampaignEvent(event({ actorType: 'system' }), context);
    expect(row.detail).not.toContain('workspace');
  });

  it('renders today as a clock time', () => {
    const row = describeCampaignEvent(
      event({ createdAt: new Date('2026-09-19T07:02:00.000Z') }),
      context,
    );

    // 07:02 UTC is 11:02 in Dubai, which is the time the customer's
    // recipients saw and the time G3 draws.
    expect(row.time).toBe('11:02');
  });

  it('renders an earlier day with its date', () => {
    const row = describeCampaignEvent(
      event({ createdAt: new Date('2026-09-18T12:20:00.000Z') }),
      context,
    );

    expect(row.time).toBe('18 Sep, 16:20');
  });

  it('uses the campaign timezone, not the server one', () => {
    // A Dubai campaign read from a laptop in London has to say the time the
    // customer scheduled.
    const at = new Date('2026-09-19T07:02:00.000Z');

    expect(describeCampaignEvent(event({ createdAt: at }), { zone: 'UTC', now: NOW }).time).toBe(
      '07:02',
    );
    expect(
      describeCampaignEvent(event({ createdAt: at }), { zone: 'Asia/Dubai', now: NOW }).time,
    ).toBe('11:02');
  });

  it('falls back to UTC for a timezone Intl does not know', () => {
    // A column that a migration once allowed anything into must not take
    // the page down.
    const row = describeCampaignEvent(
      event({ createdAt: new Date('2026-09-19T07:02:00.000Z') }),
      { zone: 'Mars/Olympus_Mons', now: NOW },
    );

    expect(row.time).toBe('07:02');
  });

  it('carries the instant alongside the rendered time', () => {
    const row = describeCampaignEvent(event({ createdAt: NOW }), context);
    expect(row.occurredAt).toBe(NOW.toISOString());
  });

  it('spells out why a launch was refused', () => {
    const row = describeCampaignEvent(
      event({ eventType: 'launch.rejected', detail: { failure: 'consent_not_attested' } }),
      context,
    );

    expect(row.tone).toBe('danger');
    expect(row.detail).toContain('Consent not attested');
  });
});

/* ------------------------------------------------------------- the route -- */

describe('reading the timeline', () => {
  it('answers 404 for a campaign in another workspace', async () => {
    // Not an empty list. An empty list is a slow oracle: it tells the caller
    // the id exists, just quietly.
    const { service: instance } = service({ campaign: null });

    await expect(instance.timeline(SCOPE, ID)).rejects.toMatchObject({ status: 404 });
  });

  it('returns the events newest first, as the repository ordered them', async () => {
    const { service: instance } = service({
      events: [
        event({ id: '2', eventType: 'campaign.completed' }),
        event({ id: '1', eventType: 'launch.queued' }),
      ],
    });

    const rows = await instance.timeline(SCOPE, ID);

    expect(rows.map((row) => row.id)).toEqual(['2', '1']);
    expect(rows[0]?.title).toBe('Completed');
  });

  it('renders in the campaign timezone', async () => {
    const { service: instance } = service({
      events: [event({ createdAt: new Date('2026-09-19T07:02:00.000Z') })],
    });

    expect((await instance.timeline(SCOPE, ID))[0]?.time).toBe('11:02');
  });

  it('falls back to UTC for a campaign with no timezone set', async () => {
    const { service: instance } = service({
      campaign: { ...CAMPAIGN, timezone: null },
      events: [event({ createdAt: new Date('2026-09-19T07:02:00.000Z') })],
    });

    expect((await instance.timeline(SCOPE, ID))[0]?.time).toBe('07:02');
  });
});

/* -------------------------------------------------------------- archival -- */

describe('archiving a campaign', () => {
  it('archives a finished one', async () => {
    const { service: instance, audits } = service();

    const result = await instance.archive(SCOPE, ID);

    expect(result.archivedAt).toEqual(NOW);
    expect(audits.map((entry) => entry.action)).toContain('campaign.archived');
  });

  it('answers 404 for a campaign in another workspace', async () => {
    const { service: instance } = service({
      campaign: null,
      archive: async () => null,
    });

    await expect(instance.archive(SCOPE, ID)).rejects.toMatchObject({ status: 404 });
  });

  it('answers 409 for a campaign that has not finished', async () => {
    // The guard matched nothing and the row is not archived, so the reason
    // is the status — and telling the customer that is the difference
    // between a message they can act on and one they cannot.
    const { service: instance } = service({
      campaign: { ...CAMPAIGN, status: 'sending', archivedAt: null },
      archive: async () => null,
    });

    await expect(instance.archive(SCOPE, ID)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('finished'),
    });
  });

  it('answers 409, with a different message, for one already archived', async () => {
    const { service: instance } = service({
      campaign: { ...CAMPAIGN, archivedAt: NOW },
      archive: async () => null,
    });

    await expect(instance.archive(SCOPE, ID)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already archived'),
    });
  });

  it('unarchives, and records it', async () => {
    const { service: instance, audits } = service();

    const result = await instance.unarchive(SCOPE, ID);

    expect(result.archivedAt).toBeNull();
    expect(audits.map((entry) => entry.action)).toContain('campaign.unarchived');
  });

  it('answers 409 when unarchiving one that is not archived', async () => {
    const { service: instance } = service({ unarchive: async () => null });

    await expect(instance.unarchive(SCOPE, ID)).rejects.toMatchObject({ status: 409 });
  });
});

/* ------------------------------------------------------------- pre-flight -- */

describe('the pre-flight endpoint', () => {
  it('reports the failure the launch would give, without launching', async () => {
    const { service: instance, portCalls } = service();

    const result = await instance.preflight(SCOPE, ID);

    // No attestation in this fixture, so consent is the refusal.
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('consent_not_attested');

    expect(portCalls).not.toContain('claim');
    expect(portCalls).not.toContain('snapshot');
    expect(portCalls).not.toContain('queueing');
    expect(portCalls).not.toContain('event');
  });

  it('returns every check, not only the failing one', async () => {
    const { service: instance } = service();

    const result = await instance.preflight(SCOPE, ID);

    expect(result.checks.length).toBeGreaterThan(5);
    expect(result.checks.filter((check) => check.outcome === 'pass').length).toBeGreaterThan(3);
  });

  it('carries the launch failure code on the failing row', async () => {
    // So a caller can map one row to one remedy rather than reading the
    // summary and guessing which row it meant.
    const { service: instance } = service();

    const result = await instance.preflight(SCOPE, ID);
    const consent = result.checks.find((check) => check.key === 'consent');

    expect(consent?.outcome).toBe('fail');
    expect(consent?.failure).toBe('consent_not_attested');
  });

  it('writes no audit row', async () => {
    // The wizard polls this. An audit log with one row per keystroke on
    // step 7 is an audit log nobody can read.
    const { service: instance, audits } = service();

    await instance.preflight(SCOPE, ID);

    expect(audits).toEqual([]);
  });

  it('answers 404 for a campaign in another workspace', async () => {
    const { service: instance } = service({
      launchPort: { async readCampaign() { return null; } },
    });

    await expect(instance.preflight(SCOPE, ID)).rejects.toMatchObject({ status: 404 });
  });

  it('is ok when nothing refuses it', async () => {
    const { service: instance } = service({
      launchPort: {
        async readConsentAttestation() {
          return {
            source: 'signup_form' as const,
            detail: null,
            audienceFingerprint: audienceFingerprint({}),
            attestedAt: NOW,
            attestedBy: 'u1',
          };
        },
      },
    });

    const result = await instance.preflight(SCOPE, ID);

    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.checks.every((check) => check.outcome !== 'fail')).toBe(true);
  });
});
