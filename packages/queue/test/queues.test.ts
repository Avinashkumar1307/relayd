import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CRITICAL_QUEUES,
  QUEUE_NAMES,
  QUEUE_SETTINGS,
  jobIds,
  jobOptionsFor,
  workerOptionsFor,
} from '../src/queues.js';

/**
 * Queue settings (CLAUDE.md §9: "Defaults are never accepted") and INVARIANTS
 * R23 (no BullMQ repeatables anywhere).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('every queue is fully declared', () => {
  it('declares the queues BUILD-PLAN Phase 5 lists', () => {
    for (const name of [
      'email-send',
      'campaign-launch',
      'campaign-dispatch',
      'recipient-sweeper',
      'campaign-reconcile',
      'event-ingest',
      'analytics-rollup',
      'billing-webhook',
      'billing-refetch',
      'billing-reconcile',
      'billing-processing',
      'contact-import',
      'provider-verify',
      'outbound-webhook',
    ]) {
      expect(QUEUE_NAMES, name).toContain(name);
    }
  });

  for (const name of QUEUE_NAMES) {
    it(`${name} sets every option rather than inheriting one`, () => {
      const settings = QUEUE_SETTINGS[name];

      expect(settings.concurrency, 'concurrency').toBeGreaterThanOrEqual(1);
      expect(settings.lockDuration, 'lockDuration').toBeGreaterThan(0);
      expect(settings.attempts, 'attempts').toBeGreaterThanOrEqual(1);
      expect(settings.backoff.delay, 'backoff delay').toBeGreaterThan(0);

      // Unbounded completed sets are how Redis fills up quietly.
      expect(settings.removeOnComplete.count, 'removeOnComplete count').toBeGreaterThan(0);
      expect(settings.removeOnComplete.age, 'removeOnComplete age').toBeGreaterThan(0);

      // false is a deliberate "never remove", not an omission.
      if (settings.removeOnFail !== false) {
        expect(settings.removeOnFail.count, 'removeOnFail count').toBeGreaterThan(0);
        expect(settings.removeOnFail.age, 'removeOnFail age').toBeGreaterThan(0);
      }

      expect(settings.description.length).toBeGreaterThan(20);
    });

    it(`${name} keeps failures longer than successes`, () => {
      // A failure is evidence. Discarding it as fast as a success means the
      // thing you need to look at is the thing that has already gone.
      const settings = QUEUE_SETTINGS[name];
      if (settings.removeOnFail === false) return;

      expect(settings.removeOnFail.age).toBeGreaterThanOrEqual(settings.removeOnComplete.age);
    });
  }
});

describe('the settings that carry weight', () => {
  it('email-send holds its lock for 120 seconds', () => {
    // Amendment H. The provider timeout is capped below it, so a slow
    // provider can never outlive the lock and have its job handed to a second
    // worker mid-send.
    expect(QUEUE_SETTINGS['email-send'].lockDuration).toBe(120_000);
  });

  it('email-send never recovers a stalled job', () => {
    // The most important number in the file. A stalled send may already have
    // reached the provider; recovering it sends the same email twice. The
    // durable guard is the Postgres state transition, and the reconciler
    // resolves the ambiguity (D3).
    expect(QUEUE_SETTINGS['email-send'].maxStalledCount).toBe(0);
  });

  it('email-send bounds both retention sets', () => {
    const settings = QUEUE_SETTINGS['email-send'];
    expect(settings.removeOnComplete.count).toBeGreaterThan(0);
    expect(settings.removeOnFail).not.toBe(false);
  });

  it('billing-webhook never discards a failed job', () => {
    // A dropped billing event is money or entitlement drift.
    expect(QUEUE_SETTINGS['billing-webhook'].removeOnFail).toBe(false);
  });

  it('campaign-dispatch runs one job per campaign', () => {
    // Three dispatchers gain nothing — the claim query already serialises —
    // and triple the chance of a throttle miscalculation.
    expect(QUEUE_SETTINGS['campaign-dispatch'].concurrency).toBe(1);
  });

  it('keeps email-send concurrency modest', () => {
    // Per-sender concurrency is the rate limiter's job. A high worker
    // concurrency just means more workers blocked on token acquisition.
    expect(QUEUE_SETTINGS['email-send'].concurrency).toBeLessThanOrEqual(50);
  });

  it('gives a long-running job a lock that outlasts it', () => {
    // A 500,000-row import can take an hour. A shorter lock means a second
    // worker starts the same file while the first is still reading it.
    expect(QUEUE_SETTINGS['contact-import'].lockDuration).toBeGreaterThanOrEqual(60 * 60_000);
    expect(QUEUE_SETTINGS['campaign-dispatch'].lockDuration).toBeGreaterThanOrEqual(60 * 60_000);
  });

  it('pages for the queues where silence is expensive', () => {
    for (const name of ['email-send', 'billing-webhook', 'billing-reconcile', 'campaign-launch']) {
      expect(CRITICAL_QUEUES.has(name as never), name).toBe(true);
    }
  });
});

describe('job options', () => {
  it('are built from the settings rather than written twice', () => {
    const options = jobOptionsFor('email-send');
    const settings = QUEUE_SETTINGS['email-send'];

    expect(options.attempts).toBe(settings.attempts);
    expect(options.backoff.delay).toBe(settings.backoff.delay);
    expect(options.removeOnComplete).toEqual(settings.removeOnComplete);
  });

  it('carry maxStalledCount only where it is set', () => {
    expect(workerOptionsFor('email-send').maxStalledCount).toBe(0);
    expect(workerOptionsFor('contact-import').maxStalledCount).toBeUndefined();
  });

  it('never include a repeat option', () => {
    // R23. A repeatable lives in Redis; a flush loses it silently.
    expect(JSON.stringify(jobOptionsFor('analytics-rollup'))).not.toContain('repeat');
  });
});

describe('deterministic job ids', () => {
  it('produce the same id for the same work', () => {
    // This is what makes a dead-letter replay safe: re-enqueueing with the
    // original id is a no-op if the job already succeeded.
    expect(jobIds.emailSend('r1')).toBe(jobIds.emailSend('r1'));
    expect(jobIds.campaignLaunch('c1')).toBe('campaign:c1:launch');
    expect(jobIds.billingWebhook('stripe', 'evt_1')).toBe('bwh:stripe:evt_1');
  });

  it('distinguish different work', () => {
    expect(jobIds.emailSend('r1')).not.toBe(jobIds.emailSend('r2'));
    expect(jobIds.campaignLaunch('c1')).not.toBe(jobIds.campaignDispatch('c1'));
  });

  it('separate an ingest event by connection, not only by event id', () => {
    // Two connections can see the same provider event id. Keying on the event
    // alone would let one workspace's event suppress another's.
    expect(jobIds.eventIngest('conn-a', 'evt-1')).not.toBe(jobIds.eventIngest('conn-b', 'evt-1'));
  });
});

/**
 * R23, enforced across the repository.
 *
 * A grep rather than a type-level rule: `repeat` is a plain BullMQ option and
 * nothing in the type system stops a call site passing one.
 */
