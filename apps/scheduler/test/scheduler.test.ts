import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { DirectClient } from '@relayd/db';
import { Scheduler } from '../src/scheduler.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const silent = () =>
  createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } });

function fakeClient() {
  const connect = vi.fn(async () => undefined);
  const query = vi.fn(async () => ({ rows: [] }));
  const end = vi.fn(async () => undefined);
  return { connect, query, end, client: { connect, query, end } as unknown as DirectClient };
}

describe('Scheduler', () => {
  it('connects and proves the connection before reporting started', async () => {
    const f = fakeClient();
    const scheduler = new Scheduler({ client: f.client, logger: silent() });
    await scheduler.start();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledWith('SELECT 1');
    expect(scheduler.started).toBe(true);
  });

  it('closes the connection on stop', async () => {
    const f = fakeClient();
    const scheduler = new Scheduler({ client: f.client, logger: silent() });
    await scheduler.start();
    await scheduler.stop();
    expect(f.end).toHaveBeenCalledOnce();
    expect(scheduler.started).toBe(false);
  });

  it('is a no-op when stopped before started', async () => {
    const f = fakeClient();
    await new Scheduler({ client: f.client, logger: silent() }).stop();
    expect(f.end).not.toHaveBeenCalled();
  });
});

/**
 * INVARIANTS R35: the scheduler connects directly to Postgres, never through
 * PgBouncer. A pooled connection would let another client take the session
 * between statements, and the tick-spanning advisory lock would stop meaning
 * what the scheduler thinks it means.
 *
 * Structural rather than behavioural, because the failure it guards against
 * is someone reaching for the familiar createPool and DATABASE_URL — which
 * would work perfectly in every test and be wrong in production.
 */
describe('R35: direct, non-pooled connection', () => {
  it('uses DATABASE_DIRECT_URL and never the pooled DATABASE_URL', async () => {
    const entries = await readdir(path.join(appRoot, 'src'), {
      withFileTypes: true,
      recursive: true,
    });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => path.join(e.parentPath, e.name));

    let sawDirectUrl = false;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');

      if (code.includes('DATABASE_DIRECT_URL')) sawDirectUrl = true;
      expect(code, `${path.relative(appRoot, file)} must not use the pooled URL`).not.toMatch(
        /\bDATABASE_URL\b/u,
      );
      expect(code, `${path.relative(appRoot, file)} must not create a pool`).not.toMatch(
        /\bcreatePool\b/u,
      );
    }
    expect(sawDirectUrl).toBe(true);
  });
});
