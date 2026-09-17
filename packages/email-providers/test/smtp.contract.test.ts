import { describe, expect, it } from 'vitest';
import { createSmtpAdapter, type SmtpTransport } from '../src/adapters/smtp/index.js';
import { classifySmtpError, enhancedStatus } from '../src/adapters/smtp/errors.js';
import { runProviderContract, outboundMessage, type ContractHarness } from '../src/testing/contract.js';
import type { ErrorKind, ProviderCredentials } from '../src/port.js';

/**
 * SMTP, against a scripted transport.
 *
 * The credential here is the canary: nodemailer attaches the full connection
 * URL, password included, to its errors, and the server's response text is
 * echoed verbatim. This is the exact case review finding F22 describes.
 */

const CREDENTIALS: ProviderCredentials = {
  type: 'smtp',
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: 'postmaster@example.com',
  pass: 'SECRET-CANARY-9f3a',
};

/** An error shaped the way nodemailer really produces them. */
function smtpError(
  code: string,
  message: string,
  responseCode?: number,
  response?: string,
): Error {
  return Object.assign(new Error(message), {
    code,
    ...(responseCode === undefined ? {} : { responseCode }),
    ...(response === undefined ? {} : { response }),
    command: 'DATA',
    // nodemailer really does carry this.
    url: `smtp://postmaster%40example.com:SECRET-CANARY-9f3a@smtp.example.com:587`,
  });
}

const SCRIPTED: Partial<Record<ErrorKind, () => Error>> = {
  auth_failed: () => smtpError('EAUTH', 'Invalid login', 535, '535 5.7.8 Authentication credentials invalid'),
  rate_limited: () =>
    smtpError('EENVELOPE', 'Too many messages', 421, '421 4.7.0 Too many messages from this sender, slow down'),
  invalid_recipient: () =>
    smtpError('EENVELOPE', 'User unknown', 550, '550 5.1.1 <nobody@example.com>: User unknown'),
  invalid_sender: () =>
    smtpError('EENVELOPE', 'Sender rejected', 553, '553 5.1.8 Sender address rejected: not owned by user'),
  content_rejected: () =>
    smtpError('EMESSAGE', 'Rejected as spam', 554, '554 5.7.1 Message rejected as spam'),
  message_too_large: () =>
    smtpError('EMESSAGE', 'Message too big', 552, '552 5.3.4 Message size exceeds fixed maximum'),
  provider_unavailable: () => smtpError('ECONNECTION', 'Connection refused'),
  timeout: () => smtpError('ETIMEDOUT', 'Greeting never received'),
  unknown: () => smtpError('EODD', 'something the library has never seen'),
  // quota_exceeded has no SMTP expression: a server that is out of space
  // reports 452, which is a rate limit, not a daily quota.
};

describe('smtp adapter', () => {
  runProviderContract((): ContractHarness => {
    let failure: ErrorKind | null = null;
    let hang = false;

    const transport: SmtpTransport = {
      async sendMail() {
        if (hang) return new Promise(() => undefined);

        if (failure !== null) {
          const make = SCRIPTED[failure];
          if (make !== undefined) throw make();
        }

        return { messageId: '<generated@relayd.test>', response: '250 2.0.0 Ok: queued' };
      },
      async verify() {
        if (failure === 'auth_failed') throw SCRIPTED.auth_failed?.() ?? new Error('nope');
        return true;
      },
    };

    return {
      name: 'smtp',
      adapter: createSmtpAdapter(() => transport),
      credentials: CREDENTIALS,

      scriptFailure(kind: ErrorKind): boolean {
        if (SCRIPTED[kind] === undefined) return false;
        failure = kind;
        return true;
      },

      scriptHang(): void {
        hang = true;
      },

      reset(): void {
        failure = null;
        hang = false;
      },

      // No webhook block: SMTP has none, and the contract skips those cases
      // rather than pretending otherwise.
    };
  });
});

