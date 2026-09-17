import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSesAdapter, parseSnsNotification } from '../src/adapters/ses/index.js';
import { classifySesError } from '../src/adapters/ses/errors.js';
import {
  canonicalString,
  isAmazonCertificateUrl,
  verifySnsSignature,
} from '../src/adapters/ses/sns.js';
import { runProviderContract, outboundMessage, type ContractHarness } from '../src/testing/contract.js';
import type { ErrorKind, ProviderCredentials } from '../src/port.js';

/**
 * SES, against a scripted client.
 *
 * No AWS account and no network. The adapter takes a client factory, so the
 * contract runs against a client that throws whatever SES would throw. What
 * this proves is the classification and the shapes — which is where provider
 * quirks live — and not that the SDK call itself is well-formed. That needs a
 * sandbox account, which CI gets from Phase 3's gate onward.
 */

const CREDENTIALS: ProviderCredentials = {
  type: 'ses',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'SECRET-CANARY-9f3a',
  region: 'eu-west-1',
};

/** An SDK-shaped error: name, message, $metadata, sometimes $retryable. */
function sesError(name: string, message: string, status?: number, retryable = false): Error {
  return Object.assign(new Error(message), {
    name,
    $metadata: status === undefined ? {} : { httpStatusCode: status },
    ...(retryable ? { $retryable: { throttling: false } } : {}),
  });
}

/** How SES expresses each of our error kinds. */
const SCRIPTED: Partial<Record<ErrorKind, () => Error>> = {
  auth_failed: () => sesError('UnrecognizedClientException', 'The security token included in the request is invalid', 403),
  rate_limited: () => sesError('ThrottlingException', 'Maximum sending rate exceeded', 429),
  quota_exceeded: () => sesError('SendingQuotaExceededException', 'Daily message quota exceeded', 400),
  invalid_recipient: () => sesError('MessageRejected', 'Invalid email address recipient address rejected', 400),
  invalid_sender: () => sesError('MailFromDomainNotVerifiedException', 'MAIL FROM domain is not verified', 400),
  content_rejected: () => sesError('MessageRejected', 'Email content contains a virus', 400),
  message_too_large: () => sesError('BadRequestException', 'Message too long', 413),
  provider_unavailable: () => sesError('ServiceUnavailable', 'Service is unavailable', 503),
  timeout: () => sesError('TimeoutError', 'socket hang up', undefined),
  unknown: () => sesError('SomethingNobodyAnticipated', 'an unexpected condition'),
};

const ACCOUNT_RESPONSE = {
  ProductionAccessEnabled: true,
  SendingEnabled: true,
  EnforcementStatus: 'HEALTHY',
  SendQuota: { Max24HourSend: 50_000, SentLast24Hours: 120, MaxSendRate: 14 },
};

const TOPIC_ARN = 'arn:aws:sns:eu-west-1:123456789012:relayd-events';

/**
 * A real key pair, so the signature is really verified.
 *
 * In production `secret` is the PEM certificate the ingest layer fetched from
 * SNS and cached; createVerify accepts a bare public key just the same, and
 * the code path under test is identical.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERTIFICATE = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const SES_BOUNCE = JSON.stringify({
  notificationType: 'Bounce',
  mail: { messageId: 'ses-msg-1', timestamp: '2026-01-01T10:00:00.000Z' },
  bounce: {
    bounceType: 'Permanent',
    timestamp: '2026-01-01T10:00:05.000Z',
    bouncedRecipients: [{ emailAddress: 'bounced@example.com' }],
  },
});

/** Signs an envelope the way SNS does, so the fixture is genuinely valid. */
function signSns(envelope: Record<string, unknown>): Buffer {
  const canonical = canonicalString({ ...envelope, Signature: undefined } as never);
  const signer = createSign('RSA-SHA256');
  signer.update(canonical ?? '', 'utf8');
  signer.end();

  return Buffer.from(
    JSON.stringify({ ...envelope, Signature: signer.sign(privateKey, 'base64') }),
    'utf8',
  );
}

const SNS_ENVELOPE = {
  Type: 'Notification',
  MessageId: 'sns-1',
  TopicArn: TOPIC_ARN,
  Message: SES_BOUNCE,
  Timestamp: '2026-01-01T10:00:06.000Z',
  SignatureVersion: '2',
  SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem',
};

