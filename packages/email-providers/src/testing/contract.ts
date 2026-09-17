import { describe, expect, it } from 'vitest';
import { ERROR_POLICY } from '../port.js';
import { sendWithLimits } from '../send-with-limits.js';
import type {
  EmailProviderAdapter,
  ErrorKind,
  OutboundMessage,
  ProviderCredentials,
} from '../port.js';

/**
 * The contract suite (docs/07 §"Adapter file layout").
 *
 * One shared set of cases that every adapter must pass unchanged. This is the
 * mechanism that keeps the abstraction honest: without it "implements
 * EmailProviderAdapter" means only that the method names line up, and the
 * differences that actually matter — how a 429 is classified, whether a batch
 * response is correlated, whether a bad signature is rejected — go unnoticed
 * until a campaign misbehaves in production.
 *
 * An adapter provides a harness that can script provider responses. How it
 * does that is its own business: a fake HTTP layer, a recorded fixture, or a
 * sandbox account in CI. The suite only asks for the ability to say "make the
 * next call fail like this" and "sign this payload as the provider would".
 */

export interface ContractHarness {
  readonly name: string;
  readonly adapter: EmailProviderAdapter;
  readonly credentials: ProviderCredentials;

  /**
   * Arranges for the next send to fail in the way a provider expresses this
   * kind. Return false for a kind this provider genuinely cannot produce —
   * SMTP has no quota response, for instance — and the case is skipped rather
   * than faked into passing.
   */
  scriptFailure(kind: ErrorKind): boolean | Promise<boolean>;

  /** Arranges for the next call to never respond. */
  scriptHang?(): void;

  /** Restores the harness between cases. */
  reset(): void | Promise<void>;

  /** A webhook body this provider could really post, and its valid signature. */
  webhook?: {
    body: Buffer;
    headers: Record<string, string>;
    secret: string;
    /** How many events `body` should parse into. */
    expectedEvents: number;
    /**
     * Variants that must be rejected, each named.
     *
     * Supplied by the adapter because only it knows what tampering means for
     * its scheme. A header-signed scheme over raw bytes and SNS — which signs
     * a canonical subset of fields inside the body — are broken in different
     * ways, and a contract that assumed either one would be asserting nothing
     * against the other.
     */
    invalid: { label: string; body: Buffer; headers: Record<string, string> }[];
  };
}

export function outboundMessage(id: string): OutboundMessage {
  return {
    recipientId: id,
    to: { email: `${id}@example.com`, name: `Recipient ${id}` },
    from: { email: 'hello@relayd.test', name: 'Relayd' },
    subject: 'A subject',
    html: '<p>Hello</p>',
    text: 'Hello',
    headers: { 'X-Relayd-Recipient': id },
    listUnsubscribe: {
      url: `https://relayd.test/u/${id}`,
      mailto: 'mailto:unsubscribe@relayd.test',
      oneClick: true,
    },
  };
}

const ALL_KINDS: readonly ErrorKind[] = [
  'auth_failed',
  'rate_limited',
  'quota_exceeded',
  'invalid_recipient',
  'invalid_sender',
  'content_rejected',
  'message_too_large',
  'provider_unavailable',
  'timeout',
  'unknown',
];

/** The canary from INVARIANTS R22. */
const CANARY = 'SECRET-CANARY-9f3a';

