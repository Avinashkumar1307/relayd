import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { entrypoint as billing } from '../src/entrypoints/billing.js';
import { entrypoint as campaign } from '../src/entrypoints/campaign.js';
import { entrypoint as events } from '../src/entrypoints/events.js';
import { entrypoint as io } from '../src/entrypoints/io.js';
import { entrypoint as send } from '../src/entrypoints/send.js';

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/entrypoints',
);

/** CLAUDE.md section 3 fixes the five entrypoint names. */
const EXPECTED = ['billing', 'campaign', 'events', 'io', 'send'];

describe('worker entrypoints', () => {
  it('are exactly the five from CLAUDE.md section 3', async () => {
    const names = (await readdir(dir))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/u, ''))
      .sort();
    expect(names).toEqual(EXPECTED);
  });

  it('each export an entrypoint whose name matches its file', () => {
    const loaded = [billing, campaign, events, io, send];
    expect(loaded.map((e) => e.name).sort()).toEqual(EXPECTED);
    for (const entrypoint of loaded) {
      expect(typeof entrypoint.start).toBe('function');
      expect(typeof entrypoint.stop).toBe('function');
    }
  });
});
