import type { Logger } from '@relayd/logger';
import type { TransactionalMailer } from '../notifier.js';

/**
 * Development mailer: records the message rather than sending it.
 *
 * Local development has no SES identity and must not acquire one by accident.
 * It logs enough to follow a flow — who it was addressed to, which email it
 * was — and deliberately logs neither the body nor the link, because the link
 * carries a single-use token that would then sit in a log file for anyone with
 * log access to redeem.
 *
 * Messages are retained in memory so a developer can pull the most recent link
 * out of the running dev server without reading logs at all.
 */
export class LoggingMailer implements TransactionalMailer {
  readonly sent: { to: string; subject: string; text: string; html: string }[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly maxRetained = 50,
  ) {}

  async send(message: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > this.maxRetained) this.sent.shift();

    this.logger.info(
      { to: message.to, subject: message.subject },
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
