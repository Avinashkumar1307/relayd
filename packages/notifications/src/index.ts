// @relayd/notifications — product email (verification, invites, dunning).
//
// Separate from customer sending forever: see notifier.ts for why.
export { Notifier } from './notifier.js';
export type { TransactionalMailer, NotifierOptions } from './notifier.js';
export {
  emailVerification,
  passwordReset,
  workspaceInvitation,
  escapeHtml,
} from './templates.js';
export type { RenderedEmail } from './templates.js';
export { LoggingMailer } from './mailers/logging.js';
export {
  classifyResponse,
  backoffMs,
  nextEndpointHealth,
  shouldDeliver,
  activeSecrets,
  buildDelivery,
  nextAttempt,
  truncateResponse,
  MAX_DELIVERY_ATTEMPTS,
  FAILING_THRESHOLD,
  DISABLE_THRESHOLD,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  SECRET_OVERLAP_MS,
  MAX_STORED_RESPONSE_BYTES,
} from './webhooks/delivery.js';
export type { DeliveryOutcome, EndpointHealth, DeliveryRequest, AttemptResult } from './webhooks/delivery.js';
