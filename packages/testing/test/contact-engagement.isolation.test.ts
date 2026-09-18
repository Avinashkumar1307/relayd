import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R26: nothing writes `contact_engagement` outside the rollup.
 *
 * F26's trace: updating it on every event puts the heaviest write contention
 * on exactly the contacts that are mailed most — the rows that are already
 * updated most often. It is a reporting artefact. It does not need to be
 * current to the second, and nothing in a send path reads it.
 *
 * The tempting change is a single `UPDATE contact_engagement SET opens =
 * opens + 1` in the event consumer, which looks harmless in review and only
 * shows up as lock contention at a scale nobody develops against. This is the
 * test that refuses it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The one directory allowed to write it. */
const ALLOWED = 'packages/analytics/src/rollup';

const SEARCHED = [
  'apps/api/src',
  'apps/edge/src',
  'apps/worker/src',
  'apps/scheduler/src',
  'packages/campaigns/src',
  'packages/db/src/repositories',
  'packages/analytics/src',
];

/** A write, as opposed to a read or a type reference. */
const WRITE_PATTERNS: readonly RegExp[] = [
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+contact_engagement\b/iu,
  /\.(?:insert|update|delete)\s*\(\s*contactEngagement\b/u,
];

async function sourceFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, dir), { withFileTypes: true, recursive: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

describe('contact_engagement is written only by the rollup (R26)', () => {
  it('scanned something, so this test is not vacuous', async () => {
    for (const dir of SEARCHED) {
      expect((await sourceFiles(dir)).length, dir).toBeGreaterThan(0);
    }
  });

  it('finds no write outside packages/analytics/src/rollup', async () => {
    const offenders: string[] = [];

    for (const dir of SEARCHED) {
      for (const file of await sourceFiles(dir)) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        if (relative.startsWith(ALLOWED)) continue;

        const source = await readFile(file, 'utf8');

        for (const [index, line] of source.split('\n').entries()) {
          // A comment explaining the rule is not a violation of it.
          if (/^\s*(\/\/|\*|\/\*|--)/u.test(line)) continue;

          if (WRITE_PATTERNS.some((pattern) => pattern.test(line))) {
            offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
          }
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('confirms the rollup does write it', async () => {
    // The positive half: R26 is not satisfied by nothing writing it at all.
    const source = await readFile(
      path.join(root, 'packages/analytics/src/rollup/rollup.ts'),
      'utf8',
    );

    expect(source).toContain('writeContactEngagement');
  });

  it('confirms the allowed directory exists', async () => {
    // Otherwise a rename turns the exemption into a path that excludes
    // nothing and the test keeps passing for the wrong reason.
    expect((await sourceFiles(ALLOWED)).length).toBeGreaterThan(0);
  });
});