describe('what SMTP honestly cannot do', () => {
  const adapter = createSmtpAdapter(() => ({
    async sendMail() {
      return { messageId: '<x@relayd.test>' };
    },
  }));

  it('declares no webhook support, which is what drives the best-effort label', () => {
    // D4: without webhooks there is no asynchronous bounce data at all, so a
    // workspace sending over SMTP accumulates bad addresses invisibly.
    expect(adapter.capabilities.supportsWebhooks).toBe(false);
    expect(adapter.capabilities.reportsQuota).toBe(false);
  });

  it('refuses a webhook payload rather than accepting one it cannot verify', async () => {
    // An SMTP connection receiving a payload is receiving something nobody
    // sent. Accepting it would let anyone write events against that
    // workspace.
    expect(adapter.verifyWebhookSignature(Buffer.from('{}'), {}, 'any-secret')).toBe(false);
    expect(adapter.parseWebhook(Buffer.from('{}'), {})).toEqual([]);
  });

  it('reports no quota rather than inventing one', async () => {
    expect(await adapter.getQuota(CREDENTIALS)).toBeNull();
  });

  it('claims no verified identities', async () => {
    // Claiming one would put a green tick next to a guess. The server accepts
    // or refuses MAIL FROM at send time and nothing else knows.
    expect(await adapter.listVerifiedIdentities(CREDENTIALS)).toEqual([]);
  });

  it('sends one message at a time', async () => {
    expect(adapter.capabilities.maxBatchSize).toBe(1);
  });
});

describe('the credential never escapes', () => {
  it('is absent from a failed send, though nodemailer attached it', async () => {
    const adapter = createSmtpAdapter(() => ({
      async sendMail() {
        throw smtpError('EAUTH', 'Invalid login: 535 5.7.8', 535, '535 5.7.8 Authentication failed');
      },
    }));

    const outcome = await adapter.send(CREDENTIALS, outboundMessage('r1'));
    expect(JSON.stringify(outcome)).not.toContain('SECRET-CANARY-9f3a');
  });

  it('is absent when the server quotes it back in its response', async () => {
    const adapter = createSmtpAdapter(() => ({
      async sendMail() {
        throw smtpError(
          'EAUTH',
          'auth failed',
          535,
          '535 5.7.8 Error: authentication failed for user=postmaster pass=SECRET-CANARY-9f3a',
        );
      },
    }));

    const outcome = await adapter.send(CREDENTIALS, outboundMessage('r1'));
    expect(JSON.stringify(outcome)).not.toContain('SECRET-CANARY-9f3a');
  });

  it('is absent even when no pattern could recognise it', async () => {
    // Every classified branch writes its own message and never quotes the
    // server, so nothing can escape through those. The one branch that does
    // echo the original is the unclassified fallback — reached here with a
    // code nothing recognises — and the password in it is a bare word that no
    // pattern can distinguish from prose. Only knowing the credential in play
    // removes it.
    const plain: ProviderCredentials = {
      type: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'postmaster@example.com',
      pass: 'correcthorsebatterystaple',
    };

    const adapter = createSmtpAdapter(() => ({
      async sendMail() {
        throw smtpError('ENOVELCODE', 'rejected: the password correcthorsebatterystaple is wrong');
      },
    }));

    const outcome = await adapter.send(plain, outboundMessage('r1'));

    expect(outcome.ok === false && outcome.error.kind).toBe('unknown');
    expect(JSON.stringify(outcome)).not.toContain('correcthorsebatterystaple');
  });

  it('quotes the server only in the unclassified case, and never otherwise', async () => {
    // Worth pinning: the classified branches are safe because they
    // reconstruct rather than filter, and a future branch that started
    // quoting error.message would silently change that.
    const classified = classifySmtpError(
      smtpError('EENVELOPE', 'secret-in-message', 550, '550 5.1.1 secret-in-response'),
    );

    expect(classified.message).not.toContain('secret-in-message');
    expect(classified.message).not.toContain('secret-in-response');
  });

  it('is absent from a failed verification', async () => {
    const adapter = createSmtpAdapter(() => ({
      async sendMail() {
        return {};
      },
      async verify() {
        throw smtpError('EAUTH', 'Invalid login', 535, '535 5.7.8 nope');
      },
    }));

    const result = await adapter.verifyConnection(CREDENTIALS);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET-CANARY-9f3a');
  });
});

describe('enhanced status codes', () => {
  it('reads the code where RFC 3463 puts it', () => {
    expect(enhancedStatus('550 5.1.1 User unknown')).toBe('5.1.1');
    expect(enhancedStatus('421-4.7.0 Slow down')).toBe('4.7.0');
    expect(enhancedStatus('250 2.0.0 Ok')).toBe('2.0.0');
  });

  it('does not find one where there is none', () => {
    // A bare search would happily match a version number in a banner.
    expect(enhancedStatus('220 smtp.example.com ESMTP Postfix 3.5.9')).toBeNull();
    expect(enhancedStatus('250 Ok')).toBeNull();
    expect(enhancedStatus(undefined)).toBeNull();
  });

  it('prefers the enhanced code over the reply code', () => {
    // 550 alone reads as a bad recipient; 5.7.1 says the message was refused
    // by policy, which is a content problem and must not suppress the address.
    const error = classifySmtpError(
      smtpError('EMESSAGE', 'blocked', 550, '550 5.7.1 Message refused by policy'),
    );

    expect(error.kind).toBe('content_rejected');
  });
});

