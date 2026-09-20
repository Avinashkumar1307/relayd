/**
 * The demo's fixed clock.
 *
 * DEMO ONLY. Every fixture dates itself relative to one frozen instant so a
 * screenshot taken today looks like a screenshot taken next month, and so
 * two sections' fixtures agree about what "3 days ago" means. Split out of
 * `fixtures.ts` when that file became one file per section: this is the
 * only thing all of them share.
 */

const now = new Date('2026-09-19T12:00:00.000Z');

/** Days before the frozen instant, as an ISO string. Negative is the future. */
export const iso = (daysAgo: number): string =>
  new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
