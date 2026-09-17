import express, { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Logger } from '@relayd/logger';
import { webhookHandlerFor } from '@relayd/email-providers/webhooks';
import type { NormalisedEmailEvent, ProviderType } from '@relayd/email-providers/webhooks';

/**
 * Per-connection provider webhook ingest (INVARIANTS R4, review finding F4).
 *
 * F4 is the most serious finding in the review. With one endpoint per provider
 * — `POST /ingest/sendgrid` — a workspace that has connected their own
 * SendGrid account learns the message-id format and posts a crafted complaint
 * for a message belonging to another workspace. If the endpoint verifies only
 * that the payload is well-formed, or against one global secret shared by all
 * customers, that is a cross-tenant write through an unauthenticated public
 * endpoint: suppressions appear in someone else's audience and complaint
 * events trip their 0.3% auto-pause.
 *
 * Four things prevent it here, and all four are necessary:
 *
 *   1. The URL carries an unguessable per-connection token. It resolves to
 *      exactly one connection, and therefore to exactly one workspace.
 *   2. The signature is verified with that connection's own secret.
 *   3. The event is stored against that connection. Matching it to a
 *      recipient happens later, scoped to (workspace_id, connection_id).
 *   4. An event matching nothing is stored with matched = false and never
 *      applied. It is evidence, not an instruction.
 *
 * The route's own job is narrow: verify, store, return 200 in under 200 ms.
 * Interpretation is the worker's (CLAUDE.md §3 — edge writes to the queue
 * only).
 */

export interface ResolvedConnection {
  connectionId: string;
  workspaceId: string;
  providerType: ProviderType;
  /** The connection's own webhook secret, already fetched. */
  webhookSecret: string;
  /** Disabled connections stop accepting events. */
  active: boolean;
}

export interface IngestDependencies {
  logger: Logger;

  /**
   * Resolves an endpoint token to one connection, or null.
   *
   * Crosses tenants by definition — no workspace is known until it returns —
   * so it is one of the explicitly named cross-tenant lookups.
   */
  resolveEndpointToken(token: string): Promise<ResolvedConnection | null>;

  /**
   * Stores a verified event. Returns false when the dedupe key was already
   * present, which is not an error — every provider redelivers.
   */
  storeEvent(input: {
    workspaceId: string;
    connectionId: string;
    providerType: ProviderType;
    dedupeKey: string;
    event: NormalisedEmailEvent | null;
    payload: unknown;
  }): Promise<boolean>;

  /** Enqueues interpretation. The route never interprets. */
  enqueue(input: { workspaceId: string; connectionId: string; count: number }): Promise<void>;

  /** Bounded: a provider posting 10 MB is a provider we stop reading. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1024 * 1024;

/**
 * A token that is at least plausibly one of ours.
 *
 * Checked before any lookup so a scanner spraying paths costs a regex rather
 * than a database round trip.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/u;

export function ingestRoutes(deps: IngestDependencies): Router {
  const router = Router();
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;

  /**
   * The raw body, preserved.
   *
   * Every signature scheme signs the bytes that were sent. Re-serialising
   * parsed JSON changes them — key order, whitespace, number formatting — and
   * the signature stops matching. docs/06: "Mount the raw body parser on
   * webhook routes before the JSON parser, or signatures silently break."
   */
  const rawBody = express.raw({ type: '*/*', limit: maxBodyBytes });