const SNS_BODY = signSns(SNS_ENVELOPE);

/** The signed body with fields overwritten afterwards, leaving the signature stale. */
function withEnvelope(changes: Record<string, unknown>): Buffer {
  const parsed = JSON.parse(SNS_BODY.toString('utf8')) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...parsed, ...changes }), 'utf8');
}

describe('ses adapter', () => {
  runProviderContract((): ContractHarness => {
    let failure: ErrorKind | null = null;
    let hang = false;

    const adapter = createSesAdapter(() => ({
      async send(command: unknown) {
        if (hang) return new Promise(() => undefined);

        if (failure !== null) {
          const make = SCRIPTED[failure];
          if (make !== undefined) throw make();
        }

        // GetAccountCommand and SendEmailCommand are distinguished by the
        // input the command carries.
        const input = (command as { input?: Record<string, unknown> }).input ?? {};
        if ('FromEmailAddress' in input) return { MessageId: 'ses-msg-1' };
        if ('PageSize' in input) return { EmailIdentities: [] };
        return ACCOUNT_RESPONSE;
      },
    }));

    return {
      name: 'ses',
      adapter,
      credentials: CREDENTIALS,

      scriptFailure(kind: ErrorKind): boolean {
        if (SCRIPTED[kind] === undefined) return false;
        failure = kind;
        return true;
      },

      scriptHang(): void {
        hang = true;
      },

      reset(): void {
        failure = null;
        hang = false;
      },

      webhook: {
        body: SNS_BODY,
        headers: { 'x-amz-sns-message-type': 'Notification' },
        secret: CERTIFICATE,
        expectedEvents: 1,
        invalid: [
          {
            // The attack that matters: the signed Message field replaced, so
            // a bounce is attributed to a different address.
            label: 'the signed Message replaced after signing',
            body: withEnvelope({
              Message: SES_BOUNCE.replace('bounced@example.com', 'victim@example.com'),
            }),
            headers: {},
          },
          { label: 'no Signature field', body: Buffer.from(JSON.stringify(SNS_ENVELOPE)), headers: {} },
          { label: 'an unknown SignatureVersion', body: withEnvelope({ SignatureVersion: '99' }), headers: {} },
          { label: 'a different TopicArn than was signed', body: withEnvelope({ TopicArn: 'arn:aws:sns:us-east-1:999:other' }), headers: {} },
          { label: 'not JSON at all', body: Buffer.from('nonsense'), headers: {} },
        ],
      },
    };
  });
});

