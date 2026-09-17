import { asProviderError, providerError } from '../../errors.js';
import type { ProviderError } from '../../port.js';

/**
 * SMTP error classification.
 *
 * SMTP says more about *why* a message failed than any API provider, and it
 * says it in two places: the three-digit reply code and the enhanced status
 * code (RFC 3463) inside the response text. The enhanced code is the more
 * precise of the two and is used first where present.
 *
 * This is also the single most dangerous place in the codebase for credential
 * leakage (review finding F22): nodemailer attaches the full connection URL —
 * including the password — to its errors, and the SMTP server's own response
 * text is echoed verbatim. Nothing from the original error reaches the result
 * except a message that has been through `redact`, which `providerError` does.
 */

interface SmtpErrorShape {
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
  message?: string;
}

function read(cause: unknown): SmtpErrorShape {
  if (typeof cause !== 'object' || cause === null) return {};
  const record = cause as Record<string, unknown>;

  return {
    ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
    ...(typeof record['responseCode'] === 'number' ? { responseCode: record['responseCode'] } : {}),
    ...(typeof record['response'] === 'string' ? { response: record['response'] } : {}),
    ...(typeof record['command'] === 'string' ? { command: record['command'] } : {}),
    ...(typeof record['message'] === 'string' ? { message: record['message'] } : {}),
  };
}

/**
 * The RFC 3463 enhanced status code, if the response carries one.
 *
 * Matched only at the start of the response text, where the RFC puts it — a
 * bare search would happily find a version number in a server banner.
 */
export function enhancedStatus(response: string | undefined): string | null {
  if (response === undefined) return null;
  // "550 5.1.1 User unknown" — the reply code, then the enhanced code.
  const match = /^\s*\d{3}[\s-]+([245])\.(\d{1,3})\.(\d{1,3})\b/u.exec(response);
  return match === null ? null : `${match[1] as string}.${match[2] as string}.${match[3] as string}`;
}

/**
 * Enhanced status codes worth distinguishing.
 *
 * The leading digit is the class — 4 transient, 5 permanent — and the rest
 * says what went wrong. Only the ones that change what we do are listed; the
 * class alone decides the rest.
 */
function fromEnhanced(code: string): ProviderError | null {
  const [classDigit, subject, detail] = code.split('.');
  const permanent = classDigit === '5';

  // x.1.x — addressing
  if (subject === '1') {
    switch (detail) {
      case '1': // Bad destination mailbox address
      case '2': // Bad destination system address
      case '3': // Bad destination mailbox address syntax
      case '6': // Mailbox has moved
        return permanent
          ? providerError('invalid_recipient', `SMTP ${code}: the recipient address was rejected`)
          : providerError('provider_unavailable', `SMTP ${code}: the recipient is temporarily unavailable`);
      case '7': // Bad sender's mailbox address syntax
      case '8': // Bad sender's system address
        return providerError('invalid_sender', `SMTP ${code}: the sender address was rejected`);
      default:
        break;
    }
  }

  // x.2.x — mailbox status
  if (subject === '2') {
    if (detail === '2') {
      // Mailbox full: transient even when reported as 5.2.2 by servers that
      // should know better. Suppressing on a full mailbox loses a real
      // contact who is simply on holiday.
      return providerError('provider_unavailable', `SMTP ${code}: the mailbox is full`);
    }
    if (detail === '3') {
      return providerError('message_too_large', `SMTP ${code}: the message is larger than the mailbox allows`);
    }
  }

  // x.3.x — mail system status
  if (subject === '3') {
    if (detail === '1' || detail === '2') {
      return providerError('provider_unavailable', `SMTP ${code}: the mail system is unavailable`);
    }
    if (detail === '4') {
      return providerError('message_too_large', `SMTP ${code}: the message exceeds the size limit`);
    }
  }

  // x.4.x — network and routing
  if (subject === '4') {
    if (detail === '2' || detail === '5') {
      return providerError('rate_limited', `SMTP ${code}: the server asked us to slow down`);
    }
    return providerError(permanent ? 'provider_unavailable' : 'timeout', `SMTP ${code}: a routing problem`);
  }

  // x.5.x — protocol
  if (subject === '5') {
    return providerError('content_rejected', `SMTP ${code}: the server rejected the message`);
  }

  // x.7.x — policy and security
  if (subject === '7') {
    if (detail === '0' || detail === '1') {
      // Delivery not authorised / message refused by policy. Permanent means
      // blocked, which is a content or reputation problem, not a bad address.
      return permanent
        ? providerError('content_rejected', `SMTP ${code}: the message was refused by policy`)
        : providerError('rate_limited', `SMTP ${code}: throttled by policy`);
    }
    if (detail === '8' || detail === '9') {
      return providerError('auth_failed', `SMTP ${code}: authentication was rejected`);
    }
    return providerError(permanent ? 'content_rejected' : 'rate_limited', `SMTP ${code}: a policy restriction`);
  }

  return null;
}

