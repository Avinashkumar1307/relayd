import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R13: no `COUNT(*)` over `campaign_recipients` in any request path.
 *
 * The trace F13 describes: three team members watch a 500,000-recipient
 * campaign, each polling progress every five seconds. As a `GROUP BY` over
 * `campaign_recipients` that is a sequential scan over a partition every 1.7
 * seconds, competing with the dispatcher's own writes on the same table.
 *
 * `campaign_counters` exists so that question costs one row. This test is
 * what stops somebody answering it the obvious way instead — which will look
 * correct, pass every other test, and only fail in production at a scale
 * nobody develops against.
 *
 * Scope: `apps/api` and `apps/edge`, the two processes that serve requests.
 * A worker or a reconciler may aggregate; it runs once, not continuously, and
 * `packages/db` is allowed one such statement for the retry-failed summary
 * that a human explicitly asks for.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const REQUEST_PATHS = ['apps/api/src', 'apps/edge/src'];

/** `count(` applied to the recipients table, however it is spelled. */
const COUNT_PATTERNS: readonly RegExp[] = [
  /count\s*\(/iu,
  /\bsum\s*\(/iu,
  /\bgroup\s+by\b/iu,
];

async function sourceFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true, recursive: true });
  } catch {
    // A missing directory returns nothing rather than throwing, so the
    // "scanned something" assertion below reports it as the empty scan it is
    // instead of crashing the runner — which reads as infrastructure trouble
    // rather than as this test doing its job.
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('no aggregate over campaign_recipients in a request path (R13)', () => {
  it('finds no count, sum or group by near the recipients table', async () => {
    const offenders: string[] = [];

    for (const dir of REQUEST_PATHS) {
      for (const file of await sourceFiles(dir)) {
        const source = await readFile(file, 'utf8');

        // Only statements that mention the table at all can be the problem.
        if (!/campaign_recipients/iu.test(source)) continue;

        for (const [index, line] of source.split('\n').entries()) {
          if (!COUNT_PATTERNS.some((pattern) => pattern.test(line))) continue;

          // A comment explaining why there is no count is not a count.
          if (/^\s*(\/\/|\*|\/\*)/u.test(line)) continue;

          offenders.push(`${path.relative(root, file)}:${index + 1}  ${line.trim()}`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('confirms the request paths it scanned actually exist', async () => {
    // A test that silently scans nothing passes forever. This is the guard on
    // the guard: if a directory is renamed, this fails rather than the file
    // quietly becoming decorative.
    for (const dir of REQUEST_PATHS) {
      const files = await sourceFiles(dir);
      expect(files.length, dir).toBeGreaterThan(0);
    }
  });

  it('confirms the campaign service reads counters', async () => {
    // The positive half: R13 is not satisfied by having no code at all.
    const source = await readFile(
      path.join(root, 'apps/api/src/services/campaigns.ts'),
      'utf8',
    );

    expect(source).toContain('readCounters');
  });
});