describe('ses error classification', () => {
  it('treats a MessageRejected about the address as a recipient problem', () => {
    // The consequence of getting this wrong is concrete: classified as
    // content, the address is never suppressed, so every future campaign
    // retries it and the account's bounce rate pays for it.
    const error = classifySesError(
      sesError('MessageRejected', 'Invalid email address: recipient address rejected', 400),
    );

    expect(error.kind).toBe('invalid_recipient');
    expect(error.affects).toBe('message');
    expect(error.retryable).toBe(false);
  });

  it('treats a MessageRejected about the sender as a sender problem', () => {
    const error = classifySesError(
      sesError(
        'MessageRejected',
        'Email address is not verified. The following identities failed the check: hi@example.com',
        400,
      ),
    );

    expect(error.kind).toBe('invalid_sender');
  });

  it('treats any other MessageRejected as content', () => {
    const error = classifySesError(sesError('MessageRejected', 'Email contains a virus', 400));
    expect(error.kind).toBe('content_rejected');
  });

  it('separates a rate limit from an exhausted quota', () => {
    // Different remedies: one backs off for seconds, the other waits for the
    // daily reset.
    expect(classifySesError(sesError('ThrottlingException', 'slow down', 429)).kind).toBe(
      'rate_limited',
    );
    expect(
      classifySesError(sesError('SendingQuotaExceededException', 'daily quota', 400)).kind,
    ).toBe('quota_exceeded');
  });

  it('never reports an auth failure as retryable', () => {
    const error = classifySesError(sesError('InvalidClientTokenId', 'bad key', 403));
    expect(error.retryable).toBe(false);
    expect(error.affects).toBe('connection');
  });

  it('reads the status from $metadata when the name is unfamiliar', () => {
    expect(classifySesError(sesError('WhoKnows', 'hmm', 503)).kind).toBe('provider_unavailable');
  });

  it('leaks no credential from an error that quotes the request', () => {
    const error = classifySesError(
      sesError('UnrecognizedClientException', 'key AKIAIOSFODNN7EXAMPLE secret=SECRET-CANARY-9f3a', 403),
    );

    expect(JSON.stringify(error)).not.toContain('SECRET-CANARY-9f3a');
    expect(JSON.stringify(error)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('sns notifications', () => {
  it('unwraps the double-encoded envelope', () => {
    const [event] = parseSnsNotification(SNS_BODY);

    expect(event?.type).toBe('bounce');
    expect(event?.bounceClass).toBe('hard');
    expect(event?.recipientEmail).toBe('bounced@example.com');
    expect(event?.providerMessageId).toBe('ses-msg-1');
  });

  it('classifies a transient bounce as soft, not hard', () => {
    // A hard bounce suppresses the contact permanently. A full mailbox is not
    // grounds for that.
    const body = Buffer.from(
      JSON.stringify({
        Type: 'Notification',
        Message: JSON.stringify({
          notificationType: 'Bounce',
          mail: { messageId: 'm1' },
          bounce: {
            bounceType: 'Transient',
            timestamp: '2026-01-01T10:00:00.000Z',
            bouncedRecipients: [{ emailAddress: 'full@example.com' }],
          },
        }),
      }),
    );

    expect(parseSnsNotification(body)[0]?.bounceClass).toBe('soft');
  });

  it('produces one event per bounced recipient', () => {
    const body = Buffer.from(
      JSON.stringify({
        Type: 'Notification',
        Message: JSON.stringify({
          notificationType: 'Bounce',
          mail: { messageId: 'm1' },
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [{ emailAddress: 'a@example.com' }, { emailAddress: 'b@example.com' }],
          },
        }),
      }),
    );

    const events = parseSnsNotification(body);
    expect(events).toHaveLength(2);
    // Distinct ids, or the second is deduplicated away as a copy of the first.
    expect(new Set(events.map((e) => e.providerEventId)).size).toBe(2);
  });

  it('gives the same ids when the same notification is redelivered', () => {
    const first = parseSnsNotification(SNS_BODY).map((e) => e.providerEventId);
    const second = parseSnsNotification(SNS_BODY).map((e) => e.providerEventId);
    expect(second).toEqual(first);
  });

  it('yields no events for a subscription confirmation', () => {
    // It is not an event; the ingest route confirms it separately.
    const body = Buffer.from(
      JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.example/x' }),
    );

    expect(parseSnsNotification(body)).toEqual([]);
  });

  it('yields nothing rather than throwing on rubbish', () => {
    expect(parseSnsNotification(Buffer.from('not json'))).toEqual([]);
    expect(parseSnsNotification(Buffer.from('{}'))).toEqual([]);
    expect(
      parseSnsNotification(Buffer.from(JSON.stringify({ Type: 'Notification', Message: 'nope' }))),
    ).toEqual([]);
  });

  it('falls back to a real date when the timestamp is missing', () => {
    // An Invalid Date would be written to occurred_at as NULL or NaN and
    // silently break every time-bucketed report that reads it.
    const body = Buffer.from(
      JSON.stringify({
        Type: 'Notification',
        Message: JSON.stringify({
          notificationType: 'Delivery',
          mail: { messageId: 'm1' },
          delivery: { recipients: ['a@example.com'] },
        }),
      }),
    );

    const [event] = parseSnsNotification(body);
    expect(Number.isNaN(event?.occurredAt.getTime() ?? Number.NaN)).toBe(false);
  });
});

describe('sending', () => {
  it('sets List-Unsubscribe and the one-click header', async () => {
    // docs/06: non-negotiable, not a setting. Bulk senders are required to
    // support one-click unsubscribe by the major mailbox providers.
    let captured: Record<string, unknown> = {};

    const adapter = createSesAdapter(() => ({
      async send(command: unknown) {
        captured = (command as { input: Record<string, unknown> }).input;
        return { MessageId: 'm1' };
      },
    }));

    await adapter.send(CREDENTIALS, outboundMessage('r1'));

    const headers = (
      captured['Content'] as { Simple: { Headers: { Name: string; Value: string }[] } }
    ).Simple.Headers;
    const byName = Object.fromEntries(headers.map((h) => [h.Name, h.Value]));

    expect(byName['List-Unsubscribe']).toContain('https://relayd.test/u/r1');
    expect(byName['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(byName['X-Relayd-Recipient']).toBe('r1');
  });

  it('reports the sandbox, which a customer cannot otherwise discover', async () => {
    // A sandbox account delivers only to verified addresses. Without this the
    // campaign reports success and arrives nowhere.
    const adapter = createSesAdapter(() => ({
      async send() {
        return { ...ACCOUNT_RESPONSE, ProductionAccessEnabled: false };
      },
    }));

    const result = await adapter.verifyConnection(CREDENTIALS);
    expect(result.ok).toBe(true);
    expect(result.details?.['sandbox']).toBe(true);
  });

  it('returns null from getQuota rather than failing the caller', async () => {
    // A quota read is advisory; failing it must not fail a send path that
    // only wanted to know whether there was headroom.
    const adapter = createSesAdapter(() => ({
      async send() {
        throw sesError('ServiceUnavailable', 'nope', 503);
      },
    }));

    expect(await adapter.getQuota(CREDENTIALS)).toBeNull();
  });

  it('refuses credentials for another provider', async () => {
    const adapter = createSesAdapter(() => ({ async send() { return {}; } }));
    const outcome = await adapter.send(
      { type: 'sendgrid', apiKey: 'sg' },
      outboundMessage('r1'),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.kind).toBe('auth_failed');
  });
});

describe('sns signature verification', () => {
  it('accepts a message signed by the certificate', () => {
    expect(verifySnsSignature(SNS_BODY, CERTIFICATE)).toBe(true);
  });

  it('rejects a message signed by a different key', () => {
    // This is F4 in miniature: a signature that is valid somewhere else is
    // worthless against this connection's certificate.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    expect(verifySnsSignature(SNS_BODY, otherPem)).toBe(false);
  });

  it('rejects a body altered after signing', () => {
    const tampered = JSON.parse(SNS_BODY.toString('utf8')) as Record<string, unknown>;
    tampered['Message'] = SES_BOUNCE.replace('bounced@example.com', 'victim@example.com');

    expect(verifySnsSignature(Buffer.from(JSON.stringify(tampered)), CERTIFICATE)).toBe(false);
  });

  it('rejects a message with no signature at all', () => {
    const unsigned = { ...SNS_ENVELOPE };
    expect(verifySnsSignature(Buffer.from(JSON.stringify(unsigned)), CERTIFICATE)).toBe(false);
  });

  it('rejects an unknown signature version rather than guessing', () => {
    const odd = JSON.parse(SNS_BODY.toString('utf8')) as Record<string, unknown>;
    odd['SignatureVersion'] = '99';
    expect(verifySnsSignature(Buffer.from(JSON.stringify(odd)), CERTIFICATE)).toBe(false);
  });

  it('rejects an empty certificate rather than treating it as a pass', () => {
    expect(verifySnsSignature(SNS_BODY, '')).toBe(false);
  });

  it('rejects rubbish without throwing', () => {
    expect(verifySnsSignature(Buffer.from('not json'), CERTIFICATE)).toBe(false);
  });

  it('omits an absent optional field from the canonical string', () => {
    // Subject is optional. Signing it as an empty string would produce a
    // different string from the one SNS signed, and nothing would verify.
    const canonical = canonicalString({ Type: 'Notification', MessageId: 'm', Message: 'x' });
    expect(canonical).not.toContain('Subject');
  });
});

describe('the certificate URL guard', () => {
  it('accepts a real SNS host', () => {
    expect(
      isAmazonCertificateUrl('https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-a.pem'),
    ).toBe(true);
    expect(isAmazonCertificateUrl('https://sns.cn-north-1.amazonaws.com.cn/x.pem')).toBe(true);
  });

  it('rejects a lookalike host', () => {
    // The URL comes out of an unauthenticated payload. Without this, fetching
    // it is a server-side request forgery against anything the worker can
    // reach — including the instance metadata endpoint.
    for (const url of [
      'https://sns.eu-west-1.amazonaws.com.evil.test/x.pem',
      'https://evil.test/sns.eu-west-1.amazonaws.com/x.pem',
      'https://sns.eu-west-1.amazonaws.com@evil.test/x.pem',
      'http://sns.eu-west-1.amazonaws.com/x.pem',
      'https://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isAmazonCertificateUrl(url), url).toBe(false);
    }
  });
});
