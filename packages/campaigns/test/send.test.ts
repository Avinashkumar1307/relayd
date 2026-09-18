import { describe, expect, it, vi } from 'vitest';
import {
  classifyForSend,
  messageIdFor,
  sendOne,
  type ProviderCallResult,
  type SendPort,
  type SendableRecipient,
} from '../src/engine/send.js';

/**
 * The send worker (INVARIANTS R1, R5, R30, and D3 for the ambiguous case).
 *
 * Every test here is about ordering. The steps are individually obvious; the
 * bugs are all in doing them in the wrong order, or in not doing one at all
 * when an earlier one failed.
 */

const RECIPIENT: SendableRecipient = {
  id: 'r1',
  workspaceId: 'ws-1',
  campaignId: 'c1',
  email: 'a@example.com',
  mergeData: { first_name: 'Aisha' },
  messageToken: Buffer.alloc(16, 1),
  senderAccountId: 'sa-1',
  providerConnectionId: 'conn-1',
};

function port(overrides: Partial<SendPort> = {}) {
  const calls: string[] = [];
  const commits: { kind: string; input: Record<string, unknown> }[] = [];

  const base: SendPort = {
    async claimForSending(id) {
      calls.push(`claim:${id}`);
      return { attemptToken: 'attempt-1', attemptCount: 1 };
    },
    async loadRecipient() {
      calls.push('load');
      return RECIPIENT;
    },
    async isSuppressed() {
      calls.push('suppression');
      return false;
    },
    async campaignState() {
      calls.push('campaignState');
      return 'sending';
    },
    async commitSent(input) {
      calls.push('commitSent');
      commits.push({ kind: 'sent', input: input as never });
    },
    async commitFailed(input) {
      calls.push('commitFailed');
      commits.push({ kind: 'failed', input: input as never });
    },
    async commitDeferred(input) {
      calls.push('commitDeferred');
      commits.push({ kind: 'deferred', input: input as never });
    },
    async commitUncertain(input) {
      calls.push('commitUncertain');
      commits.push({ kind: 'uncertain', input: input as never });
    },
    async commitSuppressed(input) {
      calls.push('commitSuppressed');
      commits.push({ kind: 'suppressed', input: input as never });
    },
    ...overrides,
  };

  return { port: base, calls, commits };
}

const accepts = vi.fn(
  async (): Promise<ProviderCallResult> => ({
    ok: true,
    providerMessageId: 'pm-1',
    acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
  }),
);

describe('the claim comes first (R1)', () => {
  it('claims before reading anything', async () => {
    // The whole of R1: the first statement is the guarded transition. Reading
    // first and claiming after leaves a window where two workers both read a
    // sendable recipient.
    const { port: p, calls } = port();

    await sendOne('r1', p, accepts);

    expect(calls[0]).toBe('claim:r1');
  });

  it('exits without sending when the claim returns zero rows', async () => {
    // A redelivered job, or one evicted by removeOnComplete and re-enqueued.
    const call = vi.fn(accepts);
    const { port: p, calls } = port({ async claimForSending() {
      return null;
    } });

    const result = await sendOne('r1', p, call);

    expect(result.kind).toBe('skipped_not_claimable');
    expect(call).not.toHaveBeenCalled();
    // Nothing after the claim ran: no read, no suppression lookup, no commit.
    expect(calls).toEqual([]);
  });

  it('sends exactly once when the same recipient is processed twice', async () => {
    // The scenario R1's proving test describes.
    let claimed = false;
    const call = vi.fn(accepts);

    const { port: p } = port({
      async claimForSending() {
        if (claimed) return null;
        claimed = true;
        return { attemptToken: 'attempt-1', attemptCount: 1 };
      },
    });

    await sendOne('r1', p, call);
    await sendOne('r1', p, call);

    expect(call).toHaveBeenCalledTimes(1);
  });

  it('carries the attempt token into every commit', async () => {
    // So a late provider response is matched to the attempt that made it
    // rather than to whatever is current.
    const { port: p, commits } = port();

    await sendOne('r1', p, accepts);

    expect(commits[0]?.input['attemptToken']).toBe('attempt-1');
  });
});

describe('suppression is re-checked at send time (R30)', () => {
  it('does not send to a contact suppressed since the snapshot', async () => {
    // A six-hour campaign otherwise mails someone who unsubscribed in hour
    // two. A legal exposure, not a nicety.
    const call = vi.fn(accepts);
    const { port: p, commits } = port({ async isSuppressed() {
      return true;
    } });

    const result = await sendOne('r1', p, call);

    expect(result.kind).toBe('skipped_suppressed');
    expect(call).not.toHaveBeenCalled();
    expect(commits[0]?.kind).toBe('suppressed');
  });

  it('checks suppression before calling the provider, not after', async () => {
    const { port: p, calls } = port();

    await sendOne('r1', p, accepts);

    expect(calls.indexOf('suppression')).toBeLessThan(calls.indexOf('commitSent'));
  });
});

