import { createHmac, timingSafeEqual } from 'node:crypto';
import { providerError } from '../errors.js';
import type {
  EmailProviderAdapter,
  ErrorKind,
  NormalisedEmailEvent,
  OutboundMessage,
  ProviderCapabilities,
  ProviderCredentials,
  QuotaSnapshot,
  SendOutcome,
  SenderIdentitySnapshot,
  VerificationResult,
} from '../port.js';

/**
 * A deterministic adapter with scriptable failures.
 *
 * Used two ways. Everything downstream of the port — the router, the send
 * worker, the campaign engine — tests against this instead of a real provider,
 * so those tests are fast and describe behaviour rather than HTTP. And the
 * contract suite runs against it, which proves the suite itself is capable of
 * passing before any real adapter is measured by it.
 *
 * Failures are scripted by recipient id so a test can say "the third one is
 * rate limited" without stubbing a transport.
 */

export interface FakeProviderScript {
  /** Fail these recipient ids with this kind, in order of the map. */
  readonly failures?: Readonly<Record<string, ErrorKind>>;
  /** Refuse to verify. */
  readonly verificationFails?: boolean;
  readonly quota?: QuotaSnapshot | null;
  readonly identities?: readonly SenderIdentitySnapshot[];
  /** Return outcomes in reverse, as a real batch API is entitled to. */
  readonly shuffleBatch?: boolean;
  /** Never resolve, so a timeout can be exercised. */
  readonly hang?: boolean;
}

export interface FakeProvider extends EmailProviderAdapter {
  /** Every message the adapter was asked to send, in order. */
  readonly sent: OutboundMessage[];
  /** How many times each method was called. */
  readonly calls: Record<string, number>;
  reset(): void;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxBatchSize: 50,
  supportsWebhooks: true,
  supportsTracking: false,
  supportsCustomHeaders: true,
  supportsScheduling: false,
  supportsSuppressionSync: false,
  returnsMessageId: true,
  reportsQuota: true,
  maxRecipientsPerMessage: 1,
  maxMessageBytes: 10 * 1024 * 1024,
};

/** The signature scheme the fake uses: HMAC-SHA256 of the raw body, hex. */
export function signFakeWebhook(raw: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

export function createFakeProvider(
  script: FakeProviderScript = {},
  capabilities: Partial<ProviderCapabilities> = {},
): FakeProvider {
  const sent: OutboundMessage[] = [];
  const calls: Record<string, number> = {};

  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };

  const outcomeFor = (message: OutboundMessage): SendOutcome => {
    const kind = script.failures?.[message.recipientId];

    if (kind !== undefined) {
      return {
        ok: false,
        recipientId: message.recipientId,
        error: providerError(kind, `scripted ${kind}`),
      };
    }

    return {
      ok: true,
      recipientId: message.recipientId,
      providerMessageId: `fake-${message.recipientId}`,
      acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
  };

  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  return {
    type: 'sendgrid',
    capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
    sent,
    calls,

    reset() {
      sent.length = 0;
      for (const key of Object.keys(calls)) delete calls[key];
    },

    async verifyConnection(_creds: ProviderCredentials): Promise<VerificationResult> {
      count('verifyConnection');
      if (script.hang === true) return never();

      return script.verificationFails === true
        ? { ok: false, error: providerError('auth_failed', 'scripted verification failure') }
        : { ok: true, details: { account: 'fake' } };
    },

    async getQuota(): Promise<QuotaSnapshot | null> {
      count('getQuota');
      return script.quota ?? null;
    },

    async listVerifiedIdentities(): Promise<SenderIdentitySnapshot[]> {
      count('listVerifiedIdentities');
      return [...(script.identities ?? [])];
    },

    async send(_creds, message): Promise<SendOutcome> {
      count('send');
      if (script.hang === true) return never();
      sent.push(message);
      return outcomeFor(message);
    },

    async sendBatch(_creds, messages): Promise<SendOutcome[]> {
      count('sendBatch');
      if (script.hang === true) return never();

      sent.push(...messages);
      const outcomes = messages.map(outcomeFor);
      return script.shuffleBatch === true ? outcomes.reverse() : outcomes;
    },

    verifyWebhookSignature(raw, headers, secret) {
      count('verifyWebhookSignature');

      const provided = headers['x-fake-signature'] ?? '';
      const expected = signFakeWebhook(raw, secret);

      // Constant-time, and length-checked first because timingSafeEqual
      // throws on a length mismatch — which would itself be an oracle.
      const a = Buffer.from(provided, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    },

    parseWebhook(raw): NormalisedEmailEvent[] {
      count('parseWebhook');

      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      const events = Array.isArray(parsed) ? parsed : [parsed];

      return events.map((event) => {
        const record = event as Record<string, unknown>;
        return {
          providerEventId: String(record['id'] ?? ''),
          type: (record['type'] ?? 'delivered') as NormalisedEmailEvent['type'],
          recipientEmail: String(record['email'] ?? ''),
          occurredAt: new Date(String(record['at'] ?? '2026-01-01T00:00:00.000Z')),
          raw: event,
          ...(record['messageId'] === undefined
            ? {}
            : { providerMessageId: String(record['messageId']) }),
          ...(record['bounceClass'] === undefined
            ? {}
            : { bounceClass: record['bounceClass'] as 'hard' | 'soft' | 'block' }),
        };
      });
    },
  };
}