  router.post(
    '/ingest/v1/:provider/:token',
    rawBody,
    async (req: Request, res: Response): Promise<void> => {
      const token = String(req.params['token'] ?? '');
      const providerParam = String(req.params['provider'] ?? '');

      // Uniform response for every rejection below, and uniform timing as far
      // as is practical: a distinguishable 404 tells a scanner which tokens
      // exist.
      const refuse = (reason: string): void => {
        deps.logger.warn({ reason, provider: providerParam }, 'ingest rejected');
        res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
      };

      if (!TOKEN_SHAPE.test(token)) {
        refuse('malformed_token');
        return;
      }

      const connection = await deps.resolveEndpointToken(token);
      if (connection === null) {
        refuse('unknown_token');
        return;
      }

      // The provider in the path must match the connection the token
      // resolved to. Otherwise a token for an SMTP connection could be used
      // to post SendGrid-shaped events, and the adapter chosen would be one
      // the customer never connected.
      if (connection.providerType !== providerParam) {
        refuse('provider_mismatch');
        return;
      }

      if (!connection.active) {
        refuse('connection_inactive');
        return;
      }

      // Null for a provider with no webhooks at all — SMTP. A payload for
      // one of those is something nobody sent.
      const handler = webhookHandlerFor(connection.providerType);
      if (handler === null) {
        refuse('provider_has_no_webhooks');
        return;
      }

      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = lowercaseHeaders(req.headers);

      // Verified with this connection's own secret. A signature that is valid
      // for someone else's connection is worthless here, which is the whole
      // of F4's fix.
      if (!handler.verify(raw, headers, connection.webhookSecret)) {
        deps.logger.warn(
          { workspaceId: connection.workspaceId, connectionId: connection.connectionId },
          'ingest signature rejected',
        );
        res.status(401).json({ error: { code: 'unauthenticated', message: 'Invalid signature' } });
        return;
      }

      let events: NormalisedEmailEvent[];
      try {
        events = handler.parse(raw, headers);
      } catch {
        // The signature was valid, so this really came from the provider.
        // Store nothing we cannot read, but do not tell them to retry: a
        // payload we cannot parse will not parse next time either.
        deps.logger.error(
          { workspaceId: connection.workspaceId, connectionId: connection.connectionId },
          'ingest payload could not be parsed',
        );
        res.status(202).json({ data: { received: 0 } });
        return;
      }

      let stored = 0;

      if (events.length === 0) {
        // A signed payload that yields no events is still worth keeping: an
        // SNS subscription confirmation, or an event type this adapter does
        // not model yet. Stored unparsed, matched = false, applied never.
        const inserted = await deps.storeEvent({
          workspaceId: connection.workspaceId,
          connectionId: connection.connectionId,
          providerType: connection.providerType,
          dedupeKey: hashBody(raw),
          event: null,
          payload: safeJson(raw),
        });
        if (inserted) stored += 1;
      }

      for (const event of events) {
        const inserted = await deps.storeEvent({
          workspaceId: connection.workspaceId,
          connectionId: connection.connectionId,
          providerType: connection.providerType,
          dedupeKey: event.providerEventId,
          event,
          payload: event.raw,
        });
        if (inserted) stored += 1;
      }

      if (stored > 0) {
        await deps.enqueue({
          workspaceId: connection.workspaceId,
          connectionId: connection.connectionId,
          count: stored,
        });
      }

      // 200 quickly, whatever happened downstream. A provider that does not
      // get a prompt 2xx retries, and several of them disable an endpoint
      // that keeps timing out.
      res.status(202).json({ data: { received: events.length, stored } });
    },
  );

  return router;
}

/**
 * A dedupe key for a payload with no event id of its own.
 *
 * A hash of the bytes, so a redelivery of the same payload collides with
 * itself and is stored once.
 */
export function hashBody(raw: Buffer): string {
  return `body:${createHash('sha256').update(raw).digest('hex')}`;
}

function safeJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    // Stored as text rather than discarded: an unparseable body from a
    // verified sender is exactly what someone will want to look at.
    return { unparsed: raw.toString('utf8').slice(0, 10_000) };
  }
}

function lowercaseHeaders(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(',');
  }

  return out;
}

/**
 * Constant-time comparison for a token.
 *
 * Exported for the resolver, which compares a stored token to a presented one.
 * A plain `===` returns as soon as two bytes differ, which leaks the length of
 * the matching prefix; with an unguessable token that is a thin channel, and
 * it is free to close.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
