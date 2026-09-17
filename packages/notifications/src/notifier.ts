import { emailVerification, passwordReset, workspaceInvitation } from './templates.js';
import type { RenderedEmail } from './templates.js';

/**
 * The operator-owned transactional mail path.
 *
 * ONE connection, owned by us, never a customer's. docs/10 is explicit:
 * product email goes through our own SES identity, separate from any
 * customer's. Two reasons, both of which bite in production:
 *
 *   A customer whose provider is suspended for a complaint rate must still be
 *   able to receive a password-reset email. If product email rode their
 *   connection, losing their account would lock them out of recovering it.
 *
 *   Product email must never be metered. The billable unit is a
 *   campaign_recipients row reaching sent (CLAUDE.md section 10); a
 *   verification email is not a campaign and must not touch that ledger.
 *
 * The SES implementation arrives with the provider adapters in Phase 3. This
 * is the port and the templates, so Phase 1 can send without waiting.
 */
export interface TransactionalMailer {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export interface NotifierOptions {
  mailer: TransactionalMailer;
  /** Public origin for links: https://app.relayd.io, or localhost in dev. */
  appBaseUrl: string;
}

/**
 * Implements the notifier ports the API services depend on.
 *
 * Link construction lives here rather than in the services, so the token
 * appears in exactly one place per flow and the services never have to know
 * what a verification URL looks like.
 */
export class Notifier {
  constructor(private readonly options: NotifierOptions) {}

  async sendEmailVerification(to: string, token: string): Promise<void> {
    await this.#deliver(to, emailVerification({ verifyUrl: this.#link('/verify-email', token) }));
  }

  async sendPasswordReset(to: string, token: string): Promise<void> {
    await this.#deliver(to, passwordReset({ resetUrl: this.#link('/reset-password', token) }));
  }

  async sendWorkspaceInvitation(
    to: string,
    workspaceName: string,
    token: string,
  ): Promise<void> {
    await this.#deliver(
      to,
      workspaceInvitation({
        workspaceName,
        acceptUrl: this.#link('/invitations/accept', token),
      }),
    );
  }

  /**
   * Builds a link carrying the token.
   *
   * encodeURIComponent is not decoration: tokens are base64url, which is
   * URL-safe by construction, but encoding anyway means a future change to
   * the token alphabet cannot silently produce a broken or ambiguous link.
   */
  #link(path: string, token: string): string {
    const base = this.options.appBaseUrl.replace(/\/+$/u, '');
    return `${base}${path}?token=${encodeURIComponent(token)}`;
  }

  async #deliver(to: string, email: RenderedEmail): Promise<void> {
    await this.options.mailer.send({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }
}
