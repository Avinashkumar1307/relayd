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
 *
 * One narrow exception: `@relayd/email-providers/webhooks`.
 *
 * INVARIANTS R4 requires the signature on an inbound provider event to be
 * verified with that connection's own secret at the ingest endpoint, and the
 * ingest endpoint is here. It cannot be deferred to a worker: an endpoint
 * that enqueues before verifying accepts whatever anyone posts, and the queue
 * becomes the amplifier. INVARIANTS outranks CLAUDE.md (CLAUDE.md section 1).
 *
 * The exception is the subpath, never the package root, and the reason the
 * rule exists still holds: the subpath reaches node:crypto and JSON and
 * nothing else. The second test below proves no provider SDK is reachable
 * from it, so edge still does not carry the AWS SDK or nodemailer. Recorded
 * in docs/16 and flagged to the owner.
 */
const ALLOWED_SUBPATHS = ['@relayd/email-providers/webhooks'];
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

    // The package may be declared — the subpath has to come from somewhere —
    // but nothing may import its root.
    const forbiddenExceptProviders = FORBIDDEN.filter(
      (name) => name !== '@relayd/email-providers',
    );
    expect(declared.filter((name) => forbiddenExceptProviders.includes(name))).toEqual([]);
  });

  it('imports nothing from apps/api or any domain package', async () => {
    const files = await sourceFiles(path.join(edgeRoot, 'src'));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? '';
        if (ALLOWED_SUBPATHS.includes(specifier)) continue;
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

  it('reaches no provider SDK through the webhooks subpath', async () => {
    // The whole justification for the exception above. If this fails, edge
    // has started carrying the sending machinery and the exception must be
    // withdrawn rather than widened.
    const providerRoot = path.resolve(edgeRoot, '../../packages/email-providers/src');
    const SDKS = ['@aws-sdk/', 'nodemailer', '@sendgrid/', 'mailgun', '@getbrevo/', 'stripe'];

    const visited = new Set<string>();
    const offenders: string[] = [];

    async function walk(file: string): Promise<void> {
      if (visited.has(file)) return;
      visited.add(file);

      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? '';

        if (SDKS.some((sdk) => specifier === sdk || specifier.startsWith(sdk))) {
          offenders.push(`${path.relative(providerRoot, file)} -> ${specifier}`);
          continue;
        }

        if (!specifier.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), specifier).replace(/\.js$/u, '.ts');
        await walk(resolved);
      }
    }

    await walk(path.join(providerRoot, 'webhooks.ts'));

    // A guard on the guard: a walk that visited one file proves nothing.
    expect(visited.size).toBeGreaterThan(2);
    expect(offenders).toEqual([]);
  });
});
