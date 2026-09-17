import { parseSnsNotification, verifySnsSignature } from './adapters/ses/sns.js';
import { parseSendgridEvents, verifySendgridSignature } from './adapters/sendgrid/webhook.js';
import type { NormalisedEmailEvent, ProviderType } from './port.js';

/**
 * @relayd/email-providers/webhooks — verifying and parsing inbound events.
 *
 * This subpath exists because of a genuine conflict between two rules.
 *
 * CLAUDE.md section 6.3 says `edge` depends on queue, db and utils only, and
 * the reason is sound: `edge` is public, unauthenticated and unpredictable in
 * volume, and it must not inherit the sending machinery's cold start or its
 * blast radius. Pulling the AWS SDK and nodemailer into it would do exactly
 * that.
 *
 * INVARIANTS R4 says the signature on an inbound event is verified with that
 * connection's own secret at the ingest endpoint — which is in `edge`. That
 * cannot be deferred to a worker: an endpoint that enqueues before verifying
 * accepts anything anyone posts, and the queue becomes the amplifier.
 *
 * Both hold if `edge` imports only this. Everything reachable from here is
 * pure — node:crypto and JSON — and a test asserts no provider SDK is
 * reachable from this module. INVARIANTS outranks CLAUDE.md (CLAUDE.md
 * section 1), so where they cannot both be satisfied R4 wins; here they can.
 */

export interface WebhookHandler {
  /** Verifies against this connection's own secret. */
  verify(raw: Buffer, headers: Readonly<Record<string, string>>, secret: string): boolean;
  parse(raw: Buffer, headers: Readonly<Record<string, string>>): NormalisedEmailEvent[];
}

/**
 * A handler per provider, or null where the provider has no webhooks.
 *
 * SMTP is null rather than absent: an SMTP connection receiving a payload is
 * receiving something nobody sent, and the ingest route refuses it rather
 * than looking for a handler that does not exist.
 */
export const WEBHOOK_HANDLERS: Readonly<Record<ProviderType, WebhookHandler | null>> = {
  ses: {
    verify: (raw, _headers, secret) => verifySnsSignature(raw, secret),
    parse: (raw) => parseSnsNotification(raw),
  },
  sendgrid: {
    verify: (raw, headers, secret) => verifySendgridSignature(raw, headers, secret),
    parse: (raw) => parseSendgridEvents(raw),
  },
  smtp: null,
  mailgun: null,
  brevo: null,
  google: null,
};

export function webhookHandlerFor(provider: ProviderType): WebhookHandler | null {
  return WEBHOOK_HANDLERS[provider] ?? null;
}

export { isAmazonCertificateUrl } from './adapters/ses/sns.js';
export type { NormalisedEmailEvent, ProviderType } from './port.js';
