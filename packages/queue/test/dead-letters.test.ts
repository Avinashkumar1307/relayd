import { describe, expect, it, vi } from 'vitest';
import {
  handleFailedJob,
  replayDeadLetter,
  serialiseError,
  workspaceIdOf,
  type DeadLetterRecord,
  type FailedJob,
} from '../src/dead-letters.js';

/**
 * The dead-letter handler.
 *
 * BullMQ has no native DLQ, so this is the whole of it. What matters: a job
 * with retries left writes nothing, a job without them is never lost, nothing
 * from the thrown error survives unscrubbed, and a replay cannot run twice.
 */

const CANARY = 'SECRET-CANARY-9f3a';

function job(overrides: Partial<FailedJob> = {}): FailedJob {
  return {
    queueName: 'email-send',
    id: 'send:r1',
    data: { recipientId: 'r1', workspaceId: 'ws-1' },
    attemptsMade: 5,
    opts: { attempts: 5 },
    ...overrides,
  };
}

function sink(options: { duplicate?: boolean } = {}) {
  const records: DeadLetterRecord[] = [];

  return {
    records,
    sink: {
      async record(entry: DeadLetterRecord) {
        records.push(entry);
        return options.duplicate !== true;
      },
    },
  };
}

describe('when a job fails', () => {
  it('writes nothing while attempts remain', async () => {
    // Recording every intermediate failure would bury the final one.
    const { sink: target, records } = sink();

    const written = await handleFailedJob(
      job({ attemptsMade: 2, opts: { attempts: 5 } }),
      new Error('temporary'),
      { sink: target },
    );

    expect(written).toBe(false);
    expect(records).toEqual([]);
  });

  it('records once attempts are exhausted', async () => {
    const { sink: target, records } = sink();

    const written = await handleFailedJob(job(), new Error('permanent'), { sink: target });

    expect(written).toBe(true);
    expect(records[0]).toMatchObject({
      queue: 'email-send',
      jobId: 'send:r1',
      workspaceId: 'ws-1',
      attempts: 5,
    });
  });

  it('records a job with no id rather than losing it', async () => {
    // It cannot be replayed or deduplicated, and it is still worth more than
    // nothing.
    const { sink: target, records } = sink();

    await handleFailedJob(job({ id: undefined }), new Error('x'), { sink: target });

    expect(records[0]?.jobId).toContain('unidentified:email-send');
  });

  it('pages for a critical queue, once', async () => {
    const page = vi.fn();
    const { sink: target } = sink();

    await handleFailedJob(job(), new Error('x'), { sink: target, page });

    expect(page).toHaveBeenCalledTimes(1);
  });

  it('does not page for a queue where silence is cheap', async () => {
    const page = vi.fn();
    const { sink: target } = sink();

    await handleFailedJob(job({ queueName: 'outbound-webhook' }), new Error('x'), {
      sink: target,
      page,
    });

    expect(page).not.toHaveBeenCalled();
  });

  it('does not page again for a failure already recorded', async () => {
    // Paging on a duplicate event is how a pager gets ignored.
    const page = vi.fn();
    const { sink: target } = sink({ duplicate: true });

    await handleFailedJob(job(), new Error('x'), { sink: target, page });

    expect(page).not.toHaveBeenCalled();
  });

  it('counts it', async () => {
    const increment = vi.fn();
    const { sink: target } = sink();

    await handleFailedJob(job(), new Error('x'), { sink: target, metrics: { increment } });

    expect(increment).toHaveBeenCalledWith('queue.dead_letter', { queue: 'email-send' });
  });
});

