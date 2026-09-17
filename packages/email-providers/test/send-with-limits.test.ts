import { describe, expect, it, vi } from 'vitest';
import { sendWithLimits, type RateLimiter } from '../src/send-with-limits.js';
import type {
  EmailProviderAdapter,
  OutboundMessage,
  ProviderCapabilities,
  ProviderCredentials,
} from '../src/port.js';

const CREDS: ProviderCredentials = { type: 'sendgrid', apiKey: 'sg-test' };

function message(id: string): OutboundMessage {
  return {
    recipientId: id,
    to: { email: `${id}@example.com` },
    from: { email: 'hi@relayd.test', name: 'Relayd' },
    subject: 'Hello',
    html: '<p>Hello</p>',
    text: 'Hello',
    headers: {},
    listUnsubscribe: { url: 'https://relayd.test/u/abc', oneClick: true },
  };
}

const CAPABILITIES: ProviderCapabilities = {
  maxBatchSize: 10,
  supportsWebhooks: true,
  supportsTracking: false,
  supportsCustomHeaders: true,
  supportsScheduling: false,
  supportsSuppressionSync: false,
  returnsMessageId: true,
  reportsQuota: false,
  maxRecipientsPerMessage: 1,
  maxMessageBytes: 10_000_000,
};

function fakeAdapter(overrides: Partial<EmailProviderAdapter> = {}): EmailProviderAdapter {
  return {
    type: 'sendgrid',
    capabilities: CAPABILITIES,
    verifyConnection: async () => ({ ok: true }),
    getQuota: async () => null,
    listVerifiedIdentities: async () => [],
    send: async (_creds, msg) => ({
      ok: true,
      recipientId: msg.recipientId,
      providerMessageId: `pm-${msg.recipientId}`,
      acceptedAt: new Date(),
    }),
    sendBatch: async (_creds, msgs) =>
      msgs.map((msg) => ({
        ok: true as const,
        recipientId: msg.recipientId,
        providerMessageId: `pm-${msg.recipientId}`,
        acceptedAt: new Date(),
      })),
    verifyWebhookSignature: () => true,
    parseWebhook: () => [],
    ...overrides,
  };
}

const context = { workspaceId: 'ws-1', senderAccountId: 'sa-1' };

