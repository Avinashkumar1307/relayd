import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONSENT_SOURCES } from '@relayd/campaigns';
import { CONSENT_SOURCE_VALUES } from '@relayd/validation';

/**
 * The consent vocabulary, in all three places it is written down.
 *
 * It appears three times on purpose:
 *
 *   `packages/campaigns` has the policy copy, used by the launch engine.
 *   `packages/validation` has a copy, because that package is bundled into
 *   the browser and importing the campaigns package to reach one array would
 *   drag the whole send engine into the SPA.
 *   Migration 0016 has a CHECK constraint, because a value the database will
 *   not store is not a value however many TypeScript files agree on it.
 *
 * Nothing in either language compares them. A source added to two of the
 * three fails at runtime, in production, as a constraint violation on a
 * launch — which is the worst place to find out, because the person hitting
 * it is mid-send and the message says nothing about vocabularies.
 *
 * So this compares all three.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = path.resolve(
  here,
  '../../../packages/db/migrations/0016_consent_attestations.sql',
);

/** The values inside the `source` CHECK in migration 0016. */
async function migrationSources(): Promise<string[]> {
  const sql = await readFile(migration, 'utf8');

  // The CHECK is written as `source text NOT NULL CHECK (source IN ( ... ))`.
  const block = /source\s+text\s+NOT NULL CHECK \(source IN \(([\s\S]*?)\)\)/u.exec(sql)?.[1];
  if (block === undefined) throw new Error('could not find the source CHECK in 0016');

  return [...block.matchAll(/'([^']+)'/gu)].map((match) => match[1] as string).sort();
}

describe('the consent vocabulary agrees everywhere', () => {
  it('finds the constraint to compare against', async () => {
    // The tripwire. A regex that stopped matching would make the comparisons
    // below compare two lists against an empty one and throw — but only if
    // it throws, so this asserts the parse produced something first.
    const sources = await migrationSources();

    expect(sources.length).toBeGreaterThanOrEqual(6);
  });

  it('matches between the policy and the validation schema', () => {
    expect([...CONSENT_SOURCE_VALUES].sort()).toEqual([...CONSENT_SOURCES].sort());
  });

  it('matches between the policy and the database constraint', async () => {
    expect(await migrationSources()).toEqual([...CONSENT_SOURCES].sort());
  });

  it('includes an escape hatch that has to be explained', () => {
    // `other` exists because the five named sources will not cover
    // everything, and a vocabulary with no escape hatch gets one anyway —
    // people pick the closest wrong answer, which is worse than an honest
    // "other" with a description attached.
    expect(CONSENT_SOURCES).toContain('other');
  });
});
