import { describe, expect, it } from 'vitest';
import type { DashboardCampaignRow, EnforcementRow, ProviderConnectionRow } from '@relayd/db';
import {
  COMPLAINT_THRESHOLD,
  bounceSplitOf,
  buildAttention,
  buildCampaigns,
  buildProviders,
  buildUsage,
  countsFor,
  deltaPoints,
  periodLabel,
  resolvePeriod,
  whenFor,
} from '../src/services/dashboard.js';

/**
 * The dashboard composition (C1).
 *
 * Pure functions, so the things that are actually easy to get wrong are
 * checkable without a database: a rate reported as zero when it should be
 * absent, a delta computed against an empty period, a percentage of an
 * unlimited allowance, a timezone the container has never heard of.
 *
 * The recurring rule: **null is not zero.** A workspace that has delivered
 * nothing has no click rate. Rendering 0% says it performed badly; rendering
 * nothing says it has not been measured, and only the second is true.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const TZ = 'Asia/Dubai';

describe('the period', () => {
  it('runs from the billing period start to today, not to the period end', () => {
    // A customer reading "1–30 Sep" on the 19th would take the numbers for a
    // full month and conclude their sending had collapsed.
    const { period } = resolvePeriod({
      now: NOW,
      currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
      timezone: TZ,
    });

    expect(period.label).toBe('1–19 Sep 2026');
    expect(period.timezone).toBe(TZ);
  });

  it('names the previous period for the delta caption', () => {
    const { period } = resolvePeriod({
      now: NOW,
      currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
      timezone: TZ,
    });

    expect(period.comparedTo).toBe('Aug');
  });

  it('falls back to the calendar month for a workspace with no subscription', () => {
    // Which is also what its usage counter is keyed by, so the band and the
    // label describe the same window.
    const { start, end } = resolvePeriod({
      now: NOW,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      timezone: 'UTC',
    });

    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('labels in UTC rather than throwing on a timezone the runtime does not know', () => {
    // A stale IANA name in a workspace row must not 500 the dashboard.
    expect(() =>
      periodLabel(
        new Date('2026-09-01T00:00:00.000Z'),
        NOW,
        'Mars/Olympus_Mons',
      ),
    ).not.toThrow();
  });

  it('spells out both months when the period straddles one', () => {
    expect(
      periodLabel(new Date('2026-08-20T00:00:00.000Z'), new Date('2026-09-19T00:00:00.000Z'), 'UTC'),
    ).toBe('20 Aug – 19 Sep 2026');
  });
});

describe('the plan usage band', () => {
  it('prints the percentage, the renewal date and the days left', () => {
    const usage = buildUsage({
      sent: 184_320,
      limit: 250_000,
      uncertain: 412,
      periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      now: NOW,
      timezone: TZ,
    });

    expect(usage.renewsLabel).toBe('74% · renews 1 Oct (12 days)');
    expect(usage.renewsShort).toBe('Renews 1 Oct');
  });

  it('omits the percentage on an unlimited plan rather than printing 0%', () => {
    // A percentage of unlimited is not a number, and 0% reads as "no
    // allowance left".
    const usage = buildUsage({
      sent: 184_320,
      limit: null,
      uncertain: 0,
      periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      now: NOW,
      timezone: TZ,
    });

    expect(usage.renewsLabel).toBe('Renews 1 Oct (12 days)');
    expect(usage.limit).toBe(0);
  });

  it('caps the percentage at 100 for a workspace in overage', () => {
    const usage = buildUsage({
      sent: 300_000,
      limit: 250_000,
      uncertain: 0,
      periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      now: NOW,
      timezone: TZ,
    });

    expect(usage.renewsLabel.startsWith('100%')).toBe(true);
  });

  it('says "today" rather than "0 days" on renewal day', () => {
    const usage = buildUsage({
      sent: 1,
      limit: 100,
      uncertain: 0,
      periodEnd: NOW,
      now: NOW,
      timezone: TZ,
    });

    expect(usage.renewsLabel).toContain('(today)');
  });

  it('carries the unbilled uncertain count (D3)', () => {
    // A customer counting their own sends will otherwise find the number
    // missing and assume we lost it.
    const usage = buildUsage({
      sent: 184_320,
      limit: 250_000,
      uncertain: 412,
      periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      now: NOW,
      timezone: TZ,
    });

    expect(usage.uncertain).toBe(412);
  });
});

describe('deltas and the bounce split', () => {
  it('reports movement in percentage points, to one decimal', () => {
    // 4.2% against 3.8% moved 0.4 points and 10.5 percent, and the arrow on
    // C1 means the first.
    expect(
      deltaPoints({ numerator: 42, denominator: 1000 }, { numerator: 38, denominator: 1000 }),
    ).toBe(0.4);
  });

  it('is null when either period delivered nothing', () => {
    // Treating an empty period as a zero rate reports a catastrophic drop in
    // the first month of every new workspace.
    expect(deltaPoints({ numerator: 42, denominator: 1000 }, { numerator: 0, denominator: 0 })).toBeNull();
    expect(deltaPoints({ numerator: 0, denominator: 0 }, { numerator: 38, denominator: 1000 })).toBeNull();
  });

  it('is null, not two zero bars, when nothing was sent', () => {
    expect(
      bounceSplitOf({ sent: 0, delivered: 0, bouncedSoft: 0, bouncedHard: 0, complained: 0 }),
    ).toBeNull();
  });

  it('divides both tones by sends, not by deliveries', () => {
    // A bounce is a send that did not arrive. Over deliveries it would
    // divide by the wrong thing and flatter the worst providers most.
    expect(
      bounceSplitOf({ sent: 1000, delivered: 960, bouncedSoft: 6, bouncedHard: 3, complained: 1 }),
    ).toEqual({ soft: 0.006, hard: 0.003 });
  });

  it('publishes the auto-pause threshold so the meter can draw its mark', () => {
    expect(COMPLAINT_THRESHOLD).toBe(0.003);
  });
});

// ------------------------------------------------------------------ campaigns

function campaign(over: Partial<DashboardCampaignRow> = {}): DashboardCampaignRow {
  return {
    campaignId: 'cmp-1',
    name: 'Autumn Escapes',
    status: 'sending',
    recipientCount: 48_213,
    scheduledAt: null,
    launchedAt: new Date('2026-09-19T05:00:00.000Z'),
    completedAt: null,
    pausedAt: null,
    updatedAt: NOW,
    counters: {
      total: 48_213,
      pending: 16_595,
      queued: 0,
      sending: 1_240,
      sent: 30_378,
      failed: 0,
      suppressed: 0,
      uncertain: 180,
    },
    stats: {
      delivered: 29_876,
      bouncedSoft: 214,
      bouncedHard: 96,
      complained: 12,
      clicksUniqueNonbot: 1_195,
    },
    ...over,
  };
}

describe('campaign rows', () => {
  it('emits only the segments that have something in them', () => {
    // A zero-width bar segment with a tooltip saying "0 hard bounces" is
    // noise on every healthy campaign.
    const counts = countsFor(campaign());

    expect(counts).toEqual({
      pending: 16_595,
      sending: 1_240,
      uncertain: 180,
      delivered: 29_876,
      soft: 214,
      hard: 96,
      complaint: 12,
    });
    expect('queued' in counts).toBe(false);
    expect('failed' in counts).toBe(false);
  });

  it('gives a draft no counts and no recipient number', () => {
    // Null rather than zero: "0 recipients" reads as an empty segment rather
    // than as "no audience chosen yet".
    const [row] = buildCampaigns(
      [campaign({ status: 'draft', counters: null, stats: null, recipientCount: 0, launchedAt: null })],
      NOW,
      TZ,
    );

    expect(row?.counts).toEqual({});
    expect(row?.recipients).toBeNull();
    expect(row?.clickRate).toBeNull();
  });

  it('has no click rate before anything is delivered', () => {
    const [row] = buildCampaigns(
      [campaign({ stats: { delivered: 0, bouncedSoft: 0, bouncedHard: 0, complained: 0, clicksUniqueNonbot: 0 } })],
      NOW,
      TZ,
    );

    expect(row?.clickRate).toBeNull();
  });

  it('says "today" for a campaign launched today in the workspace’s zone', () => {
    expect(whenFor(campaign(), NOW, TZ)).toContain('today');
  });

  it('names the timestamp that matches the state', () => {
    expect(
      whenFor(
        campaign({ status: 'paused', pausedAt: new Date('2026-09-16T07:12:00.000Z') }),
        NOW,
        TZ,
      ),
    ).toContain('Paused 16 Sep');

    expect(
      whenFor(
        campaign({
          status: 'scheduled',
          launchedAt: null,
          scheduledAt: new Date('2026-09-24T05:00:00.000Z'),
        }),
        NOW,
        TZ,
      ),
    ).toContain('Scheduled 24 Sep');
  });
});

// ------------------------------------------------------------------ providers

function connection(over: Partial<ProviderConnectionRow> = {}): ProviderConnectionRow {
  return {
    id: 'conn-1',
    workspaceId: 'ws-1',
    providerType: 'ses',
    name: 'production',
    status: 'active',
    credentialVersion: 1,
    config: { region: 'eu-west-1' },
    capabilities: {},
    hasWebhookSecret: true,
    quotaSnapshot: { max24Hour: 50_000 },
    quotaCheckedAt: NOW,
    lastVerifiedAt: NOW,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as unknown as ProviderConnectionRow;
}

describe('the provider strip', () => {
  it('names the product and labels the connection', () => {
    const [row] = buildProviders([connection()], new Map([['conn-1', 41_200]]));

    expect(row?.name).toBe('Amazon SES');
    expect(row?.code).toBe('SES');
    expect(row?.label).toBe('eu-west-1 · production');
    expect(row?.sentToday).toBe(41_200);
    expect(row?.dailyLimit).toBe(50_000);
  });

  it('reports no daily limit rather than zero when the provider reports none', () => {
    // SMTP reports no quota. A bar drawn against zero shows every
    // connection as completely full.
    const [row] = buildProviders(
      [connection({ providerType: 'smtp', quotaSnapshot: null, config: {} })],
      new Map(),
    );

    expect(row?.dailyLimit).toBeNull();
    expect(row?.sentToday).toBe(0);
  });

  it('never puts an unrecognised config key in the label', () => {
    // `config` is documented as non-secret by review and not by the
    // database, so a label built from every key is one bad write away from
    // putting a password on screen.
    const [row] = buildProviders(
      [connection({ config: { password: 'hunter2', region: 'eu-west-1' } })],
      new Map(),
    );

    expect(row?.label).not.toContain('hunter2');
  });

  it('maps connection status onto the three tones the strip draws', () => {
    expect(buildProviders([connection({ status: 'active' })], new Map())[0]?.health).toBe('healthy');
    expect(buildProviders([connection({ status: 'degraded' })], new Map())[0]?.health).toBe('degraded');
    expect(buildProviders([connection({ status: 'error' })], new Map())[0]?.health).toBe('failed');
  });
});

// ------------------------------------------------------------------ attention

const NO_ENFORCEMENT: EnforcementRow = {
  stage: 'none',
  reason: null,
  observedRate: null,
  observedSends: null,
  enteredAt: NOW,
  heldByOperator: false,
  note: null,
};

describe('needs attention', () => {
  it('is empty when nothing is wrong', () => {
    expect(
      buildAttention({
        connections: [connection()],
        campaigns: [campaign()],
        enforcement: NO_ENFORCEMENT,
        pastDue: false,
      }),
    ).toEqual([]);
  });

  it('puts a broken connection first, and links to the page that fixes it', () => {
    const items = buildAttention({
      connections: [
        connection({ status: 'error', lastError: { message: 'The API key was rejected' } }),
      ],
      campaigns: [campaign({ status: 'paused', pausedAt: NOW })],
      enforcement: NO_ENFORCEMENT,
      pastDue: false,
    });

    expect(items[0]?.tone).toBe('danger');
    expect(items[0]?.detail).toBe('The API key was rejected');
    expect(items[0]?.action?.href).toBe('/providers/conn-1');
  });

  it('says how many recipients a paused campaign has left', () => {
    const items = buildAttention({
      connections: [],
      campaigns: [campaign({ status: 'paused', pausedAt: NOW })],
      enforcement: NO_ENFORCEMENT,
      pastDue: false,
    });

    expect(items[0]?.detail).toContain('16,595');
  });

  it('points a held campaign at the payment method, not at the campaign', () => {
    // The campaign is not the thing that is broken.
    const items = buildAttention({
      connections: [],
      campaigns: [campaign({ status: 'held' })],
      enforcement: NO_ENFORCEMENT,
      pastDue: false,
    });

    expect(items[0]?.action?.href).toBe('/billing/payment-method');
  });

  it('reports the enforcement stage with the observed rate against the threshold', () => {
    const items = buildAttention({
      connections: [],
      campaigns: [],
      enforcement: { ...NO_ENFORCEMENT, stage: 'paused', observedRate: 0.0034 },
      pastDue: false,
    });

    expect(items[0]?.tone).toBe('danger');
    expect(items[0]?.detail).toContain('0.34%');
    expect(items[0]?.detail).toContain('0.3%');
  });
});
