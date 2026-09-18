import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_SIZE,
  batchFailureOutcomes,
  batchSizeFor,
  isAmbiguous,
  isPreAcceptance,
} from '../src/batching.js';
import { fromUnknown } from '../src/errors.js';
import type { OutboundMessage, ProviderError } from '../src/port.js';

/**
 * Batch size and batch failure (INVARIANTS R31, review finding F31).
 *
 * The trace: a batch of 500 times out after the provider accepted 400. The
 * job retries. Four hundred people get the email twice and nothing in the
 * system knows.
 *
 * Both halves of the fix are tested here — the cap that bounds the blast
 * radius, and the question that decides whether a retry is allowed at all.
 */

function coded(code: string): Error {
  return Object.assign(new Error('socket'), { code });
}

describe('the cap (R31)', () => {
  it('is 100', () => {
    expect(MAX_BATCH_SIZE).toBe(100);
  });

  it('overrides an adapter that claims it can take more', () => {
    // The adapter is describing its own request limit. That is a different
    // question from how many recipients one ambiguous response may affect.
    expect(batchSizeFor(1000)).toBe(100);
    expect(batchSizeFor(500)).toBe(100);
  });

  it('respects an adapter that takes fewer', () => {
    expect(batchSizeFor(50)).toBe(50);
    expect(batchSizeFor(1)).toBe(1);
  });

  it('never returns zero, whatever it is given', () => {
    // A batch size of zero is an infinite loop in every caller.
    expect(batchSizeFor(0)).toBe(1);
    expect(batchSizeFor(-10)).toBe(1);
    expect(batchSizeFor(Number.NaN)).toBe(1);
    expect(batchSizeFor(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('floors a fractional declaration', () => {
    expect(batchSizeFor(10.9)).toBe(10);
  });
});

describe('did the provider answer?', () => {
  it('treats any HTTP status as a definitive answer', () => {
    // A 429 is not ambiguous. The provider told us what happened.
    for (const status of [200, 400, 429, 500, 503]) {
      const error = Object.assign(new Error('answered'), { status });
      expect(isAmbiguous(error), String(status)).toBe(false);
    }
  });

  it('finds the status on a nested response object', () => {
    const error = Object.assign(new Error('x'), { response: { statusCode: 429 } });
    expect(isAmbiguous(error)).toBe(false);
  });

  it('treats a refused connection as definitively pre-acceptance', () => {
    // Nothing was written. There is no request to have been accepted.
    expect(isPreAcceptance(coded('ECONNREFUSED'))).toBe(true);
    expect(isAmbiguous(coded('ECONNREFUSED'))).toBe(false);
  });

  it('treats a failed DNS lookup as pre-acceptance', () => {
    expect(isPreAcceptance(coded('ENOTFOUND'))).toBe(true);
    expect(isPreAcceptance(coded('EAI_AGAIN'))).toBe(true);
  });

  it('treats a connection reset as ambiguous, not as pre-acceptance', () => {
    // The one that matters. A reset is a successful write followed by a peer
    // that went away, and it is indistinguishable from an accepted send.
    expect(isPreAcceptance(coded('ECONNRESET'))).toBe(false);
    expect(isAmbiguous(coded('ECONNRESET'))).toBe(true);
  });

  it('treats a broken pipe and a timeout as ambiguous', () => {
    for (const code of ['EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR']) {
      expect(isAmbiguous(coded(code)), code).toBe(true);
      expect(isPreAcceptance(coded(code)), code).toBe(false);
    }
  });

  it('treats undici socket failures as ambiguous', () => {
    for (const code of ['UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      expect(isAmbiguous(coded(code)), code).toBe(true);
    }
  });

  it('treats an aborted fetch as ambiguous', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(isAmbiguous(error)).toBe(true);
  });

  it('treats anything it does not recognise as ambiguous', () => {
    // Conservative on purpose. A wrongly uncertain recipient is a line in a
    // report; a wrongly retried one is a duplicate nobody can take back.
    expect(isAmbiguous(new Error('something odd'))).toBe(true);
    expect(isAmbiguous('a thrown string')).toBe(true);
    expect(isAmbiguous(undefined)).toBe(true);
  });

  it('does not call anything it fails to recognise pre-acceptance', () => {
    // The two are not complements, and this is where that matters: an
    // unrecognised throw is uncertain, never safe to retry.
    expect(isPreAcceptance(new Error('something odd'))).toBe(false);
    expect(isPreAcceptance('a thrown string')).toBe(false);
    expect(isPreAcceptance(null)).toBe(false);
  });

  it('answers three ways, not two', () => {
    // The structure the two functions encode. A 550 is neither safe to retry
    // nor uncertain — it is a definitive failure, and collapsing this into one
    // boolean is what loses that case.
    const answered = Object.assign(new Error('rejected'), { status: 550 });
    const refused = coded('ECONNREFUSED');
    const reset = coded('ECONNRESET');

    expect([isPreAcceptance(answered), isAmbiguous(answered)]).toEqual([false, false]);
    expect([isPreAcceptance(refused), isAmbiguous(refused)]).toEqual([true, false]);
    expect([isPreAcceptance(reset), isAmbiguous(reset)]).toEqual([false, true]);
  });

  it('holds the line on the one code that most invites the mistake', () => {
    // If ECONNRESET is ever added to the pre-acceptance list, this is the test
    // that says no. It is a successful write followed by a peer that went
    // away, which is indistinguishable from an accepted send.
    expect(isPreAcceptance(coded('ECONNRESET'))).toBe(false);
  });

  it('never calls the same error both pre-acceptance and ambiguous', () => {
    const causes: unknown[] = [
      coded('ECONNREFUSED'),
      coded('ECONNRESET'),
      coded('ENOTFOUND'),
      coded('EPIPE'),
      Object.assign(new Error('x'), { status: 429 }),
      new Error('plain'),
      'string',
      null,
    ];

    for (const cause of causes) {
      expect(isPreAcceptance(cause) && isAmbiguous(cause)).toBe(false);
    }
  });
});

describe('the flag reaching the scrubbed error', () => {
  it('marks a connection reset ambiguous once scrubbed', () => {
    // The whole point of the field: `provider_unavailable` is retryable, and
    // without this the send path would retry a message that may be delivered.
    const error = fromUnknown(coded('ECONNRESET'));

    expect(error.kind).toBe('provider_unavailable');
    expect(error.retryable).toBe(true);
    expect(error.ambiguous).toBe(true);
  });

  it('leaves a refused connection retryable and definite', () => {
    const error = fromUnknown(coded('ECONNREFUSED'));

    expect(error.retryable).toBe(true);
    expect(error.ambiguous).toBeUndefined();
  });

  it('leaves a 429 definite', () => {
    const error = fromUnknown(Object.assign(new Error('slow down'), { status: 429 }));
    expect(error.ambiguous).toBeUndefined();
  });

  it('leaves a 550 definite', () => {
    const error = fromUnknown(Object.assign(new Error('rejected'), { status: 550 }));
    expect(error.ambiguous).toBeUndefined();
  });

  it('does not re-flag an error an adapter already typed', () => {
    // An adapter that built its own ProviderError knows what happened; running
    // it through classification again would only lose that.
    const typed: ProviderError = {
      kind: 'auth_failed',
      retryable: false,
      affects: 'connection',
      message: 'bad key',
    };

    expect(fromUnknown(typed).ambiguous).toBeUndefined();
  });

  it('still scrubs the message on an ambiguous error', () => {
    // The flag must not become a way around R22.
    const error = fromUnknown(
      Object.assign(new Error('reset while sending api_key=SG.abcdefghijklmnop.qrstuvwxyz012345'), {
        code: 'ECONNRESET',
      }),
    );

    expect(error.ambiguous).toBe(true);
    expect(error.message).not.toContain('SG.');
  });
});

describe('a batch that failed as a whole', () => {
  const batch: OutboundMessage[] = [
    { recipientId: 'r1' } as OutboundMessage,
    { recipientId: 'r2' } as OutboundMessage,
    { recipientId: 'r3' } as OutboundMessage,
  ];

  it('gives every message in it the same error', () => {
    // The provider answered once, or not at all, and it answered about the
    // batch. Splitting that into per-message verdicts invents information.
    const error = fromUnknown(coded('ECONNRESET'));
    const outcomes = batchFailureOutcomes(batch, error);

    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.error.ambiguous).toBe(true);
    }
  });

  it('leaves no recipient without an outcome', () => {
    // A missing outcome is a recipient stuck in `sending` until a reconciler
    // finds it.
    const outcomes = batchFailureOutcomes(batch, fromUnknown(coded('ECONNREFUSED')));
    expect(outcomes.map((o) => o.recipientId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('returns nothing for an empty batch', () => {
    expect(batchFailureOutcomes([], fromUnknown(new Error('x')))).toEqual([]);
  });
});
