/**
 * The provider port.
 *
 * Every adapter implements this and nothing else. The interface exists to keep
 * provider-specific branches out of business logic, which is why four things
 * that look like conveniences are actually load-bearing (docs/07 §9):
 *
 *   `ProviderError.kind` and `affects` let the router decide what to disable —
 *   one message, one sender, or the whole connection — without knowing which
 *   provider it was talking to. This is the most important thing in the file.
 *
 *   `sendBatch` with `capabilities.maxBatchSize` exists because 100,000 emails
 *   sent one HTTP call at a time is an order of magnitude slower.
 *
 *   `recipientId` appears on both the message and the outcome because batch
 *   APIs return results in arbitrary order. Correlation has to be explicit.
 *
 *   Credentials are a parameter on every call and are never held. Adapters are
 *   stateless, so a rotation takes effect on the next send rather than on the
 *   next deploy.
 */

export type ProviderType = 'ses' | 'sendgrid' | 'mailgun' | 'brevo' | 'smtp' | 'google';

export interface ProviderCapabilities {
  /** 1 for SMTP, 50 for SES bulk, 1000 for SendGrid. */
  readonly maxBatchSize: number;
  readonly supportsWebhooks: boolean;
  /** Provider-side open and click tracking. We prefer our own. */
  readonly supportsTracking: boolean;
  readonly supportsCustomHeaders: boolean;
  readonly supportsScheduling: boolean;
  readonly supportsSuppressionSync: boolean;
  readonly returnsMessageId: boolean;
  readonly reportsQuota: boolean;
  readonly maxRecipientsPerMessage: number;
  readonly maxMessageBytes: number;
}

export interface OutboundMessage {
  /** campaign_recipient_id — our correlation key, echoed on the outcome. */
  readonly recipientId: string;
  readonly to: { email: string; name?: string };
  readonly from: { email: string; name: string };
  readonly replyTo?: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Includes List-Unsubscribe and X-Relayd-Recipient. */
  readonly headers: Readonly<Record<string, string>>;
  readonly listUnsubscribe: { mailto?: string; url: string; oneClick: boolean };
  readonly attachments?: ReadonlyArray<{
    filename: string;
    contentType: string;
    contentBase64: string;
  }>;
}

export type SendOutcome =
  | { ok: true; recipientId: string; providerMessageId: string | null; acceptedAt: Date }
  | { ok: false; recipientId: string; error: ProviderError };

/**
 * What went wrong, in terms the router understands.
 *
 * `affects` is the blast radius, and it is what the caller acts on:
 *   'message'    — this one send; the others in the batch are unaffected
 *   'sender'     — this From address; pause or cool it down
 *   'connection' — the whole provider connection; disable and notify the owner
 */
export interface ProviderError {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  readonly message: string;
  readonly affects: 'message' | 'sender' | 'connection';
}

export type ErrorKind =
  /** connection: disable, notify owner */
  | 'auth_failed'
  /** sender: back off, retry */
  | 'rate_limited'
  /** sender: cool down until reset */
  | 'quota_exceeded'
  /** message: permanent, suppress */
  | 'invalid_recipient'
  /** connection: identity unverified */
  | 'invalid_sender'
  /** message: permanent, do not retry */
  | 'content_rejected'
  /** message: permanent */
  | 'message_too_large'
  /** connection: retry, consider failover */
  | 'provider_unavailable'
  /** message: retry, ambiguous — may have been accepted */
  | 'timeout'
  | 'unknown';

export type ProviderCredentials =
  | { type: 'ses'; accessKeyId: string; secretAccessKey: string; region: string }
  | { type: 'sendgrid' | 'brevo'; apiKey: string }
  | { type: 'mailgun'; apiKey: string; domain: string; region: 'us' | 'eu' }
  | { type: 'smtp'; host: string; port: number; secure: boolean; user: string; pass: string }
  | { type: 'google'; refreshToken: string; clientId: string; clientSecret: string };

export interface VerificationResult {
  readonly ok: boolean;
  readonly error?: ProviderError;
  /** What the provider says about itself, for the connection card. */
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface QuotaSnapshot {
  readonly max24Hour: number | null;
  readonly sentLast24Hours: number | null;
  readonly maxSendRate: number | null;
  readonly checkedAt: Date;
}

export interface SenderIdentitySnapshot {
  readonly kind: 'domain' | 'email';
  readonly value: string;
  readonly status: 'pending' | 'verified' | 'failed' | 'expired';
  readonly dkim?: string;
  readonly spf?: string;
  readonly dmarc?: string;
}

/**
 * One inbound event, normalised out of whatever shape the provider posted.
 *
 * `providerEventId` becomes the inbox dedupe key. An adapter whose provider
 * gives no event id must synthesise a stable one from the payload — the same
 * event redelivered must produce the same key, or it is applied twice.
 */
export interface NormalisedEmailEvent {
  readonly providerEventId: string;
  readonly type:
    | 'delivered'
    | 'bounce'
    | 'complaint'
    | 'deferred'
    | 'open'
    | 'click'
    | 'unsubscribe'
    | 'reject';
  readonly bounceClass?: 'hard' | 'soft' | 'block';
  readonly providerMessageId?: string;
  readonly recipientEmail: string;
  readonly occurredAt: Date;
  readonly raw: unknown;
}

export interface SuppressionEntry {
  readonly email: string;
  readonly reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'invalid';
  readonly at: Date;
}

export interface EmailProviderAdapter {
  readonly type: ProviderType;
  readonly capabilities: ProviderCapabilities;