describe('batching', () => {
  it('splits to the size the adapter declares', async () => {
    const sendBatch = vi.fn(async (_c: ProviderCredentials, msgs: readonly OutboundMessage[]) =>
      msgs.map((msg) => ({
        ok: true as const,
        recipientId: msg.recipientId,
        providerMessageId: null,
        acceptedAt: new Date(),
      })),
    );

    const adapter = fakeAdapter({ capabilities: { ...CAPABILITIES, maxBatchSize: 3 }, sendBatch });
    const messages = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(message);

    await sendWithLimits(adapter, CREDS, messages, context);

    expect(sendBatch.mock.calls.map((call) => call[1].length)).toEqual([3, 3, 1]);
  });

  it('uses send rather than sendBatch for a single message', async () => {
    // SMTP declares maxBatchSize 1 and has no batch API at all.
    const send = vi.fn(fakeAdapter().send);
    const sendBatch = vi.fn(fakeAdapter().sendBatch);
    const adapter = fakeAdapter({
      capabilities: { ...CAPABILITIES, maxBatchSize: 1 },
      send,
      sendBatch,
    });

    await sendWithLimits(adapter, CREDS, [message('a'), message('b')], context);

    expect(send).toHaveBeenCalledTimes(2);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('treats a nonsense batch size as one', async () => {
    const adapter = fakeAdapter({ capabilities: { ...CAPABILITIES, maxBatchSize: 0 } });
    const outcomes = await sendWithLimits(adapter, CREDS, [message('a')], context);
    expect(outcomes).toHaveLength(1);
  });
});

describe('correlation', () => {
  it('returns one outcome per message, in the order given', async () => {
    const messages = ['a', 'b', 'c'].map(message);
    const outcomes = await sendWithLimits(fakeAdapter(), CREDS, messages, context);

    expect(outcomes.map((outcome) => outcome.recipientId)).toEqual(['a', 'b', 'c']);
  });

  it('reorders a batch response that came back shuffled', async () => {
    // Batch APIs return results in arbitrary order, which is exactly why
    // recipientId is on the outcome.
    const adapter = fakeAdapter({
      sendBatch: async (_creds, msgs) =>
        [...msgs].reverse().map((msg) => ({
          ok: true as const,
          recipientId: msg.recipientId,
          providerMessageId: `pm-${msg.recipientId}`,
          acceptedAt: new Date(),
        })),
    });

    const outcomes = await sendWithLimits(adapter, CREDS, ['a', 'b', 'c'].map(message), context);
    expect(outcomes.map((o) => o.recipientId)).toEqual(['a', 'b', 'c']);
  });

  it('invents a failure for a message the adapter said nothing about', async () => {
    // A missing outcome means a recipient stuck in `sending` forever, waiting
    // for a reconciler that has nothing to reconcile against.
    const adapter = fakeAdapter({
      sendBatch: async (_creds, msgs) =>
        msgs.slice(0, 1).map((msg) => ({
          ok: true as const,
          recipientId: msg.recipientId,
          providerMessageId: null,
          acceptedAt: new Date(),
        })),
    });

    const outcomes = await sendWithLimits(adapter, CREDS, ['a', 'b'].map(message), context);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]?.ok).toBe(false);
    expect(outcomes[1]?.ok === false && outcomes[1].error.kind).toBe('unknown');
  });

  it('sends nothing for an empty list', async () => {
    const sendBatch = vi.fn(fakeAdapter().sendBatch);
    const outcomes = await sendWithLimits(fakeAdapter({ sendBatch }), CREDS, [], context);

    expect(outcomes).toEqual([]);
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

describe('limits', () => {
  it('does not call the adapter when the limiter refuses', async () => {
    const sendBatch = vi.fn(fakeAdapter().sendBatch);
    const limiter: RateLimiter = {
      acquire: async () => ({ allowed: false, retryAfterMs: 5000, reason: 'rate' }),
    };

    const outcomes = await sendWithLimits(
      fakeAdapter({ sendBatch }),
      CREDS,
      ['a', 'b'].map(message),
      { ...context, limiter },
    );

    expect(sendBatch).not.toHaveBeenCalled();
    expect(outcomes.every((o) => o.ok === false)).toBe(true);
    expect(outcomes[0]?.ok === false && outcomes[0].error.kind).toBe('rate_limited');
    expect(outcomes[0]?.ok === false && outcomes[0].error.retryAfterMs).toBe(5000);
  });

  it('reports an exhausted quota separately from a rate limit', async () => {
    // Different remedies: one waits, the other waits until the daily reset.
    const limiter: RateLimiter = {
      acquire: async () => ({ allowed: false, retryAfterMs: 3_600_000, reason: 'quota' }),
    };

    const [outcome] = await sendWithLimits(fakeAdapter(), CREDS, [message('a')], {
      ...context,
      limiter,
    });

    expect(outcome?.ok === false && outcome.error.kind).toBe('quota_exceeded');
  });

  it('fails closed when the limiter cannot be reached', async () => {
    // CLAUDE.md section 9: Redis unreachable means do not send. An open
    // failure here sends an unbounded campaign at a provider that will ban
    // the customer for it.
    const sendBatch = vi.fn(fakeAdapter().sendBatch);
    const limiter: RateLimiter = {
      acquire: async () => {
        throw new Error('Redis is unreachable');
      },
    };

    const outcomes = await sendWithLimits(fakeAdapter({ sendBatch }), CREDS, [message('a')], {
      ...context,
      limiter,
    });

    expect(sendBatch).not.toHaveBeenCalled();
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.ok === false && outcomes[0].error.retryable).toBe(true);
  });

  it('asks for permission once per batch, not once per message', async () => {
    const acquire = vi.fn(
      async (_input: { workspaceId: string; senderAccountId: string; count: number }) => ({
        allowed: true as const,
      }),
    );
    const adapter = fakeAdapter({ capabilities: { ...CAPABILITIES, maxBatchSize: 5 } });

    await sendWithLimits(adapter, CREDS, Array.from({ length: 12 }, (_, i) => message(`m${i}`)), {
      ...context,
      limiter: { acquire },
    });

    expect(acquire).toHaveBeenCalledTimes(3);
    expect(acquire.mock.calls.map((call) => call[0].count)).toEqual([5, 5, 2]);
  });
});

describe('failures', () => {
  it('turns a throw into a typed error for every message in the batch', async () => {
    const adapter = fakeAdapter({
      sendBatch: async () => {
        throw Object.assign(new Error('boom'), { status: 503 });
      },
    });

    const outcomes = await sendWithLimits(adapter, CREDS, ['a', 'b'].map(message), context);

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.error.kind).toBe('provider_unavailable');
    }
  });

  it('classifies a hung provider as a timeout, not a failure', async () => {
    // Ambiguous on purpose: the provider may have accepted it. The reconciler
    // resolves it rather than the send path guessing.
    const adapter = fakeAdapter({
      sendBatch: () => new Promise(() => undefined),
    });

    const outcomes = await sendWithLimits(adapter, CREDS, [message('a')], {
      ...context,
      timeoutMs: 20,
    });

    expect(outcomes[0]?.ok === false && outcomes[0].error.kind).toBe('timeout');
  });

  it('keeps the successful batches when a later one fails', async () => {
    let call = 0;
    const adapter = fakeAdapter({
      capabilities: { ...CAPABILITIES, maxBatchSize: 2 },
      sendBatch: async (_creds, msgs) => {
        call += 1;
        if (call === 2) throw Object.assign(new Error('nope'), { status: 500 });
        return msgs.map((msg) => ({
          ok: true as const,
          recipientId: msg.recipientId,
          providerMessageId: null,
          acceptedAt: new Date(),
        }));
      },
    });

    const outcomes = await sendWithLimits(adapter, CREDS, ['a', 'b', 'c', 'd'].map(message), context);

    expect(outcomes.map((o) => o.ok)).toEqual([true, true, false, false]);
  });

  it('never lets a credential out through a send failure', async () => {
    const adapter = fakeAdapter({
      sendBatch: async () => {
        throw Object.assign(new Error('auth failed'), {
          status: 401,
          config: { headers: { Authorization: 'Bearer SECRET-CANARY-9f3a' } },
        });
      },
    });

    const outcomes = await sendWithLimits(adapter, CREDS, [message('a')], context);
    expect(JSON.stringify(outcomes)).not.toContain('SECRET-CANARY-9f3a');
  });
});
