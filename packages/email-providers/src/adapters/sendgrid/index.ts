import { createVerify } from 'node:crypto';
import {
  asProviderError,
  classifyStatus,
  parseRetryAfter,
  providerError,
  secretsOf,
} from '../../errors.js';
import type {
  EmailProviderAdapter,
  ErrorKind,
  NormalisedEmailEvent,
  OutboundMessage,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderError,
  QuotaSnapshot,
  SendOutcome,
  SenderIdentitySnapshot,
  VerificationResult,
} from '../../port.js';

/**
 * SendGrid v3.
 *
 * Called over `fetch` rather than through `@sendgrid/mail`. The SDK is a thin
 * wrapper over one POST, it holds the API key in module state — which fights
 * the port's rule that adapters are stateless and credentials arrive per call
 * — and injecting a `fetch` makes the whole adapter testable without a
 * network. Recorded in docs/16.
 *
 * The sharp edge is click tracking. SendGrid rewrites every URL in the body
 * with its own redirect, which would replace the tracked links we generate and
 * break both our click attribution and the unsubscribe token. It is disabled
 * explicitly on every request.
 */

const API_BASE = 'https://api.sendgrid.com';

const CAPABILITIES: ProviderCapabilities = {
  // v3 mail/send accepts up to 1000 personalizations.
  maxBatchSize: 1000,
  supportsWebhooks: true,
  // It can, and we turn it off — see above.
  supportsTracking: true,
  supportsCustomHeaders: true,
  supportsScheduling: true,
  supportsSuppressionSync: true,
  // 202 Accepted with the id in a header, not the body.
  returnsMessageId: true,
  reportsQuota: false,
  maxRecipientsPerMessage: 1,
  // SendGrid rejects above 30 MB including attachments.
  maxMessageBytes: 30 * 1024 * 1024,
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function requireSendgridCredentials(
  credentials: ProviderCredentials,
): Extract<ProviderCredentials, { type: 'sendgrid' | 'brevo' }> {
  if (credentials.type !== 'sendgrid') {
    throw providerError('auth_failed', 'These are not SendGrid credentials');
  }
  return credentials;
}

export function createSendgridAdapter(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): EmailProviderAdapter {
  const request = async (
    credentials: ProviderCredentials,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const creds = requireSendgridCredentials(credentials);

    return fetchImpl(`${API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  };

  const sendMessages = async (
    credentials: ProviderCredentials,
    messages: readonly OutboundMessage[],
  ): Promise<SendOutcome[]> => {
    if (messages.length === 0) return [];

    try {
      const response = await request(credentials, '/v3/mail/send', {
        method: 'POST',
        body: JSON.stringify(buildPayload(messages)),
      });

      if (!response.ok) {
        const error = await classifySendgridResponse(response, secretsOf(credentials));
        return messages.map((message) => ({
          ok: false as const,
          recipientId: message.recipientId,
          error,
        }));
      }

      // 202 Accepted, no body. The id is in a header and is shared by the
      // whole request — SendGrid appends a per-recipient suffix on the
      // events it later posts back, so this prefix is what correlates them.
      const messageId = response.headers.get('x-message-id');
      const acceptedAt = new Date();

      return messages.map((message) => ({
        ok: true as const,
        recipientId: message.recipientId,
        providerMessageId: messageId,
        acceptedAt,
      }));
    } catch (cause) {
      const error = asProviderError(cause) ?? networkError(cause);
      return messages.map((message) => ({
        ok: false as const,
        recipientId: message.recipientId,
        error,
      }));
    }
  };

  return {
    type: 'sendgrid',
    capabilities: CAPABILITIES,

    async verifyConnection(credentials): Promise<VerificationResult> {
      try {
        const response = await request(credentials, '/v3/scopes');

        if (!response.ok) {
          return { ok: false, error: await classifySendgridResponse(response, secretsOf(credentials)) };
        }

        const body = (await response.json().catch(() => ({}))) as { scopes?: string[] };
        const scopes = body.scopes ?? [];

        return {
          ok: true,
          details: {
            // A key without mail.send will pass verification and fail every
            // send, which is the most confusing possible outcome — so it is
            // reported at connect time instead.
            canSend: scopes.includes('mail.send'),
            scopeCount: scopes.length,
          },
        };
      } catch (cause) {
        return { ok: false, error: asProviderError(cause) ?? networkError(cause) };
      }
    },

    /** SendGrid exposes no sending quota on the v3 API. */
    async getQuota(): Promise<QuotaSnapshot | null> {
      return null;
    },

    async listVerifiedIdentities(credentials): Promise<SenderIdentitySnapshot[]> {
      const identities: SenderIdentitySnapshot[] = [];

      try {
        const domains = await request(credentials, '/v3/whitelabel/domains?limit=100');
        if (domains.ok) {
          const body = (await domains.json().catch(() => [])) as {
            domain?: string;
            valid?: boolean;
            dns?: { dkim1?: { valid?: boolean }; mail_cname?: { valid?: boolean } };
          }[];

          for (const entry of Array.isArray(body) ? body : []) {
            if (entry.domain === undefined) continue;
            identities.push({
              kind: 'domain',
              value: entry.domain,
              status: entry.valid === true ? 'verified' : 'pending',
              ...(entry.dns?.dkim1?.valid === undefined
                ? {}
                : { dkim: entry.dns.dkim1.valid ? 'verified' : 'pending' }),
            });
          }
        }
      } catch {
        // One list failing must not lose the other.
      }

      try {
        const senders = await request(credentials, '/v3/verified_senders');
        if (senders.ok) {
          const body = (await senders.json().catch(() => ({}))) as {
            results?: { from_email?: string; verified?: boolean }[];
          };

          for (const entry of body.results ?? []) {
            if (entry.from_email === undefined) continue;
            identities.push({
              kind: 'email',
              value: entry.from_email,
              status: entry.verified === true ? 'verified' : 'pending',
            });
          }
        }
      } catch {
        // As above.
      }

      return identities;
    },

    async send(credentials, message): Promise<SendOutcome> {
      const [outcome] = await sendMessages(credentials, [message]);
      return (
        outcome ?? {
          ok: false,
          recipientId: message.recipientId,
          error: providerError('unknown', 'SendGrid returned no result'),
        }
      );
    },

    sendBatch: sendMessages,

    verifyWebhookSignature(raw, headers, secret): boolean {
      return verifySendgridSignature(raw, headers, secret);
    },

    parseWebhook(raw): NormalisedEmailEvent[] {
      return parseSendgridEvents(raw);
    },
  };
}

/**
 * One request, one personalization per recipient.
 *
 * Each message is rendered individually — its own unsubscribe token, its own
 * tracked links — so `personalizations` carries the per-recipient subject and
 * content overrides rather than a shared template with substitutions.
 */
function buildPayload(messages: readonly OutboundMessage[]): Record<string, unknown> {
  const first = messages[0];
  if (first === undefined) throw providerError('unknown', 'No messages to send');

  return {
    personalizations: messages.map((message) => ({
      to: [
        message.to.name === undefined
          ? { email: message.to.email }
          : { email: message.to.email, name: message.to.name },
      ],
      subject: message.subject,
      custom_args: {
        // Echoed back on every event, which is how an event is matched to a
        // recipient without relying on the message id alone (docs/06).
        relayd_recipient_id: message.recipientId,
      },
      headers: unsubscribeHeaders(message),
    })),

    from: { email: first.from.email, name: first.from.name },
    ...(first.replyTo === undefined ? {} : { reply_to: { email: first.replyTo } }),

    subject: first.subject,
    content: [
      { type: 'text/plain', value: first.text },
      { type: 'text/html', value: first.html },
    ],

    // SendGrid's own click tracking rewrites every URL in the body, which
    // would replace our tracked links and break both click attribution and
    // the unsubscribe token. docs/07 names this as its sharp edge.
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    },

    mail_settings: {
      // We maintain suppression ourselves and re-check at send time. Letting
      // SendGrid silently drop a recipient would leave a campaign reporting a
      // send that never happened.
      bypass_list_management: { enable: false },
    },
  };
}

function unsubscribeHeaders(message: OutboundMessage): Record<string, string> {
  const listUnsubscribe = message.listUnsubscribe.mailto
    ? `<${message.listUnsubscribe.mailto}>, <${message.listUnsubscribe.url}>`
    : `<${message.listUnsubscribe.url}>`;

  const headers: Record<string, string> = {
    ...message.headers,
    'List-Unsubscribe': listUnsubscribe,
  };

  if (message.listUnsubscribe.oneClick) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  return headers;
}

/** SendGrid phrases that identify a recipient problem rather than a content one. */
const RECIPIENT_PHRASES = [
  'does not contain a valid address',
  'invalid email address',
  'the email address entered is invalid',
  'recipient',
];

const SENDER_PHRASES = [
  'from address does not match a verified sender identity',
  'does not match a verified sender',
  'the from address does not match',
];

async function classifySendgridResponse(
  response: Response,
  secrets: readonly string[],
): Promise<ProviderError> {
  const body = (await response.json().catch(() => ({}))) as {
    errors?: { message?: string; field?: string }[];
  };

  const message = (body.errors ?? [])
    .map((error) => error.message ?? '')
    .filter((text) => text !== '')
    .join('; ');

  const lower = message.toLowerCase();
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  // A 400 is SendGrid's answer to several different problems, and only the
  // text separates them. Getting it wrong means a bad address is never
  // suppressed, or a good one is.
  if (response.status === 400) {
    if (SENDER_PHRASES.some((phrase) => lower.includes(phrase))) {
      return providerError('invalid_sender', message || 'The sender identity is not verified', {
        secrets,
      });
    }
    if (RECIPIENT_PHRASES.some((phrase) => lower.includes(phrase))) {
      return providerError('invalid_recipient', message || 'The recipient address was rejected', {
        secrets,
      });
    }
  }

  const kind: ErrorKind = classifyStatus(response.status);

  return providerError(kind, message || `SendGrid returned ${response.status}`, {
    providerCode: String(response.status),
    secrets,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function networkError(cause: unknown): ProviderError {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : '';

  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
    return providerError('timeout', 'SendGrid did not respond in time');
  }

  return providerError('provider_unavailable', 'SendGrid could not be reached');
}

/**
 * The Signed Event Webhook.
 *
 * SendGrid signs `timestamp + payload` with ECDSA P-256 and publishes the
 * public key in the dashboard; `secret` is that key, base64 DER (SPKI).
 *
 * The timestamp is part of the signed material, which is what stops a captured
 * payload being replayed with a fresh timestamp — the signature would no
 * longer match.
 */
export function verifySendgridSignature(
  raw: Buffer,
  headers: Readonly<Record<string, string>>,
  publicKeyBase64: string,
): boolean {
  if (publicKeyBase64.trim() === '') return false;

  const signature = headers['x-twilio-email-event-webhook-signature'];
  const timestamp = headers['x-twilio-email-event-webhook-timestamp'];

  if (typeof signature !== 'string' || signature === '') return false;
  if (typeof timestamp !== 'string' || timestamp === '') return false;

  try {
    const verifier = createVerify('sha256');
    verifier.update(timestamp, 'utf8');
    verifier.update(raw);
    verifier.end();

    return verifier.verify(
      {
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      },
      signature,
      'base64',
    );
  } catch {
    return false;
  }
}

const EVENT_TYPES: Readonly<Record<string, NormalisedEmailEvent['type']>> = {
  delivered: 'delivered',
  bounce: 'bounce',
  blocked: 'bounce',
  dropped: 'reject',
  deferred: 'deferred',
  spamreport: 'complaint',
  unsubscribe: 'unsubscribe',
  group_unsubscribe: 'unsubscribe',
  open: 'open',
  click: 'click',
  processed: 'delivered',
};

export function parseSendgridEvents(raw: Buffer): NormalisedEmailEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const events: NormalisedEmailEvent[] = [];

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const event = String(record['event'] ?? '');
    const type = EVENT_TYPES[event];
    if (type === undefined) continue;

    const email = String(record['email'] ?? '');
    if (email === '') continue;

    // sg_event_id is SendGrid's own unique id and is stable across
    // redeliveries, which is exactly what the inbox deduplicates on.
    const eventId = String(record['sg_event_id'] ?? '');
    const messageId = record['sg_message_id'] === undefined ? undefined : String(record['sg_message_id']);

    const timestamp = Number(record['timestamp']);
    const occurredAt = Number.isFinite(timestamp) ? new Date(timestamp * 1000) : new Date();

    // `processed` and `delivered` both map to delivered, so the event name is
    // part of the fallback id or the two would collide and one be dropped.
    const fallbackId = `${messageId ?? email}:${event}:${String(record['timestamp'] ?? '')}`;

    events.push({
      providerEventId: eventId === '' ? fallbackId : eventId,
      type,
      recipientEmail: email,
      occurredAt,
      raw: entry,
      ...(messageId === undefined ? {} : { providerMessageId: messageId }),
      ...(type === 'bounce' ? { bounceClass: bounceClassOf(record) } : {}),
    });
  }

  return events;
}

function bounceClassOf(record: Record<string, unknown>): 'hard' | 'soft' | 'block' {
  if (String(record['event']) === 'blocked') return 'block';

  const type = String(record['type'] ?? '').toLowerCase();
  if (type === 'blocked') return 'block';
  // SendGrid's "bounce" type is a hard bounce; anything else it reports is
  // transient. Treating a soft bounce as hard suppresses a working address.
  return type === 'bounce' ? 'hard' : 'soft';
}
