import { createVerify } from 'node:crypto';
import type { NormalisedEmailEvent } from '../../port.js';

/**
 * SendGrid's webhook half, kept apart from the sending half.
 *
 * Nothing here imports an SDK or touches the network, so `apps/edge` can
 * verify and parse an inbound event without pulling the sending machinery
 * into a public, internet-facing process. See docs/16.
 */

/**
 * The Signed Event Webhook.
 *
 * SendGrid signs `timestamp + payload` with ECDSA P-256 and publishes the
 * public key in the dashboard; `secret` is that key, base64 DER (SPKI).
 *
 * The timestamp is part of the signed material, which is what stops a captured
 * payload being replayed with a fresh timestamp — the signature would no
 * longer match.
 */
export function verifySendgridSignature(
  raw: Buffer,
  headers: Readonly<Record<string, string>>,
  publicKeyBase64: string,
): boolean {
  if (publicKeyBase64.trim() === '') return false;

  const signature = headers['x-twilio-email-event-webhook-signature'];
  const timestamp = headers['x-twilio-email-event-webhook-timestamp'];

  if (typeof signature !== 'string' || signature === '') return false;
  if (typeof timestamp !== 'string' || timestamp === '') return false;

  try {
    const verifier = createVerify('sha256');
    verifier.update(timestamp, 'utf8');
    verifier.update(raw);
    verifier.end();

    return verifier.verify(
      {
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      },
      signature,
      'base64',
    );
  } catch {
    return false;
  }
}

const EVENT_TYPES: Readonly<Record<string, NormalisedEmailEvent['type']>> = {
  delivered: 'delivered',
  bounce: 'bounce',
  blocked: 'bounce',
  dropped: 'reject',
  deferred: 'deferred',
  spamreport: 'complaint',
  unsubscribe: 'unsubscribe',
  group_unsubscribe: 'unsubscribe',
  open: 'open',
  click: 'click',
  processed: 'delivered',
};

export function parseSendgridEvents(raw: Buffer): NormalisedEmailEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const events: NormalisedEmailEvent[] = [];

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const event = String(record['event'] ?? '');
    const type = EVENT_TYPES[event];
    if (type === undefined) continue;

    const email = String(record['email'] ?? '');
    if (email === '') continue;

    // sg_event_id is SendGrid's own unique id and is stable across
    // redeliveries, which is exactly what the inbox deduplicates on.
    const eventId = String(record['sg_event_id'] ?? '');
    const messageId = record['sg_message_id'] === undefined ? undefined : String(record['sg_message_id']);

    const timestamp = Number(record['timestamp']);
    const occurredAt = Number.isFinite(timestamp) ? new Date(timestamp * 1000) : new Date();

    // `processed` and `delivered` both map to delivered, so the event name is
    // part of the fallback id or the two would collide and one be dropped.
    const fallbackId = `${messageId ?? email}:${event}:${String(record['timestamp'] ?? '')}`;

    events.push({
      providerEventId: eventId === '' ? fallbackId : eventId,
      type,
      recipientEmail: email,
      occurredAt,
      raw: entry,
      ...(messageId === undefined ? {} : { providerMessageId: messageId }),
      ...(type === 'bounce' ? { bounceClass: bounceClassOf(record) } : {}),
    });
  }

  return events;
}

function bounceClassOf(record: Record<string, unknown>): 'hard' | 'soft' | 'block' {
  if (String(record['event']) === 'blocked') return 'block';

  const type = String(record['type'] ?? '').toLowerCase();
  if (type === 'blocked') return 'block';
  // SendGrid's "bounce" type is a hard bounce; anything else it reports is
  // transient. Treating a soft bounce as hard suppresses a working address.
  return type === 'bounce' ? 'hard' : 'soft';
}