describe('the stored error', () => {
  it('keeps only name, message and a bounded stack', async () => {
    const { sink: target, records } = sink();

    const thrown = Object.assign(new Error('auth failed'), {
      // The kind of thing a thrown object really carries.
      config: { headers: { Authorization: `Bearer ${CANARY}` } },
      request: { body: 'everything' },
    });

    await handleFailedJob(job(), thrown, { sink: target });

    expect(Object.keys(records[0]?.error ?? {}).sort()).toEqual(['message', 'name', 'stack']);
    expect(JSON.stringify(records[0]?.error)).not.toContain(CANARY);
  });

  it('applies the caller’s scrubber to the message', async () => {
    const { sink: target, records } = sink();

    await handleFailedJob(job(), new Error(`key ${CANARY} rejected`), { sink: target }, (text) =>
      text.replaceAll(CANARY, '[redacted]'),
    );

    expect(JSON.stringify(records[0]?.error)).not.toContain(CANARY);
  });

  it('never stringifies an unknown thrown value', () => {
    // That is how a credential hanging off a thrown object ends up in the
    // database.
    const error = serialiseError({ secretAccessKey: CANARY, nested: { token: CANARY } });

    expect(JSON.stringify(error)).not.toContain(CANARY);
    expect(error['name']).toBe('UnknownError');
  });

  it('handles a thrown string', () => {
    expect(serialiseError('just a string')['message']).toBe('just a string');
  });

  it('bounds the message and the stack', () => {
    const huge = new Error('x'.repeat(10_000));
    huge.stack = 'y'.repeat(20_000);

    const error = serialiseError(huge);

    expect(String(error['message']).length).toBeLessThanOrEqual(2000);
    expect(String(error['stack']).length).toBeLessThanOrEqual(4000);
  });
});

describe('attributing a failure to a workspace', () => {
  it('reads it from the payload', () => {
    expect(workspaceIdOf({ workspaceId: 'ws-1', recipientId: 'r1' })).toBe('ws-1');
  });

  it('returns null rather than guessing', () => {
    // Guessing would attribute someone else's failure to a workspace.
    expect(workspaceIdOf({ recipientId: 'r1' })).toBeNull();
    expect(workspaceIdOf(null)).toBeNull();
    expect(workspaceIdOf('nonsense')).toBeNull();
    expect(workspaceIdOf({ workspaceId: '' })).toBeNull();
    expect(workspaceIdOf({ workspaceId: 42 })).toBeNull();
  });
});

describe('replaying', () => {
  function target() {
    const enqueued: { queue: string; jobId: string }[] = [];
    return {
      enqueued,
      target: {
        async enqueue(input: { queue: string; jobId: string }) {
          enqueued.push({ queue: input.queue, jobId: input.jobId });
        },
      },
    };
  }

  const entry = {
    id: 'dl-1',
    queue: 'email-send',
    jobId: 'send:r1',
    payload: { recipientId: 'r1' },
    status: 'new',
  };

  it('re-enqueues with the original job id', async () => {
    // Which is what makes replaying an already-succeeded job a no-op rather
    // than a second send.
    const { target: t, enqueued } = target();

    const result = await replayDeadLetter(entry, t, async () => true);

    expect(result.replayed).toBe(true);
    expect(enqueued).toEqual([{ queue: 'email-send', jobId: 'send:r1' }]);
  });

  it('refuses one already replayed', async () => {
    const { target: t, enqueued } = target();

    const result = await replayDeadLetter({ ...entry, status: 'replayed' }, t, async () => true);

    expect(result).toEqual({ replayed: false, reason: 'already replayed' });
    expect(enqueued).toEqual([]);
  });

  it('refuses one an operator discarded', async () => {
    const { target: t, enqueued } = target();

    const result = await replayDeadLetter({ ...entry, status: 'discarded' }, t, async () => true);

    expect(result.replayed).toBe(false);
    expect(enqueued).toEqual([]);
  });

  it('refuses when the claim is lost to a concurrent replay', async () => {
    // Two operators clicking at once: the guarded update lets one through.
    const { target: t, enqueued } = target();

    const result = await replayDeadLetter(entry, t, async () => false);

    expect(result).toEqual({ replayed: false, reason: 'already replayed' });
    expect(enqueued).toEqual([]);
  });

  it('marks it replayed before enqueueing', async () => {
    // The other order risks a job enqueued twice, which an operator cannot
    // undo; this order risks a row that says replayed but did not run, which
    // they can investigate.
    const order: string[] = [];

    await replayDeadLetter(
      entry,
      {
        async enqueue() {
          order.push('enqueue');
        },
      },
      async () => {
        order.push('mark');
        return true;
      },
    );

    expect(order).toEqual(['mark', 'enqueue']);
  });
});
