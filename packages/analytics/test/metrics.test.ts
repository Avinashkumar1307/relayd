import { describe, expect, it } from 'vitest';
import {
  HEADLINE_RATE,
  RATE_DEFINITIONS,
  RECENCY_FLOOR,
  RECENCY_FULL_DAYS,
  RECENCY_ZERO_DAYS,
  engagementScore,
  rate,
  recencyFactor,
} from '../src/rollup/metrics.js';

/**
 * Metric definitions (docs/06 §13; BUILD-PLAN's "every rate response includes
 * botFiltered").
 *
 * These are product decisions with engineering consequences. Getting them
 * wrong means a customer makes a business decision on a number that is wrong
 * by 30-60% and has no way to know.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describe('which number leads', () => {
  it('is the click rate', () => {
    // A click is a person following a link. An open is an image being
    // fetched, which a proxy does for everyone whether they read it or not.
    expect(HEADLINE_RATE).toBe('click');
  });

  it('marks the click rate reliable', () => {
    expect(RATE_DEFINITIONS.click.confidence).toBe('reliable');
  });

  it('marks the open rate directional, with a reason attached', () => {
    // The caveat travels with the number rather than living in a tooltip
    // somewhere, so an API consumer sees it too.
    expect(RATE_DEFINITIONS.open.confidence).toBe('directional');
    expect(RATE_DEFINITIONS.open.caveat).toMatch(/inflates|directional/u);
  });

  it('measures clicks against delivered, not against sent', () => {
    // Against `sent`, a campaign with a bad list looks like a campaign with
    // bad content — and the fix for those two is not the same.
    expect(RATE_DEFINITIONS.click.denominator).toBe('delivered');
  });

  it('measures bounces against sent, because that is the population that could bounce', () => {
    expect(RATE_DEFINITIONS.bounce.denominator).toBe('sent');
  });

  it('uses the bot-filtered numerator for engagement rates', () => {
    expect(RATE_DEFINITIONS.click.numerator).toBe('clicks_unique_nonbot');
    expect(RATE_DEFINITIONS.open.numerator).toBe('opens_unique_nonbot');
  });
});

describe('computing a rate', () => {
  it('divides', () => {
    expect(rate({ kind: 'click', numerator: 175, denominator: 700 }).value).toBe(0.25);
  });

  it('answers null rather than zero when nothing has been delivered', () => {
    // 0% says the campaign performed badly. Null says it has not been
    // measured, which is the truth and reads differently in every chart.
    expect(rate({ kind: 'click', numerator: 0, denominator: 0 }).value).toBeNull();
  });

  it('never returns NaN or Infinity', () => {
    for (const denominator of [0, -1, Number.NaN]) {
      const value = rate({ kind: 'open', numerator: 5, denominator }).value;
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });

  it('carries botFiltered on every rate', () => {
    // BUILD-PLAN requires it. A filtered number without the size of the
    // filter is a number the customer cannot check — and "my open rate
    // dropped when I moved to you" is answered by showing them what we
    // removed, not by arguing.
    for (const kind of Object.keys(RATE_DEFINITIONS) as (keyof typeof RATE_DEFINITIONS)[]) {
      const result = rate({ kind, numerator: 1, denominator: 2, botFiltered: 7 });
      expect(result.botFiltered, kind).toBe(7);
    }
  });

  it('defaults botFiltered to zero rather than leaving it absent', () => {
    expect(rate({ kind: 'click', numerator: 1, denominator: 2 }).botFiltered).toBe(0);
  });

  it('attaches the caveat to a directional rate and not to a reliable one', () => {
    expect(rate({ kind: 'open', numerator: 1, denominator: 2 }).caveat).toBeTruthy();
    expect(rate({ kind: 'click', numerator: 1, denominator: 2 }).caveat).toBeUndefined();
  });

  it('refuses to report a negative count', () => {
    const result = rate({ kind: 'click', numerator: -5, denominator: -3, botFiltered: -1 });

    expect(result.numerator).toBe(0);
    expect(result.denominator).toBe(0);
    expect(result.botFiltered).toBe(0);
  });
});

describe('the engagement score', () => {
  it('is zero for a contact who has received nothing', () => {
    expect(
      engagementScore({
        campaignsReceived: 0,
        opens: 0,
        clicks: 0,
        lastClickedAt: null,
        lastOpenedAt: null,
        now: NOW,
      }),
    ).toBe(0);
  });

  it('is zero for a contact who has never engaged', () => {
    expect(
      engagementScore({
        campaignsReceived: 10,
        opens: 0,
        clicks: 0,
        lastClickedAt: null,
        lastOpenedAt: null,
        now: NOW,
      }),
    ).toBe(0);
  });

  it('weighs a click far above an open', () => {
    // An open may be a proxy; a click is a person. A score that treated them
    // equally would put Apple's image fetcher at the top of every segment.
    const clicker = engagementScore({
      campaignsReceived: 10,
      opens: 0,
      clicks: 10,
      lastClickedAt: NOW,
      lastOpenedAt: null,
      now: NOW,
    });

    const opener = engagementScore({
      campaignsReceived: 10,
      opens: 10,
      clicks: 0,
      lastClickedAt: null,
      lastOpenedAt: NOW,
      now: NOW,
    });

    expect(clicker).toBeGreaterThan(opener);
    expect(clicker).toBe(70);
    expect(opener).toBe(30);
  });

  it('caps at 100 for a contact who opens and clicks everything', () => {
    expect(
      engagementScore({
        campaignsReceived: 10,
        opens: 10,
        clicks: 10,
        lastClickedAt: NOW,
        lastOpenedAt: NOW,
        now: NOW,
      }),
    ).toBe(100);
  });

  it('does not exceed 100 when someone clicks more than they received', () => {
    // Multiple clicks per campaign are normal; a score above 100 is not.
    expect(
      engagementScore({
        campaignsReceived: 2,
        opens: 40,
        clicks: 30,
        lastClickedAt: NOW,
        lastOpenedAt: NOW,
        now: NOW,
      }),
    ).toBe(100);
  });

  it('decays for a contact who has not engaged recently', () => {
    const recent = engagementScore({
      campaignsReceived: 10, opens: 10, clicks: 10,
      lastClickedAt: daysAgo(10), lastOpenedAt: daysAgo(10), now: NOW,
    });

    const stale = engagementScore({
      campaignsReceived: 10, opens: 10, clicks: 10,
      lastClickedAt: daysAgo(300), lastOpenedAt: daysAgo(300), now: NOW,
    });

    expect(stale).toBeLessThan(recent);
  });

  it('uses whichever engagement was more recent', () => {
    // A contact who clicked a year ago but opened yesterday is engaged.
    const score = engagementScore({
      campaignsReceived: 10, opens: 10, clicks: 10,
      lastClickedAt: daysAgo(400), lastOpenedAt: daysAgo(1), now: NOW,
    });

    expect(score).toBe(100);
  });

  it('is a whole number', () => {
    const score = engagementScore({
      campaignsReceived: 7, opens: 3, clicks: 2,
      lastClickedAt: daysAgo(200), lastOpenedAt: null, now: NOW,
    });

    expect(Number.isInteger(score)).toBe(true);
  });
});

describe('recency', () => {
  it('counts fully inside the window', () => {
    expect(recencyFactor(daysAgo(1), NOW)).toBe(1);
    expect(recencyFactor(daysAgo(RECENCY_FULL_DAYS), NOW)).toBe(1);
  });

  it('decays after it', () => {
    const factor = recencyFactor(daysAgo(200), NOW);
    expect(factor).toBeLessThan(1);
    expect(factor).toBeGreaterThan(RECENCY_FLOOR);
  });

  it('settles on a floor rather than reaching zero', () => {
    // A contact who clicked once a year ago is still meaningfully different
    // from one who has never clicked, and zero would merge them.
    expect(recencyFactor(daysAgo(RECENCY_ZERO_DAYS), NOW)).toBe(RECENCY_FLOOR);
    expect(recencyFactor(daysAgo(10_000), NOW)).toBe(RECENCY_FLOOR);
    expect(RECENCY_FLOOR).toBeGreaterThan(0);
  });

  it('is zero only for a contact who has never engaged', () => {
    expect(recencyFactor(null, NOW)).toBe(0);
  });

  it('decreases monotonically', () => {
    let previous = 1;
    for (const days of [0, 50, 90, 120, 200, 300, 365, 500]) {
      const factor = recencyFactor(daysAgo(days), NOW);
      expect(factor, String(days)).toBeLessThanOrEqual(previous);
      previous = factor;
    }
  });

  it('treats a future timestamp as current rather than as an error', () => {
    // Clock skew between the app and the database is routine, and a negative
    // age should not produce a factor above 1.
    expect(recencyFactor(new Date(NOW.getTime() + 60_000), NOW)).toBe(1);
  });
});