describe('no BullMQ repeatable jobs anywhere (R23)', () => {
  const SKIP = new Set(['node_modules', 'dist', '.turbo', '.git', 'coverage', 'test']);

  async function* sourceFiles(directory: string): AsyncGenerator<string> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;

      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) yield* sourceFiles(full);
      else if (/\.(?:ts|tsx)$/u.test(entry.name)) yield full;
    }
  }

  /** `repeat:` or `repeatable`, as an option rather than in prose. */
  const REPEAT = /(?:^|[\s{,])repeat\s*:|\brepeatable\b|\baddRepeatable\b|\bupsertJobScheduler\b/u;

  it('finds source files to scan', async () => {
    const files: string[] = [];
    for await (const file of sourceFiles(path.join(root, 'packages'))) files.push(file);
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no repeat option in any source file', async () => {
    const offenders: string[] = [];

    for (const area of ['packages', 'apps']) {
      for await (const file of sourceFiles(path.join(root, area))) {
        const source = await readFile(file, 'utf8');

        // Comments are blanked first, so prose explaining the rule does not
        // trip it — the same treatment the R36 scanner needed.
        const code = source
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .split('\n')
          .map((line) => line.replace(/\/\/.*$/u, ''))
          .join('\n');

        if (REPEAT.test(code)) {
          const line = code.split('\n').findIndex((l) => REPEAT.test(l)) + 1;
          offenders.push(`${path.relative(root, file).replaceAll('\\', '/')}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still catches a repeat option when one is introduced', () => {
    // Proves the pattern matches what it claims to.
    expect(REPEAT.test("queue.add('x', {}, { repeat: { pattern: '0 * * * *' } })")).toBe(true);
    expect(REPEAT.test('await queue.upsertJobScheduler("nightly", { pattern })')).toBe(true);
    expect(REPEAT.test('await queue.addRepeatable(name, opts)')).toBe(true);
  });

  it('does not flag an unrelated word', () => {
    expect(REPEAT.test('const repeated = value.repeat(3);')).toBe(false);
    expect(REPEAT.test('// repeatable jobs are banned')).toBe(true);
  });
});