export function runProviderContract(makeHarness: () => ContractHarness | Promise<ContractHarness>): void {
  const withHarness = async (
    body: (harness: ContractHarness) => Promise<void>,
  ): Promise<void> => {
    const harness = await makeHarness();
    try {
      await body(harness);
    } finally {
      await harness.reset();
    }
  };

  describe('capabilities', () => {
    it('declares a usable batch size', async () => {
      await withHarness(async ({ adapter }) => {
        expect(adapter.capabilities.maxBatchSize).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(adapter.capabilities.maxBatchSize)).toBe(true);
      });
    });

    it('declares a message size limit that is not zero', async () => {
      // The worker refuses to build a message larger than this. Zero would
      // reject everything; absent would reject nothing.
      await withHarness(async ({ adapter }) => {
        expect(adapter.capabilities.maxMessageBytes).toBeGreaterThan(1024);
      });
    });

    it('declares a provider type matching its identity', async () => {
      await withHarness(async ({ adapter }) => {
        expect(typeof adapter.type).toBe('string');
        expect(adapter.type.length).toBeGreaterThan(0);
      });
    });

    it('only claims webhook support if it can verify a signature', async () => {
      // An adapter claiming webhooks without signature verification would
      // accept anything anyone posted to its endpoint.
      await withHarness(async ({ adapter }) => {
        if (!adapter.capabilities.supportsWebhooks) return;
        expect(typeof adapter.verifyWebhookSignature).toBe('function');
        expect(typeof adapter.parseWebhook).toBe('function');
      });
    });
  });

  describe('sending', () => {
    it('accepts a message and echoes the recipient id', async () => {
      await withHarness(async ({ adapter, credentials }) => {
        const outcome = await adapter.send(credentials, outboundMessage('r1'));

        expect(outcome.recipientId).toBe('r1');

        if (outcome.ok) {
          // Both halves matter: an Invalid Date is still a Date instance, so
          // a provider timestamp that failed to parse passes the first check
          // and lands in accepted_at as NaN.
          expect(outcome.acceptedAt).toBeInstanceOf(Date);
          expect(Number.isNaN(outcome.acceptedAt.getTime())).toBe(false);
        }
      });
    });

    it('returns one outcome per message from a batch', async () => {
      await withHarness(async ({ adapter, credentials }) => {
        const messages = ['a', 'b', 'c'].map(outboundMessage);
        const outcomes = await adapter.sendBatch(credentials, messages);

        expect(outcomes).toHaveLength(3);
        expect(new Set(outcomes.map((o) => o.recipientId))).toEqual(new Set(['a', 'b', 'c']));
      });
    });

    it('correlates by recipient id, not by position', async () => {
      // Through the wrapper, which is what production uses and which is
      // responsible for putting an arbitrary-order response back in order.
      await withHarness(async ({ adapter, credentials }) => {
        const messages = ['a', 'b', 'c', 'd'].map(outboundMessage);
        const outcomes = await sendWithLimits(adapter, credentials, messages, {
          workspaceId: 'ws-contract',
          senderAccountId: 'sa-contract',
        });

        expect(outcomes.map((o) => o.recipientId)).toEqual(['a', 'b', 'c', 'd']);
      });
    });

    it('never reports a provider message id on a failure', async () => {
      await withHarness(async (harness) => {
        if (!(await harness.scriptFailure('invalid_recipient'))) return;

        const outcome = await harness.adapter.send(harness.credentials, outboundMessage('r1'));
        expect(outcome.ok).toBe(false);
        expect('providerMessageId' in outcome).toBe(false);
      });
    });

    it('sends nothing for an empty batch', async () => {
      await withHarness(async ({ adapter, credentials }) => {
        expect(await adapter.sendBatch(credentials, [])).toEqual([]);
      });
    });
  });

  describe('error classification', () => {
    for (const kind of ALL_KINDS) {
      it(`reports ${kind} as ${kind}, with the policy's retryable and affects`, async () => {
        await withHarness(async (harness) => {
          // A provider that cannot express this kind skips rather than
          // pretending: a faked case proves nothing.
          if (!(await harness.scriptFailure(kind))) return;

          const outcome = await harness.adapter.send(harness.credentials, outboundMessage('r1'));

          expect(outcome.ok).toBe(false);
          if (outcome.ok) return;

          expect(outcome.error.kind).toBe(kind);
          expect(outcome.error.retryable).toBe(ERROR_POLICY[kind].retryable);
          expect(outcome.error.affects).toBe(ERROR_POLICY[kind].affects);
        });
      });
    }

    it('gives a message that is not empty and not a stack trace', async () => {
      await withHarness(async (harness) => {
        if (!(await harness.scriptFailure('auth_failed'))) return;

        const outcome = await harness.adapter.send(harness.credentials, outboundMessage('r1'));
        if (outcome.ok) return;

        expect(outcome.error.message.length).toBeGreaterThan(0);
        expect(outcome.error.message).not.toContain('    at ');
      });
    });

    it('leaks no credential through a failure', async () => {
      // INVARIANTS R22. The harness is constructed with the canary as its
      // credential, so anything echoed from the request shows up here.
      await withHarness(async (harness) => {
        if (!(await harness.scriptFailure('auth_failed'))) return;

        const outcome = await harness.adapter.send(harness.credentials, outboundMessage('r1'));
        expect(JSON.stringify(outcome)).not.toContain(CANARY);
      });
    });

    it('classifies a hang as a timeout, through the wrapper', async () => {
      await withHarness(async (harness) => {
        if (harness.scriptHang === undefined) return;
        harness.scriptHang();

        const outcomes = await sendWithLimits(
          harness.adapter,
          harness.credentials,
          [outboundMessage('r1')],
          { workspaceId: 'ws', senderAccountId: 'sa', timeoutMs: 25 },
        );

        expect(outcomes[0]?.ok).toBe(false);
        expect(outcomes[0]?.ok === false && outcomes[0].error.kind).toBe('timeout');
      });
    });
  });

  describe('verification', () => {
    it('reports success or a typed error, never a throw', async () => {
      await withHarness(async ({ adapter, credentials }) => {
        const result = await adapter.verifyConnection(credentials);
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) expect(result.error?.kind).toBeTruthy();
      });
    });

    it('reports a wrong credential as auth_failed, not as a crash', async () => {
      await withHarness(async (harness) => {
        if (!(await harness.scriptFailure('auth_failed'))) return;

        const result = await harness.adapter.verifyConnection(harness.credentials);
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('auth_failed');
        expect(JSON.stringify(result)).not.toContain(CANARY);
      });
    });

    it('returns a quota snapshot or null, never a partial one', async () => {
      await withHarness(async ({ adapter, credentials }) => {
        const quota = await adapter.getQuota(credentials);
        if (quota === null) return;
        expect(quota.checkedAt).toBeInstanceOf(Date);
      });
    });

    it('lists identities with a status the schema allows', async () => {
      await withHarness(async ({ adapter, credentials }) => {
        for (const identity of await adapter.listVerifiedIdentities(credentials)) {
          expect(['domain', 'email']).toContain(identity.kind);
          expect(['pending', 'verified', 'failed', 'expired']).toContain(identity.status);
        }
      });
    });
  });

  describe('webhooks', () => {
    it('accepts a correctly signed payload', async () => {
      await withHarness(async ({ adapter, webhook }) => {
        if (webhook === undefined) return;
        expect(adapter.verifyWebhookSignature(webhook.body, webhook.headers, webhook.secret)).toBe(
          true,
        );
      });
    });

    it('rejects a payload signed with another connection\'s secret', async () => {
      // This is the F4 attack in miniature: the signature must be checked
      // against this connection's own secret, so a valid signature from
      // somewhere else is worthless here.
      await withHarness(async ({ adapter, webhook }) => {
        if (webhook === undefined) return;
        expect(
          adapter.verifyWebhookSignature(webhook.body, webhook.headers, 'a-different-secret'),
        ).toBe(false);
      });
    });

    it('rejects every variant the adapter says is invalid', async () => {
      await withHarness(async ({ adapter, webhook }) => {
        if (webhook === undefined) return;

        // At least tampering and a missing signature, or the adapter is not
        // really being asked anything.
        expect(webhook.invalid.length).toBeGreaterThanOrEqual(2);

        for (const variant of webhook.invalid) {
          expect(
            adapter.verifyWebhookSignature(variant.body, variant.headers, webhook.secret),
            variant.label,
          ).toBe(false);
        }
      });
    });

    it('parses the payload into normalised events', async () => {
      await withHarness(async ({ adapter, webhook }) => {
        if (webhook === undefined) return;

        const events = adapter.parseWebhook(webhook.body, webhook.headers);
        expect(events).toHaveLength(webhook.expectedEvents);

        for (const event of events) {
          expect(event.providerEventId.length).toBeGreaterThan(0);
          expect(event.occurredAt).toBeInstanceOf(Date);
          expect(Number.isNaN(event.occurredAt.getTime())).toBe(false);
        }
      });
    });

    it('parses a duplicate delivery to the same event ids', async () => {
      // The inbox deduplicates on (connection, providerEventId). If parsing
      // the same bytes twice produced different ids, every redelivery would
      // be applied again — and every provider redelivers.
      await withHarness(async ({ adapter, webhook }) => {
        if (webhook === undefined) return;

        const first = adapter.parseWebhook(webhook.body, webhook.headers);
        const second = adapter.parseWebhook(webhook.body, webhook.headers);

        expect(second.map((e) => e.providerEventId)).toEqual(first.map((e) => e.providerEventId));
      });
    });

    it('gives every event a non-empty dedupe id', async () => {
      await withHarness(async ({ adapter, webhook }) => {
        if (webhook === undefined) return;

        for (const event of adapter.parseWebhook(webhook.body, webhook.headers)) {
          expect(event.providerEventId.trim()).not.toBe('');
        }
      });
    });
  });
}
