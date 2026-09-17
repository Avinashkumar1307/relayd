import { asProviderError, classifyStatus, providerError } from '../../errors.js';
import type { ErrorKind, ProviderError } from '../../port.js';

/**
 * SES error classification.
 *
 * The shared HTTP mapping gets most of it right; these are the cases where
 * SES is more specific than its status code, and where guessing from the
 * status alone would be actively wrong.
 *
 * The important one is MessageRejected. SES returns 400 for it, which the
 * shared mapping reads as `content_rejected` — permanent, no suppression. But
 * SES uses MessageRejected for a bad recipient address too, and that must
 * suppress. The message text is the only thing that distinguishes them.
 */

/** SES exception names, as the SDK sets `name` on the error. */
const BY_NAME: Readonly<Record<string, ErrorKind>> = {
  // Credentials
  InvalidClientTokenId: 'auth_failed',
  UnrecognizedClientException: 'auth_failed',
  SignatureDoesNotMatch: 'auth_failed',
  AccessDenied: 'auth_failed',
  AccessDeniedException: 'auth_failed',
  ExpiredTokenException: 'auth_failed',

  // Throughput
  ThrottlingException: 'rate_limited',
  TooManyRequestsException: 'rate_limited',
  Throttling: 'rate_limited',
  LimitExceededException: 'quota_exceeded',
  SendingQuotaExceededException: 'quota_exceeded',
  MaxSendingRateExceededException: 'rate_limited',

  // Sender identity
  MailFromDomainNotVerifiedException: 'invalid_sender',
  NotFoundException: 'invalid_sender',

  // Account state
  AccountSuspendedException: 'auth_failed',
  SendingPausedException: 'quota_exceeded',

  // Content
  MessageRejected: 'content_rejected',
  InvalidParameterValue: 'content_rejected',
  BadRequestException: 'content_rejected',

  // Availability
  ServiceUnavailable: 'provider_unavailable',
  InternalFailure: 'provider_unavailable',
  RequestTimeout: 'timeout',
  TimeoutError: 'timeout',
};

/**
 * Text SES puts in a MessageRejected when the problem is the address, not the
 * content.
 *
 * Matching on prose is unpleasant and it is what SES leaves available. The
 * consequence of getting it wrong is concrete: classify a bad address as
 * `content_rejected` and it is never suppressed, so every future campaign
 * retries it and the account's bounce rate carries the cost.
 */
const RECIPIENT_PHRASES = [
  'email address is not verified',
  'invalid domain',
  'address blacklisted',
  'recipient address',
  'local address contains control or whitespace',
  'domain contains control or whitespace',
  'invalid email address',
  'illegal address',
];

const SENDER_PHRASES = [
  'email address is not verified. the following identities failed',
  'not authorized to perform',
  'from address',
];

export function classifySesError(cause: unknown): ProviderError {
  // Already typed — thrown by the adapter itself, for instance when handed
  // credentials for another provider. Reclassifying it would turn a definite
  // auth failure into `unknown`, which is retryable.
  const passthrough = asProviderError(cause);
  if (passthrough !== null) return passthrough;

  const name = readString(cause, 'name');
  const message = readString(cause, 'message');
  const code = readString(cause, 'Code') || name;
  const status = readStatus(cause);
  const lower = message.toLowerCase();

  if (name === 'MessageRejected' || code === 'MessageRejected') {
    // Sender first: an unverified *identity* is a sender problem, and its
    // text also contains "email address is not verified".
    if (SENDER_PHRASES.some((phrase) => lower.includes(phrase))) {
      return providerError('invalid_sender', message, { providerCode: 'MessageRejected' });
    }
    if (RECIPIENT_PHRASES.some((phrase) => lower.includes(phrase))) {
      return providerError('invalid_recipient', message, { providerCode: 'MessageRejected' });
    }
    return providerError('content_rejected', message, { providerCode: 'MessageRejected' });
  }

  // A payload-too-large is unambiguous from the status, and SES reports it
  // under the generic BadRequestException — so the status is consulted first
  // for this one case, or "message too large" would be classified as content
  // and the campaign would never learn to split its batches.
  if (status === 413) {
    return providerError('message_too_large', message, { providerCode: name || code });
  }

  const byName = BY_NAME[name] ?? BY_NAME[code];
  if (byName !== undefined) {
    return providerError(byName, message, { providerCode: name || code });
  }

  // SES marks a subset of exceptions retryable itself; when it does, trust it
  // over the status code.
  if (isRetryableFlag(cause) && status !== 429) {
    return providerError('provider_unavailable', message, { providerCode: name || code });
  }

  if (status !== undefined) {
    return providerError(classifyStatus(status), message, { providerCode: name || code });
  }

  const socket = readString(cause, 'code');
  if (socket === 'ETIMEDOUT' || socket === 'ESOCKETTIMEDOUT') {
    return providerError('timeout', message);
  }
  if (socket === 'ECONNREFUSED' || socket === 'ENOTFOUND' || socket === 'ECONNRESET') {
    return providerError('provider_unavailable', message);
  }

  return providerError('unknown', message);
}

function readString(cause: unknown, key: string): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const value = (cause as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function readStatus(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;

  const metadata = (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  if (metadata !== undefined && typeof metadata.httpStatusCode === 'number') {
    return metadata.httpStatusCode;
  }

  const status = (cause as Record<string, unknown>)['statusCode'];
  return typeof status === 'number' ? status : undefined;
}

function isRetryableFlag(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const retryable = (cause as { $retryable?: unknown }).$retryable;
  return typeof retryable === 'object' && retryable !== null;
}
