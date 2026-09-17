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
