import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const edgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * CLAUDE.md section 6.3: "edge must never import from apps/api; it depends on
 * packages/queue, packages/db (read-mostly) and packages/utils only."
 *
 * edge additionally uses the layer-1 and layer-2 foundations — config, logger
 * and types — which docs/01 places below queue and db in the layering table,
 * and which a process cannot start without. What the rule exists to prevent
 * is edge inheriting the API's middleware stack, its cold start and its blast
 * radius (docs/01), so the ban enforced here is on apps/api and on every
 * layer-5 domain package.
 */
const FORBIDDEN = [
  '@relayd/api',
  '@relayd/web',
  '@relayd/billing',
  '@relayd/campaigns',
  '@relayd/audience',
  '@relayd/analytics',
  '@relayd/email-providers',
  '@relayd/notifications',
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const IMPORT_PATTERN = /(?:from|import)\s+['"]([^'"]+)['"]/gu;

describe('edge isolation', () => {
  it('declares no dependency on apps/api or any domain package', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(edgeRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    expect(declared.filter((name) => FORBIDDEN.includes(name))).toEqual([]);
  });

  it('imports nothing from apps/api or any domain package', async () => {
    const files = await sourceFiles(path.join(edgeRoot, 'src'));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? '';
        if (FORBIDDEN.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
          offenders.push(`${path.relative(edgeRoot, file)} -> ${specifier}`);
        }
        // A relative path that climbs out of apps/edge is the other way in.
        if (specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), specifier);
          if (!resolved.startsWith(edgeRoot)) {
            offenders.push(`${path.relative(edgeRoot, file)} -> ${specifier}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