/** Reply codes, used when there is no enhanced status to go on. */
function fromReplyCode(code: number): ProviderError | null {
  switch (code) {
    case 421:
      return providerError('provider_unavailable', 'SMTP 421: the service is not available');
    case 450:
    case 451:
      return providerError('provider_unavailable', `SMTP ${code}: a temporary failure`);
    case 452:
      return providerError('rate_limited', 'SMTP 452: insufficient system storage');
    case 454:
      return providerError('auth_failed', 'SMTP 454: authentication failed temporarily');
    case 500:
    case 501:
    case 502:
    case 503:
    case 504:
      return providerError('content_rejected', `SMTP ${code}: the server rejected the command`);
    case 521:
    case 541:
      return providerError('content_rejected', `SMTP ${code}: the server does not accept mail`);
    case 530:
    case 535:
      return providerError('auth_failed', `SMTP ${code}: authentication required or rejected`);
    case 550:
    case 551:
    case 553:
      return providerError('invalid_recipient', `SMTP ${code}: the recipient was rejected`);
    case 552:
      return providerError('message_too_large', 'SMTP 552: the message exceeded the size limit');
    case 554:
      return providerError('content_rejected', 'SMTP 554: the transaction failed');
    default:
      return null;
  }
}

export function classifySmtpError(cause: unknown, secrets: readonly string[] = []): ProviderError {
  const passthrough = asProviderError(cause);
  if (passthrough !== null) return passthrough;

  const error = read(cause);

  // Connection-level codes first: these describe failures that never got far
  // enough to produce a reply code, so there is nothing more precise to find.
  //
  // EMESSAGE and EENVELOPE are deliberately NOT here. They mean only "the
  // server refused the message" and "the server refused the envelope", while
  // the response beside them carries the enhanced status that says why —
  // whether the mailbox is unknown, the mailbox is full, or the message is
  // too large. Reading the library's code first would flatten all three into
  // content_rejected.
  switch (error.code) {
    case 'EAUTH':
      return providerError('auth_failed', 'The SMTP server rejected these credentials');
    case 'ECONNREFUSED':
    case 'ECONNECTION':
    case 'EDNS':
    case 'ENOTFOUND':
      return providerError('provider_unavailable', 'The SMTP server could not be reached');
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return providerError('timeout', 'The SMTP server did not respond in time');
    case 'ESOCKET':
      // A TLS failure lands here. Not retryable in any useful sense: the
      // certificate will be just as wrong on the next attempt.
      return providerError('provider_unavailable', 'The SMTP connection failed, possibly a TLS problem');
    default:
      break;
  }

  const enhanced = enhancedStatus(error.response);
  if (enhanced !== null) {
    const classified = fromEnhanced(enhanced);
    if (classified !== null) return classified;
  }

  if (error.responseCode !== undefined) {
    const classified = fromReplyCode(error.responseCode);
    if (classified !== null) return classified;

    // Fall back to the class: 4xx transient, 5xx permanent.
    if (error.responseCode >= 400 && error.responseCode < 500) {
      return providerError('provider_unavailable', `SMTP ${error.responseCode}: a temporary failure`);
    }
    if (error.responseCode >= 500) {
      return providerError('content_rejected', `SMTP ${error.responseCode}: the message was rejected`);
    }
  }

  // Only now, with no reply code and no enhanced status to go on, is the
  // library's own code the best thing available.
  if (error.code === 'EENVELOPE') {
    return providerError('invalid_recipient', 'The SMTP server rejected the envelope');
  }
  if (error.code === 'EMESSAGE') {
    return providerError('content_rejected', 'The SMTP server rejected the message');
  }

  // The message is redacted by providerError. It is included because without
  // it an unclassified SMTP failure is undiagnosable.
  return providerError('unknown', error.message ?? 'The SMTP server returned an error', { secrets });
}
