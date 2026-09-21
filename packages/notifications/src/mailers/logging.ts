import type { Logger } from '@relayd/logger';
import type { TransactionalMailer } from '../notifier.js';

export interface LoggingMailerOptions {
  maxRetained?: number;
  /**
   * Log the plain-text body, and with it the verification or invitation link.
   *
   * Off by default and never true in production. On a laptop there is no
   * inbox to open, so with it off a flow that ends in an emailed link cannot
   * be finished at all: the token is stored hashed, so it is not recoverable
   * from the database either. Turning it on trades a token in a local log for
   * being able to complete registration, which is the right trade in
   * development and the wrong one anywhere else — which is why it is a flag
   * the composition root sets from NODE_ENV rather than a default.
   */
  revealBody?: boolean;
}

/**
 * Development mailer: records the message rather than sending it.
 *
 * Local development has no SES identity and must not acquire one by accident.
 * It logs who the message was addressed to and which email it was; the body,
 * which carries a single-use token, is logged only when `revealBody` is set,
 * because otherwise it would sit in a log file for anyone with log access to
 * redeem.
 *
 * Messages are retained in memory too, so a caller inside the process can
 * pull the most recent link out with `lastTo` and never touch the log.
 */
export class LoggingMailer implements TransactionalMailer {
  readonly sent: { to: string; subject: string; text: string; html: string }[] = [];

  readonly #maxRetained: number;
  readonly #revealBody: boolean;

  constructor(
    private readonly logger: Logger,
    options: LoggingMailerOptions | number = {},
  ) {
    // A number keeps the original `new LoggingMailer(logger, 50)` working.
    const resolved = typeof options === 'number' ? { maxRetained: options } : options;
    this.#maxRetained = resolved.maxRetained ?? 50;
    this.#revealBody = resolved.revealBody ?? false;
  }

  async send(message: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > this.#maxRetained) this.sent.shift();

    this.logger.info(
      {
        to: message.to,
        subject: message.subject,
        ...(this.#revealBody ? { body: message.text } : {}),
      },
      'transactional email (development mailer: not delivered)',
    );
  }

  /** The most recent message to an address, for local development flows. */
  lastTo(address: string): { subject: string; text: string } | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.to === address) return { subject: message.subject, text: message.text };
    }
    return undefined;
  }
}