  verifyConnection(creds: ProviderCredentials): Promise<VerificationResult>;
  getQuota(creds: ProviderCredentials): Promise<QuotaSnapshot | null>;
  listVerifiedIdentities(creds: ProviderCredentials): Promise<SenderIdentitySnapshot[]>;

  send(creds: ProviderCredentials, message: OutboundMessage): Promise<SendOutcome>;
  sendBatch(
    creds: ProviderCredentials,
    messages: readonly OutboundMessage[],
  ): Promise<SendOutcome[]>;

  /**
   * Verifies an inbound webhook against this connection's own secret.
   *
   * Takes the raw body, not a parsed object: re-serialising JSON changes the
   * bytes, and every signature scheme signs the bytes that were sent.
   */
  verifyWebhookSignature(
    raw: Buffer,
    headers: Readonly<Record<string, string>>,
    secret: string,
  ): boolean;

  parseWebhook(raw: Buffer, headers: Readonly<Record<string, string>>): NormalisedEmailEvent[];

  configureWebhook?(
    creds: ProviderCredentials,
    callbackUrl: string,
  ): Promise<{ secret: string }>;
  syncSuppressions?(creds: ProviderCredentials, since: Date): Promise<SuppressionEntry[]>;
}

/**
 * How each error kind must be handled.
 *
 * Exported as data rather than left in a comment because the router, the UI
 * and the contract suite all need to agree about it, and three copies of a
 * table drift. docs/07 §"Error classification drives behaviour".
 */
export interface ErrorPolicy {
  /** Where the recipient goes next. */
  readonly recipient: 'pending' | 'failed' | 'sending';
  readonly sender: 'none' | 'pause' | 'cooling_down' | 'disabled' | 'health_penalty';
  readonly connection: 'none' | 'error' | 'degraded' | 'reverify_identity';
  readonly suppress: false | 'invalid';
  readonly retryable: boolean;
  readonly affects: ProviderError['affects'];
}

export const ERROR_POLICY: Readonly<Record<ErrorKind, ErrorPolicy>> = {
  auth_failed: {
    recipient: 'pending',
    sender: 'pause',
    connection: 'error',
    suppress: false,
    retryable: false,
    affects: 'connection',
  },
  rate_limited: {
    recipient: 'pending',
    sender: 'health_penalty',
    connection: 'none',
    suppress: false,
    retryable: true,
    affects: 'sender',
  },
  quota_exceeded: {
    recipient: 'pending',
    sender: 'cooling_down',
    connection: 'none',
    suppress: false,
    retryable: true,
    affects: 'sender',
  },
  invalid_recipient: {
    recipient: 'failed',
    sender: 'none',
    connection: 'none',
    suppress: 'invalid',
    retryable: false,
    affects: 'message',
  },
  invalid_sender: {
    recipient: 'pending',
    sender: 'disabled',
    connection: 'reverify_identity',
    suppress: false,
    retryable: false,
    affects: 'sender',
  },
  content_rejected: {
    recipient: 'failed',
    sender: 'none',
    connection: 'none',
    suppress: false,
    retryable: false,
    affects: 'message',
  },
  message_too_large: {
    recipient: 'failed',
    sender: 'none',
    connection: 'none',
    suppress: false,
    retryable: false,
    affects: 'message',
  },
  provider_unavailable: {
    recipient: 'pending',
    sender: 'health_penalty',
    connection: 'degraded',
    suppress: false,
    retryable: true,
    affects: 'connection',
  },
  /**
   * The dangerous one.
   *
   * The recipient stays in `sending`, ambiguous: the provider may have
   * accepted it. The reconciler picks it up after 10 minutes and resolves it
   * against the provider before deciding anything (docs/04 §8). Treating a
   * timeout as a failure and resending is how a customer's list gets the same
   * email twice.
   */
  timeout: {
    recipient: 'sending',
    sender: 'health_penalty',
    connection: 'none',
    suppress: false,
    retryable: true,
    affects: 'message',
  },
  unknown: {
    recipient: 'pending',
    sender: 'health_penalty',
    connection: 'none',
    suppress: false,
    retryable: true,
    affects: 'message',
  },
};
