import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { runEntrypoint, type WorkerEntrypoint } from '../src/harness.js';

const silent = () =>
  createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } });

/** Stands in for `process`: captures exit codes instead of ending the run. */
function fakeProcess() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  return {
    exits,
    raise: (signal: string) => emitter.emit(signal),
    ref: {
      on: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => emitter.on(signal, handler),
      exit: (code: number) => {
        exits.push(code);
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('graceful shutdown', () => {
  it('starts the entrypoint', async () => {
    const start = vi.fn(async () => undefined);
    const p = fakeProcess();
    await runEntrypoint({
      entrypoint: { name: 'send', start, stop: async () => undefined },
      logger: silent(),
      processRef: p.ref,
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it('drains in-flight jobs on SIGTERM and exits 0', async () => {
    let drained = false;
    const entrypoint: WorkerEntrypoint = {
      name: 'send',
      start: async () => undefined,
      stop: async () => {
        await new Promise((r) => setTimeout(r, 5));
        drained = true;
      },
    };
    const p = fakeProcess();
    await runEntrypoint({ entrypoint, logger: silent(), processRef: p.ref });

    p.raise('SIGTERM');
    await settle();

    expect(drained).toBe(true);
    expect(p.exits).toEqual([0]);
  });

  it('drains on SIGINT too', async () => {
    const stop = vi.fn(async () => undefined);
    const p = fakeProcess();
    await runEntrypoint({
      entrypoint: { name: 'io', start: async () => undefined, stop },
      logger: silent(),
      processRef: p.ref,
    });
    p.raise('SIGINT');
    await settle();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('ignores a second signal rather than racing the first drain', async () => {
    const stop = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const p = fakeProcess();
    await runEntrypoint({
      entrypoint: { name: 'send', start: async () => undefined, stop },
      logger: silent(),
      processRef: p.ref,
    });

    p.raise('SIGTERM');
    p.raise('SIGTERM');
    await new Promise((r) => setTimeout(r, 40));

    expect(stop).toHaveBeenCalledOnce();
    expect(p.exits).toEqual([0]);
  });

  it('exits non-zero when the drain outruns the timeout', async () => {
    const entrypoint: WorkerEntrypoint = {
      name: 'send',
      start: async () => undefined,
      stop: () => new Promise(() => undefined), // never settles
    };
    const p = fakeProcess();
    await runEntrypoint({
      entrypoint,
      logger: silent(),
      processRef: p.ref,
      shutdownTimeoutMs: 15,
    });

    p.raise('SIGTERM');
    await new Promise((r) => setTimeout(r, 40));

    expect(p.exits).toEqual([1]);
  });

  it('exits non-zero when the drain throws', async () => {
    const p = fakeProcess();
    await runEntrypoint({
      entrypoint: {
        name: 'send',
        start: async () => undefined,
        stop: async () => {
          throw new Error('close failed');
        },
      },
      logger: silent(),
      processRef: p.ref,
    });
    p.raise('SIGTERM');
    await settle();
    expect(p.exits).toEqual([1]);
  });
});
