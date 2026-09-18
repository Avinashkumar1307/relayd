import { describe, expect, it } from 'vitest';
import { HOURLY_WINDOW_MS } from '../src/rollup/rollup.js';
import {
  backfillWindowFor,
  dayBucket,
  daysInWindow,
  willBeCounted,
} from '../src/rollup/buckets.js';

/**
 * Day buckets and late arrivals (BUILD-PLAN Phase 7 tests).
 *
 * Three of the four concerns that item lists — timezone buckets, late
 * arrivals, partition boundaries — are decisions about time that can be
 * settled without a database. The fourth, reconciling a rollup against ten
 * million raw events within 0.1%, cannot, and is tracked as
 * infrastructure-blocked.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');

describe('which day an event belongs to', () => {
  it('is its UTC day', () => {
    expect(dayBucket(new Date('2026-09-18T12:00:00.000Z'))).toBe('2026-09-18');
  });

  it('is the UTC day even for a timestamp late in another timezone', () => {
    // 11pm on the 18th in UTC+13 is 10am on the 18th in UTC. Storing a local
    // day means every row is wrong the moment a workspace changes timezone,
    // and the original offset was never stored, so it cannot be fixed after.
    expect(dayBucket(new Date('2026-09-18T10:00:00.000Z'))).toBe('2026-09-18');
  });

  it('rolls over at UTC midnight, not local midnight', () => {
    expect(dayBucket(new Date('2026-09-18T23:59:59.999Z'))).toBe('2026-09-18');
    expect(dayBucket(new Date('2026-09-19T00:00:00.000Z'))).toBe('2026-09-19');
  });

  it('is stable across a daylight-saving boundary', () => {
    // The UK moved its clocks on 25 October 2026. UTC did not.
    expect(dayBucket(new Date('2026-10-25T00:30:00.000Z'))).toBe('2026-10-25');
    expect(dayBucket(new Date('2026-10-25T01:30:00.000Z'))).toBe('2026-10-25');
  });

  it('crosses a month boundary correctly', () => {
    expect(dayBucket(new Date('2026-09-30T23:59:59.999Z'))).toBe('2026-09-30');
    expect(dayBucket(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
  });

  it('crosses a year boundary correctly', () => {
    expect(dayBucket(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31');
    expect(dayBucket(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(dayBucket(new Date('2028-02-29T12:00:00.000Z'))).toBe('2028-02-29');
  });
});

describe('an event that arrives late', () => {
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

  it('is counted inside the window', () => {
    // Routine: a provider batching callbacks, a webhook retried after an
    // outage, a bounce that took six hours to come back.
    expect(
      willBeCounted({ occurredAt: hoursAgo(6), now: NOW, windowMs: HOURLY_WINDOW_MS }),
    ).toBe(true);
  });

  it('is counted at the very edge of it', () => {
    expect(
      willBeCounted({ occurredAt: hoursAgo(26), now: NOW, windowMs: HOURLY_WINDOW_MS }),
    ).toBe(true);
  });

  it('is missed outside it', () => {
    // The one gap this design accepts, and the reason the window is 26 hours
    // rather than 24.
    expect(
      willBeCounted({ occurredAt: hoursAgo(27), now: NOW, windowMs: HOURLY_WINDOW_MS }),
    ).toBe(false);
  });

  it('is counted when its timestamp is in the future', () => {
    // Clock skew between a provider and us is common, and refusing these
    // would silently drop real deliveries.
    expect(
      willBeCounted({
        occurredAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
        windowMs: HOURLY_WINDOW_MS,
      }),
    ).toBe(true);
  });

  it('survives a run that was two hours late', () => {
    // The overlap is what buys this. With a 24-hour window an event from 25
    // hours ago falls between two runs and is never counted.
    const twentyFive = hoursAgo(25);

    expect(willBeCounted({ occurredAt: twentyFive, now: NOW, windowMs: HOURLY_WINDOW_MS })).toBe(true);
    expect(willBeCounted({ occurredAt: twentyFive, now: NOW, windowMs: 24 * 3_600_000 })).toBe(false);
  });
});

describe('sizing a backfill', () => {
  it('reaches the oldest event', () => {
    const window = backfillWindowFor({
      oldestEvent: new Date(NOW.getTime() - 50 * 3_600_000),
      now: NOW,
    });

    expect(window).toBeGreaterThanOrEqual(50 * 3_600_000);
  });

  it('rounds up to a whole hour', () => {
    // The job is configured in hours, and an operator told "26.4" types 26.
    const window = backfillWindowFor({
      oldestEvent: new Date(NOW.getTime() - (26 * 3_600_000 + 60_000)),
      now: NOW,
    });

    expect(window).toBe(27 * 3_600_000);
  });

  it('is zero for an event that has not happened yet', () => {
    expect(
      backfillWindowFor({ oldestEvent: new Date(NOW.getTime() + 1000), now: NOW }),
    ).toBe(0);
  });
});

describe('which days a window touches', () => {
  it('covers a window inside one day', () => {
    expect(
      daysInWindow({
        since: new Date('2026-09-18T01:00:00.000Z'),
        until: new Date('2026-09-18T23:00:00.000Z'),
      }),
    ).toEqual(['2026-09-18']);
  });

  it('covers both days when it crosses midnight', () => {
    expect(
      daysInWindow({
        since: new Date('2026-09-17T23:00:00.000Z'),
        until: new Date('2026-09-18T01:00:00.000Z'),
      }),
    ).toEqual(['2026-09-17', '2026-09-18']);
  });

  it('covers the middle day of a 26-hour window', () => {
    // The case that matters. A window starting at 23:00 and running 26 hours
    // touches three days, and a rollup that wrote only the endpoints would
    // leave the middle one stale indefinitely.
    const since = new Date('2026-09-16T23:00:00.000Z');

    expect(
      daysInWindow({ since, until: new Date(since.getTime() + HOURLY_WINDOW_MS) }),
    ).toEqual(['2026-09-16', '2026-09-17', '2026-09-18']);
  });

  it('crosses a month boundary', () => {
    expect(
      daysInWindow({
        since: new Date('2026-09-30T20:00:00.000Z'),
        until: new Date('2026-10-01T04:00:00.000Z'),
      }),
    ).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('crosses a year boundary', () => {
    expect(
      daysInWindow({
        since: new Date('2026-12-31T20:00:00.000Z'),
        until: new Date('2027-01-01T04:00:00.000Z'),
      }),
    ).toEqual(['2026-12-31', '2027-01-01']);
  });

  it('returns nothing for a backwards window spanning days', () => {
    expect(
      daysInWindow({
        since: new Date('2026-09-18T00:00:00.000Z'),
        until: new Date('2026-09-17T00:00:00.000Z'),
      }),
    ).toEqual([]);
  });

  it('returns nothing for a backwards window inside one day', () => {
    // The case the explicit guard is actually for. Across days the midnight
    // truncation already puts the cursor past the end; within a day it does
    // not, and without the guard this reports a day that the caller asked
    // for backwards — which reads as a successful rollup of a window that
    // was never coherent.
    expect(
      daysInWindow({
        since: new Date('2026-09-18T23:00:00.000Z'),
        until: new Date('2026-09-18T01:00:00.000Z'),
      }),
    ).toEqual([]);
  });

  it('is bounded, so a years-wide backfill cannot build a list nobody wants', () => {
    const days = daysInWindow({
      since: new Date('2020-01-01T00:00:00.000Z'),
      until: new Date('2026-09-18T00:00:00.000Z'),
    });

    expect(days.length).toBeLessThanOrEqual(400);
  });

  it('includes both endpoints', () => {
    const days = daysInWindow({
      since: new Date('2026-09-16T00:00:00.000Z'),
      until: new Date('2026-09-18T00:00:00.000Z'),
    });

    expect(days.at(0)).toBe('2026-09-16');
    expect(days.at(-1)).toBe('2026-09-18');
  });
});