describe('smtp classification', () => {
  it('suppresses an unknown mailbox', () => {
    const error = classifySmtpError(
      smtpError('EENVELOPE', 'User unknown', 550, '550 5.1.1 User unknown'),
    );

    expect(error.kind).toBe('invalid_recipient');
    expect(error.retryable).toBe(false);
  });

  it('does not suppress a full mailbox', () => {
    // A full mailbox is somebody on holiday. Suppressing loses a real
    // contact permanently — even when the server reports it as 5.2.2, which
    // several do despite the class being wrong.
    for (const response of ['452 4.2.2 Mailbox full', '552 5.2.2 Mailbox full']) {
      const error = classifySmtpError(smtpError('EENVELOPE', 'full', undefined, response));
      expect(error.kind, response).toBe('provider_unavailable');
      expect(error.retryable, response).toBe(true);
    }
  });

  it('treats a transient addressing failure as retryable', () => {
    const error = classifySmtpError(
      smtpError('EENVELOPE', 'try later', 450, '450 4.1.1 Recipient temporarily unavailable'),
    );

    expect(error.retryable).toBe(true);
    expect(error.kind).not.toBe('invalid_recipient');
  });

  it('separates a sender problem from a recipient problem', () => {
    const error = classifySmtpError(
      smtpError('EENVELOPE', 'nope', 553, '553 5.1.8 Sender address rejected'),
    );

    expect(error.kind).toBe('invalid_sender');
    expect(error.affects).toBe('sender');
  });

  it('reads a policy throttle as a rate limit, not a rejection', () => {
    const error = classifySmtpError(
      smtpError('EENVELOPE', 'slow', 421, '421 4.7.0 Too many messages, slow down'),
    );

    expect(error.kind).toBe('rate_limited');
    expect(error.retryable).toBe(true);
  });

  it('reads an authentication rejection from 5.7.8', () => {
    const error = classifySmtpError(
      smtpError('EMESSAGE', 'no', 535, '535 5.7.8 Authentication credentials invalid'),
    );

    expect(error.kind).toBe('auth_failed');
    expect(error.affects).toBe('connection');
  });

  it('treats a TLS failure as unavailable rather than retrying forever', () => {
    const error = classifySmtpError(smtpError('ESOCKET', 'wrong version number'));
    expect(error.kind).toBe('provider_unavailable');
  });

  it('falls back to the reply class when there is nothing else', () => {
    expect(classifySmtpError(smtpError('EX', 'x', 451)).retryable).toBe(true);
    expect(classifySmtpError(smtpError('EX', 'x', 501)).retryable).toBe(false);
  });

  it('refuses credentials for another provider', async () => {
    const adapter = createSmtpAdapter(() => ({
      async sendMail() {
        return {};
      },
    }));

    const outcome = await adapter.send({ type: 'sendgrid', apiKey: 'x' }, outboundMessage('r1'));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.kind).toBe('auth_failed');
  });
});

describe('the message it builds', () => {
  it('carries List-Unsubscribe and the one-click header', async () => {
    let captured: Record<string, unknown> = {};
    const adapter = createSmtpAdapter(() => ({
      async sendMail(options) {
        captured = options;
        return { messageId: '<x@relayd.test>' };
      },
    }));

    await adapter.send(CREDENTIALS, outboundMessage('r1'));

    const headers = captured['headers'] as Record<string, string>;
    expect(headers['List-Unsubscribe']).toContain('https://relayd.test/u/r1');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(captured['text']).toBe('Hello');
    expect(captured['html']).toBe('<p>Hello</p>');
  });

  it('sends a batch one at a time rather than opening a connection per message', async () => {
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;

    const adapter = createSmtpAdapter(() => ({
      async sendMail(options) {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(String((options['headers'] as Record<string, string>)['X-Relayd-Recipient']));
        concurrent -= 1;
        return { messageId: '<x@relayd.test>' };
      },
    }));

    await adapter.sendBatch(CREDENTIALS, ['a', 'b', 'c'].map(outboundMessage));

    expect(order).toEqual(['a', 'b', 'c']);
    // Firing all at once would open as many connections as the array is long
    // and get the customer's server to refuse the lot.
    expect(peak).toBe(1);
  });
});
