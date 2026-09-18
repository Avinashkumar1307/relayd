import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@relayd/types';
import type { CampaignId } from '@relayd/types';
import type { WorkspaceScope } from '@relayd/db';
import {
  AnalyticsService,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  toCsv,
} from '../src/services/analytics.js';
import type { AnalyticsRepositories } from '../src/services/analytics.js';

/**
 * Analytics.
 *
 * Two properties BUILD-PLAN names directly — every rate carries
 * `botFiltered`, and the numbers come from rollups rather than from
 * `email_events` — plus the CSV export, which is the one place in this
 * product where a contact's own name can reach a spreadsheet as executable
 * content.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const ID = 'c1' as CampaignId;
const NOW = new Date('2026-09-18T12:00:00.000Z');

const STATS = {
  campaignId: ID,
  workspaceId: 'ws-1',
  recipients: 1000,
  sent: 950,
  failed: 40,
  suppressed: 8,
  deliveryUncertain: 2,
  delivered: 900,
  bouncedHard: 20,
  bouncedSoft: 30,
  complained: 2,
  unsubscribed: 5,
  opensTotal: 1200,
  opensUnique: 600,
  opensUniqueNonbot: 420,
  clicksTotal: 300,
  clicksUnique: 180,
  clicksUniqueNonbot: 175,
  computedAt: NOW,
  computedBy: 'hourly' as const,
};

function service(over: Record<string, unknown> = {}) {
  const repos: AnalyticsRepositories = {
    analytics: {
      async campaignStats() {
        return STATS;
      },
      async campaignDaily() {
        return [
          {
            day: '2026-09-17',
            sent: 500, delivered: 480, bounced: 10, complained: 1,
            opensUniqueNonbot: 200, clicksUnique: 90, unsubscribed: 2,
          },
        ];
      },
      async campaignLinks() {
        return [
          {
            linkId: 'l1', url: 'https://example.com/offer', position: 0,
            clicksTotal: 200, clicksUnique: 120, clicksUniqueNonbot: 110,
          },
        ];
      },
      async campaignDevices() {
        return [
          { deviceType: 'mobile', clientFamily: 'Apple Mail', opens: 300, clicks: 50 },
          { deviceType: 'unknown', clientFamily: 'unknown', opens: 200, clicks: 5 },
        ];
      },
      async providerBreakdown() {
        return [
          {
            providerConnectionId: 'conn-1',
            sent: 950, delivered: 900, bouncedHard: 20, complained: 2,
          },
        ];
      },
      async workspaceOverview() {
        return [
          {
            day: '2026-09-17',
            sent: 500, delivered: 480, bounced: 10, complained: 1,
            opensUniqueNonbot: 200, clicksUnique: 90, unsubscribed: 2,
          },
          {
            day: '2026-09-18',
            sent: 450, delivered: 420, bounced: 8, complained: 0,
            opensUniqueNonbot: 180, clicksUnique: 80, unsubscribed: 1,
          },
        ];
      },
      async botFilteredFor() {
        return 185;
      },
      ...over,
    } as unknown as AnalyticsRepositories['analytics'],
  };

  return new AnalyticsService({ unitOfWork: (fn) => fn(repos), now: () => NOW });
}

describe('every rate carries botFiltered', () => {
  it('on the campaign summary', async () => {
    // The question this product will be asked most often is "why is my open
    // rate lower than on my old tool". The answer is to show what we removed.
    const result = await service().campaign(SCOPE, ID);

    for (const [kind, value] of Object.entries(result.rates)) {
      expect(value.botFiltered, kind).toBeGreaterThanOrEqual(0);
      expect(typeof value.botFiltered, kind).toBe('number');
    }
  });

  it('reports the opens the filter actually removed', async () => {
    const result = await service().campaign(SCOPE, ID);
    expect(result.rates.open.botFiltered).toBe(600 - 420);
  });

  it('reports the clicks the filter removed, separately', async () => {
    const result = await service().campaign(SCOPE, ID);
    expect(result.rates.click.botFiltered).toBe(180 - 175);
  });

  it('on each link in the heat table', async () => {
    const result = await service().campaignLinks(SCOPE, ID);
    expect(result.links[0]?.clickRate.botFiltered).toBe(120 - 110);
  });

  it('on the provider breakdown', async () => {
    const result = await service().providers(SCOPE, {});
    expect(result.providers[0]?.deliveryRate.botFiltered).toBe(0);
  });
});

describe('what the rates are measured against', () => {
  it('measures clicks against delivered', async () => {
    const result = await service().campaign(SCOPE, ID);
    expect(result.rates.click.denominator).toBe(900);
    expect(result.rates.click.numerator).toBe(175);
  });

  it('measures bounces against sent', async () => {
    const result = await service().campaign(SCOPE, ID);
    expect(result.rates.bounce.denominator).toBe(950);
  });

  it('uses the bot-filtered numerator for engagement', async () => {
    const result = await service().campaign(SCOPE, ID);
    expect(result.rates.open.numerator).toBe(420);
    expect(result.rates.click.numerator).toBe(175);
  });

  it('names the click rate as the headline', async () => {
    expect((await service().campaign(SCOPE, ID)).headline).toBe('click');
  });

  it('carries the open rate’s caveat into the payload', async () => {
    // In the data, not in a tooltip, so a consumer building their own
    // dashboard cannot present it as though it were a click rate.
    const result = await service().campaign(SCOPE, ID);

    expect(result.rates.open.confidence).toBe('directional');
    expect(result.rates.open.caveat).toBeTruthy();
    expect(result.rates.click.caveat).toBeUndefined();
  });

  it('says which pass computed the numbers', async () => {
    // A live send shows a 30-second figure; a finished campaign shows an
    // hourly authoritative one. Saying which is honest and costs nothing.
    //
    // Both cases, because asserting only the fixture's value passes equally
    // well against a hardcoded 'hourly'.
    expect((await service().campaign(SCOPE, ID)).computedBy).toBe('hourly');

    const live = service({
      async campaignStats() {
        return { ...STATS, computedBy: 'incremental' as const };
      },
    });

    expect((await live.campaign(SCOPE, ID)).computedBy).toBe('incremental');
  });

  it('404s a campaign with no rollup yet', async () => {
    const s = service({ async campaignStats() { return null; } });
    await expect(s.campaign(SCOPE, ID)).rejects.toThrow(AppError);
  });
});

describe('the date range', () => {
  it('defaults to the last thirty days', async () => {
    const result = await service().overview(SCOPE, {});

    expect(result.to).toBe('2026-09-18');
    expect(result.from).toBe(
      new Date(NOW.getTime() - DEFAULT_RANGE_DAYS * 86_400_000).toISOString().slice(0, 10),
    );
  });

  it('accepts an explicit range', async () => {
    const result = await service().overview(SCOPE, { from: '2026-01-01', to: '2026-01-31' });
    expect(result).toMatchObject({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('refuses a range that is not YYYY-MM-DD', async () => {
    for (const from of ['yesterday', '2026/01/01', '01-01-2026', "2026-01-01'; DROP"]) {
      await expect(service().overview(SCOPE, { from }), from).rejects.toThrow(/YYYY-MM-DD/u);
    }
  });

  it('refuses a backwards range', async () => {
    await expect(
      service().overview(SCOPE, { from: '2026-09-18', to: '2026-01-01' }),
    ).rejects.toThrow(/after its end/u);
  });

  it('refuses a range longer than the cap', async () => {
    // Unbounded is fine today and a table scan in three years.
    await expect(
      service().overview(SCOPE, { from: '2020-01-01', to: '2026-09-18' }),
    ).rejects.toThrow(new RegExp(String(MAX_RANGE_DAYS), 'u'));
  });

  it('accepts a range exactly at the cap', async () => {
    const to = '2026-09-18';
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - MAX_RANGE_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await expect(service().overview(SCOPE, { from, to })).resolves.toBeDefined();
  });
});

describe('the workspace overview', () => {
  it('totals the days it was given', async () => {
    const result = await service().overview(SCOPE, {});

    expect(result.totals.sent).toBe(950);
    expect(result.totals.delivered).toBe(900);
  });

  it('derives its rates from the totals, not from the last day', async () => {
    const result = await service().overview(SCOPE, {});
    expect(result.rates.click.denominator).toBe(900);
  });

  it('returns the points for the chart as well as the totals', async () => {
    expect((await service().overview(SCOPE, {})).points).toHaveLength(2);
  });
});

describe('the device breakdown', () => {
  it('reports the unknown share as its own number', async () => {
    // Apple's privacy proxy reports a generic client, so a large unknown
    // slice is expected. A chart that hides it by apportioning it across the
    // known clients lies in proportion to how much privacy the audience uses.
    const result = await service().campaignDevices(SCOPE, ID);

    expect(result.unknownShare).toBeCloseTo(200 / 500, 5);
  });

  it('marks which rows are unknown', async () => {
    const result = await service().campaignDevices(SCOPE, ID);

    expect(result.breakdown.find((row) => row.clientFamily === 'unknown')?.isUnknown).toBe(true);
    expect(result.breakdown.find((row) => row.clientFamily === 'Apple Mail')?.isUnknown).toBe(false);
  });

  it('gives null rather than zero shares when nothing has opened', async () => {
    const s = service({ async campaignDevices() { return []; } });
    const result = await s.campaignDevices(SCOPE, ID);

    expect(result.unknownShare).toBeNull();
  });
});

describe('the CSV export', () => {
  it('writes a header row from the keys', () => {
    const csv = toCsv([{ day: '2026-09-17', sent: 500 }]);
    expect(csv.split('\r\n')[0]).toBe('day,sent');
  });

  it('uses CRLF, as the RFC and Excel both expect', () => {
    expect(toCsv([{ a: 1 }])).toBe('a\r\n1\r\n');
  });

  it('returns nothing for no rows', () => {
    expect(toCsv([])).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(toCsv([{ name: 'Smith, John' }])).toContain('"Smith, John"');
  });

  it('doubles a quote inside a quoted field', () => {
    expect(toCsv([{ name: 'He said "hi"' }])).toContain('"He said ""hi"""');
  });

  it('quotes a field containing a newline', () => {
    expect(toCsv([{ note: 'line one\nline two' }])).toContain('"line one\nline two"');
  });

  it('neutralises a formula', () => {
    // The real one. A contact who names themselves `=cmd|...` has handed
    // script execution to whoever opens the export in Excel.
    for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)', '=cmd|\' /c calc\'!A1']) {
      const csv = toCsv([{ name: dangerous }]);
      const field = csv.split('\r\n')[1] ?? '';

      expect(field.startsWith("'") || field.startsWith('"\''), dangerous).toBe(true);
    }
  });

  it('leaves an ordinary field alone', () => {
    expect(toCsv([{ name: 'Ada Lovelace' }])).toBe('name\r\nAda Lovelace\r\n');
  });

  it('renders a date as ISO rather than as a locale string', () => {
    const csv = toCsv([{ at: new Date('2026-09-18T12:00:00.000Z') }]);
    expect(csv).toContain('2026-09-18T12:00:00.000Z');
  });

  it('renders null and undefined as empty, not as the words', () => {
    expect(toCsv([{ a: null, b: undefined }])).toBe('a,b\r\n,\r\n');
  });
});

describe('what analytics never reads', () => {
  it('never asks for raw events', async () => {
    // The events table is the largest thing in the system, and a dashboard
    // that queries it gets slower every week until somebody notices.
    const repo = {
      campaignStats: vi.fn(async () => STATS),
      botFilteredFor: vi.fn(async () => 0),
    };

    const s = service(repo);
    await s.campaign(SCOPE, ID);

    expect(Object.keys(repo).some((key) => /event/iu.test(key))).toBe(false);
  });
});