describe('a campaign that is no longer sending', () => {
  it('stops without sending when the campaign is paused', async () => {
    // A pause must take effect within a dispatcher tick, not a queue drain.
    const call = vi.fn(accepts);
    const { port: p } = port({ async campaignState() {
      return 'paused';
    } });

    const result = await sendOne('r1', p, call);

    expect(result.kind).toBe('skipped_campaign_not_sending');
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps sending while a pause is still taking effect', async () => {
    // `pausing` means in-flight work finishes; stopping there would leave
    // recipients mid-campaign with no way to resume cleanly.
    const call = vi.fn(accepts);
    const { port: p } = port({ async campaignState() {
      return 'pausing';
    } });

    expect((await sendOne('r1', p, call)).kind).toBe('sent');
  });

  it('stops when the campaign was cancelled', async () => {
    const call = vi.fn(accepts);
    const { port: p } = port({ async campaignState() {
      return 'cancelled';
    } });

    await sendOne('r1', p, call);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('what happens after the provider answers', () => {
  it('commits sent, metered and usage together on success', async () => {
    const { port: p, commits } = port();

    const result = await sendOne('r1', p, accepts);

    expect(result.kind).toBe('sent');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      kind: 'sent',
      input: { providerMessageId: 'pm-1', senderAccountId: 'sa-1' },
    });
  });

  it('marks an ambiguous failure uncertain rather than retrying', async () => {
    // D3 and R31. The provider may have accepted it; resending is the one
    // thing that must not happen.
    const { port: p, commits } = port();

    const result = await sendOne('r1', p, async () => ({
      ok: false,
      kind: 'ambiguous',
      errorCode: 'timeout',
      message: 'no response',
    }));

    expect(result.kind).toBe('uncertain');
    expect(commits[0]?.kind).toBe('uncertain');
  });

  it('defers a retryable failure with the provider’s own delay', async () => {
    const { port: p, commits } = port();

    await sendOne('r1', p, async () => ({
      ok: false,
      kind: 'retryable',
      errorCode: 'rate_limited',
      message: 'slow down',
      retryAfterMs: 30_000,
    }));

    expect(commits[0]).toMatchObject({ kind: 'deferred', input: { retryAfterMs: 30_000 } });
  });

  it('fails permanently and suppresses a bad address', async () => {
    const { port: p, commits } = port();

    await sendOne('r1', p, async () => ({
      ok: false,
      kind: 'permanent',
      errorCode: 'invalid_recipient',
      message: 'no such mailbox',
      suppressContact: true,
    }));

    expect(commits[0]).toMatchObject({ kind: 'failed', input: { suppressContact: true } });
  });

  it('does not suppress for rejected content', async () => {
    // A rejected subject line must not remove a contact from every future
    // campaign.
    const { port: p, commits } = port();

    await sendOne('r1', p, async () => ({
      ok: false,
      kind: 'permanent',
      errorCode: 'content_rejected',
      message: 'looks like spam',
    }));

    expect(commits[0]?.input['suppressContact']).toBe(false);
  });

  it('never commits more than once', async () => {
    const { port: p, commits } = port();
    await sendOne('r1', p, accepts);
    expect(commits).toHaveLength(1);
  });
});

describe('a recipient that vanished between claim and load', () => {
  it('fails rather than sending blind', async () => {
    const call = vi.fn(accepts);
    const { port: p, commits } = port({ async loadRecipient() {
      return null;
    } });

    const result = await sendOne('r1', p, call);

    expect(result.kind).toBe('failed');
    expect(call).not.toHaveBeenCalled();
    expect(commits[0]?.input['errorCode']).toBe('recipient_missing');
  });
});

describe('classifying a provider error', () => {
  it('treats a timeout as ambiguous, never as a failure', () => {
    const result = classifyForSend({ kind: 'timeout', retryable: true, message: 'hung' });
    expect(result.kind).toBe('ambiguous');
  });

  it('defers anything the adapter called retryable', () => {
    expect(
      classifyForSend({ kind: 'rate_limited', retryable: true, message: 'slow' }).kind,
    ).toBe('retryable');
  });

  it('suppresses only for a bad recipient', () => {
    const bad = classifyForSend({ kind: 'invalid_recipient', retryable: false, message: 'x' });
    const content = classifyForSend({ kind: 'content_rejected', retryable: false, message: 'x' });

    expect(bad.suppressContact).toBe(true);
    expect(content.suppressContact).toBe(false);
  });

  it('carries Retry-After through rather than guessing', () => {
    const result = classifyForSend({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 45_000,
      message: 'x',
    });

    expect(result.retryAfterMs).toBe(45_000);
  });
});

describe('the Message-ID', () => {
  it('is deterministic for one attempt', () => {
    // So a provider that deduplicates on it catches anything we missed.
    const input = { recipientId: 'r1', attemptToken: 'a1', domain: 'relayd.test' };
    expect(messageIdFor(input)).toBe(messageIdFor(input));
  });

  it('differs between attempts of the same recipient', () => {
    expect(messageIdFor({ recipientId: 'r1', attemptToken: 'a1', domain: 'x.test' })).not.toBe(
      messageIdFor({ recipientId: 'r1', attemptToken: 'a2', domain: 'x.test' }),
    );
  });

  it('is a well-formed Message-ID', () => {
    const id = messageIdFor({ recipientId: 'r1', attemptToken: 'a1', domain: 'relayd.test' });
    expect(id).toMatch(/^<[^@<>]+@[^@<>]+>$/u);
  });
});
