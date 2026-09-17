// @relayd/email-providers — the ProviderPort, the send wrapper, and adapters.
export type {
  ProviderType,
  ProviderCapabilities,
  OutboundMessage,
  SendOutcome,
  ProviderError,
  ErrorKind,
  ProviderCredentials,
  VerificationResult,
  QuotaSnapshot,
  SenderIdentitySnapshot,
  NormalisedEmailEvent,
  SuppressionEntry,
  EmailProviderAdapter,
  ErrorPolicy,
} from './port.js';
export { ERROR_POLICY } from './port.js';

export { providerError, fromUnknown, redact, classifyStatus, parseRetryAfter } from './errors.js';

export { sendWithLimits } from './send-with-limits.js';
export type { RateLimiter, SendContext } from './send-with-limits.js';
