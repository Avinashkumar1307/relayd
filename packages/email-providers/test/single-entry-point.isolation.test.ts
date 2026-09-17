import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `sendWithLimits` is the only way to reach an adapter's send methods.
 *
 * CLAUDE.md §6.4: the rate limiter and the daily-quota check live inside the
 * adapter call path so no consumer can forget them. That guarantee survives
 * exactly as long as nobody calls `adapter.send` directly — and calling it
 * directly is one autocomplete away, in a file where it looks entirely
 * reasonable.
 *
 * A grep is a blunt instrument and it is the right one here: it cannot be
 * satisfied by a clever indirection that a type-level rule would miss, and a
 * developer who genuinely needs an exception has to add it here, in front of
 * a reviewer.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The wrapper itself, and the fake used to test consumers of it. */
const ALLOWED = [
  'packages/email-providers/src/send-with-limits.ts',
  'packages/email-providers/src/testing/fake-provider.ts',
];

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.turbo', '.git', 'coverage']);

async function* sourceFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRECTORIES.has(entry.name)) continue;

    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) yield full;
  }
}

/** Normalised so a Windows path and a Linux CI path compare equal. */
function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}

/**
 * Calls of the form `<something>.send(` or `.sendBatch(`, where the receiver
 * looks like a provider adapter.
 *
 * Deliberately narrow on the receiver name: `transporter.send` inside the SMTP
 * adapter is nodemailer's own API, not the port's, and banning every method
 * called `send` anywhere would make this rule impossible to live with.
 */
const DIRECT_CALL = /\b(?:adapter|provider|providerAdapter|emailProvider)\s*\.\s*(send|sendBatch)\s*\(/gu;

describe('the send wrapper is the only entry point', () => {
  it('finds source files to scan', async () => {
    // A guard on the guard: a scan that silently found nothing would pass
    // every assertion below.
    const files: string[] = [];
    for await (const file of sourceFiles(path.join(root, 'packages'))) files.push(file);
    expect(files.length).toBeGreaterThan(50);
  });

  it('is the only place that calls an adapter directly', async () => {
    const offenders: string[] = [];

    for (const area of ['packages', 'apps']) {
      for await (const file of sourceFiles(path.join(root, area))) {
        const name = relative(file);
        if (ALLOWED.includes(name)) continue;
        // Tests construct adapters on purpose to test them.
        if (/(?:^|\/)test\//u.test(name)) continue;

        const source = await readFile(file, 'utf8');
        DIRECT_CALL.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = DIRECT_CALL.exec(source)) !== null) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${name}:${line} calls .${match[1] as string}() directly`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still catches a direct call when one is introduced', () => {
    // Proves the pattern matches what it claims to, without waiting for
    // someone to commit the mistake.
    const sample = `
      const outcome = await adapter.send(creds, message);
      const many = await provider.sendBatch(creds, messages);
    `;

    DIRECT_CALL.lastIndex = 0;
    expect([...sample.matchAll(DIRECT_CALL)].map((m) => m[1])).toEqual(['send', 'sendBatch']);
  });

  it('does not flag an unrelated method called send', () => {
    // nodemailer inside the SMTP adapter, a queue client, a mailer helper.
    const sample = `
      await transporter.sendMail(payload);
      await queue.send({ name: 'x' });
      this.sendBatchInternal(rows);
    `;

    DIRECT_CALL.lastIndex = 0;
    expect([...sample.matchAll(DIRECT_CALL)]).toEqual([]);
  });
});
