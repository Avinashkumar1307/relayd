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

export {
  providerError,
  fromUnknown,
  asProviderError,
  redact,
  secretsOf,
  classifyStatus,
  parseRetryAfter,
} from './errors.js';

export { sendWithLimits } from './send-with-limits.js';
export type { RateLimiter, SendContext } from './send-with-limits.js';

// Test support lives at `@relayd/email-providers/testing`, NOT here. It
// imports vitest, so re-exporting it from this barrel made every production
// value import pull vitest into the running process.

export {
  CredentialCache,
  credentialPath,
  workspacePrefix,
  parseCredentials,
  MAX_CACHE_MS,
} from './secrets.js';
export type {
  SecretReader,
  SecretWriter,
  CredentialAudit,
  CredentialCacheOptions,
  CredentialRequest,
} from './secrets.js';

export { createSesAdapter } from './adapters/ses/index.js';
export { isAmazonCertificateUrl, verifySnsSignature } from './adapters/ses/sns.js';
export { createSmtpAdapter } from './adapters/smtp/index.js';
export { createSendgridAdapter } from './adapters/sendgrid/index.js';

export {
  MAX_BATCH_SIZE,
  batchSizeFor,
  isPreAcceptance,
  isAmbiguous,
  batchFailureOutcomes,
} from './batching.js';
