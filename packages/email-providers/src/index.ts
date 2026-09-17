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

// Test support. Exported from the package so other packages can drive the
// port without a real provider, and so an adapter's own tests can run the
// shared contract.
export { createFakeProvider, signFakeWebhook } from './testing/fake-provider.js';
export type { FakeProvider, FakeProviderScript } from './testing/fake-provider.js';
export { runProviderContract, outboundMessage } from './testing/contract.js';
export type { ContractHarness } from './testing/contract.js';
