import { createVerify } from 'node:crypto';

/**
 * SNS message signature verification.
 *
 * SES delivers events through SNS, and SNS signs each message with RSA over a
 * canonical string, publishing the certificate at a URL inside the message.
 *
 * The port's `verifyWebhookSignature` is synchronous, and fetching a
 * certificate is not — so the fetch belongs to the ingest layer, which caches
 * it and hands the PEM in as `secret`. That split is deliberate for a second
 * reason: the certificate URL comes out of an unauthenticated payload, so
 * fetching it without checking the host is a server-side request forgery, and
 * that check belongs with the rest of the SSRF validation rather than
 * scattered through an adapter.
 *
 * `isAmazonCertificateUrl` lives here so the ingest layer has one definition
 * to call.
 */

/**
 * The fields that are signed, in the order SNS specifies, per message type.
 *
 * Order is not incidental: the canonical string is built by concatenating
 * these keys and their values, and a different order produces a different
 * signature for the same message.
 */
const SIGNED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

export interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  SubscribeURL?: string;
  Token?: string;
}

/**
 * Builds the string SNS actually signed.
 *
 * Subject is included only when present — an absent optional field is omitted
 * entirely rather than signed as an empty string.
 */
export function canonicalString(envelope: SnsEnvelope): string | null {
  const type = envelope.Type;
  if (type === undefined) return null;

  const fields = SIGNED_FIELDS[type];
  if (fields === undefined) return null;

  let canonical = '';
  for (const field of fields) {
    const value = (envelope as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    canonical += `${field}\n${String(value)}\n`;
  }

  return canonical;
}

/**
 * True only for a real SNS certificate host.
 *
 * Anchored at both ends, and the region segment cannot contain a dot, so
 * `sns.eu-west-1.amazonaws.com.evil.test` does not match. Without this the
 * ingest layer would fetch a URL chosen by whoever posted the payload.
 */
export function isAmazonCertificateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u.test(parsed.hostname);
}

/**
 * Verifies an SNS message against a PEM certificate.
 *
 * Returns false for anything it cannot check — an unknown message type, a
 * missing signature, a certificate that will not parse. An unverifiable
 * message is not a trusted one.
 */
export function verifySnsSignature(raw: Buffer, certificatePem: string): boolean {
  if (certificatePem.trim() === '') return false;

  let envelope: SnsEnvelope;
  try {
    envelope = JSON.parse(raw.toString('utf8')) as SnsEnvelope;
  } catch {
    return false;
  }

  const signature = envelope.Signature;
  if (typeof signature !== 'string' || signature === '') return false;

  const canonical = canonicalString(envelope);
  if (canonical === null) return false;

  // Version 1 is RSA-SHA1, version 2 is RSA-SHA256. Anything else is refused
  // rather than guessed at.
  const algorithm =
    envelope.SignatureVersion === '2'
      ? 'RSA-SHA256'
      : envelope.SignatureVersion === '1'
        ? 'RSA-SHA1'
        : null;

  if (algorithm === null) return false;

  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonical, 'utf8');
    verifier.end();
    return verifier.verify(certificatePem, signature, 'base64');
  } catch {
    return false;
  }
}
