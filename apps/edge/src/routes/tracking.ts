import { Router, type Request, type Response } from 'express';
import {
  TrackingTokenError,
  verifyTrackingToken,
  type TrackingKey,
  type TrackingPayload,
} from '@relayd/utils';
import { classifyBot, hashIp, type BotVerdict } from '../tracking/bots.js';

/**
 * The tracking endpoints (docs/06 §13; INVARIANTS R6).
 *
 * Three routes, all public, all unauthenticated, all hit by every scanner
 * that touches a customer's mail. The shape of every one of them is the same
 * and it is the opposite of the usual order:
 *
 *   verify the MAC → respond → do the work
 *
 * Responding first is not an optimisation. A slow pixel makes the customer's
 * email look broken and a slow redirect makes it look untrustworthy, and both
 * are judged by the recipient, who has no idea we exist. p99 under 20ms means
 * nothing on the request path may touch Postgres.
 *
 * The MAC check is what makes that possible: garbage is rejected in
 * microseconds without a database hit, so a link scanner walking a mailshot
 * costs us CPU and nothing else.
 *
 * Two security properties live here rather than in the token:
 *
 *   A click resolves its destination from `tracked_links` by index. The token
 *   cannot carry a URL, so an open redirect is unrepresentable rather than
 *   merely blocked.
 *
 *   `GET /u/:token` renders a confirmation page and changes nothing. Only
 *   POST unsubscribes (R6, RFC 8058). Scanners issue GETs constantly, and a
 *   GET that unsubscribes means a corporate mail filter silently removes
 *   every recipient it protects.
 */

/** A 1×1 transparent GIF. The smallest thing that is still an image. */
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export interface TrackingDependencies {
  keys: readonly TrackingKey[];

  /** Today's IP-hashing salt. Rotated daily, never stored alongside the hash. */
  ipSalt: string;

  /**
   * Enqueues a raw event. Batched by the implementation; this route never
   * waits for it, because the response has already been sent.
   */
  enqueueEvent(event: TrackingEvent): void;

  /**
   * The destination for one click, from the Redis-cached `tracked_links` row.
   *
   * Returns null when the index is out of range for that campaign, which is
   * the only outcome an attacker can produce by editing a signed token they
   * cannot sign.
   */
  resolveLink(input: { messageToken: Buffer; linkIndex: number }): Promise<string | null>;

  /** Where a click with no resolvable destination goes. */
  fallbackUrl: string;

  /** Renders the GET confirmation page. */
  renderUnsubscribeConfirmation(token: string): string;

  /** Records the unsubscribe. POST only. */
  unsubscribe(input: { messageToken: Buffer; ipHash: string }): Promise<void>;

  logger: { warn(fields: Record<string, unknown>, message: string): void };
}

export interface TrackingEvent {
  kind: 'open' | 'click' | 'unsubscribe';
  messageToken: Buffer;
  linkIndex: number;
  occurredAt: Date;
  ipHash: string;
  userAgent: string;
  bot: BotVerdict;
}

export function trackingRoutes(deps: TrackingDependencies): Router {
  const router = Router();

  // GET /o/:token.gif — the open pixel.
  router.get('/o/:token.gif', (request, response) => {
    const payload = verified(request, response, deps, 'open');
    if (payload === null) return;

    // Answer first. Everything below this line is bookkeeping.
    sendPixel(response);
    record(deps, request, payload, 'open');
  });

  // Some clients request the pixel with HEAD, and a few send a Range header.
  // Both are answered identically and classified as bots; refusing them makes
  // the image look broken in exactly the clients that are strictest about it.
  router.head('/o/:token.gif', (request, response) => {
    const payload = verified(request, response, deps, 'open');
    if (payload === null) return;

    sendPixel(response);
    record(deps, request, payload, 'open');
  });

  // GET /c/:token — the click redirect.
  router.get('/c/:token', (request, response, next) => {
    const payload = verified(request, response, deps, 'click');
    if (payload === null) return;

    deps
      .resolveLink({ messageToken: payload.messageToken, linkIndex: payload.linkIndex })
      .then((url) => {
        // A missing link is a campaign that changed, not an attack. Sending
        // the reader to the workspace's fallback is better than an error
        // page they cannot act on.
        response.redirect(302, url ?? deps.fallbackUrl);
        record(deps, request, payload, 'click');
      })
      .catch(next);
  });

  // GET /u/:token — the confirmation page. Changes nothing (R6).
  router.get('/u/:token', (request, response) => {
    const payload = verified(request, response, deps, 'unsubscribe');
    if (payload === null) return;

    response
      .status(200)
      .type('html')
      .set('Cache-Control', 'no-store')
      .send(deps.renderUnsubscribeConfirmation(String(request.params['token'])));
  });

  // POST /u/:token — one-click unsubscribe (RFC 8058). This one acts.
  router.post('/u/:token', (request, response, next) => {
    const payload = verified(request, response, deps, 'unsubscribe');
    if (payload === null) return;

    const ipHash = hashIp(clientIp(request), deps.ipSalt);

    deps
      .unsubscribe({ messageToken: payload.messageToken, ipHash })
      .then(() => {
        response.status(200).type('text/plain').send('Unsubscribed');
        record(deps, request, payload, 'unsubscribe');
      })
      .catch(next);
  });

  return router;
}

/**
 * Verifies the token, or answers and returns null.
 *
 * A forged token gets the same 404 whatever is wrong with it. Distinguishing
 * "bad MAC" from "unknown kind" in the response would turn the endpoint into
 * an oracle for probing the token format.
 */
function verified(
  request: Request,
  response: Response,
  deps: TrackingDependencies,
  expected: TrackingPayload['kind'],
): TrackingPayload | null {
  const token = String(request.params['token'] ?? '');

  let payload: TrackingPayload;
  try {
    payload = verifyTrackingToken(token, deps.keys);
  } catch (error) {
    const reason = error instanceof TrackingTokenError ? error.reason : 'unknown';
    deps.logger.warn({ reason, path: request.path }, 'Rejected a tracking token');
    response.status(404).type('text/plain').send('Not found');
    return null;
  }

  // The kind is signed, so this can only fail when a valid token for one
  // endpoint is replayed against another — which the signature already makes
  // impossible, and which is checked anyway because "impossible" here rests
  // on the kind byte being inside the MAC.
  if (payload.kind !== expected) {
    deps.logger.warn(
      { reason: 'wrong_kind', expected, actual: payload.kind },
      'Rejected a tracking token',
    );
    response.status(404).type('text/plain').send('Not found');
    return null;
  }

  return payload;
}

function sendPixel(response: Response): void {
  response
    .status(200)
    .set({
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL.length),
      // Without no-store a corporate proxy caches the pixel and the second
      // open never reaches us — or worse, every recipient behind that proxy
      // shares one cached response.
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
    })
    .send(PIXEL);
}

/** Classifies and enqueues. Runs after the response; never throws into it. */
function record(
  deps: TrackingDependencies,
  request: Request,
  payload: TrackingPayload,
  kind: TrackingEvent['kind'],
): void {
  try {
    const userAgent = String(request.get('user-agent') ?? '');

    deps.enqueueEvent({
      kind,
      messageToken: payload.messageToken,
      linkIndex: payload.linkIndex,
      occurredAt: new Date(),
      ipHash: hashIp(clientIp(request), deps.ipSalt),
      userAgent,
      bot: classifyBot({
        userAgent,
        method: request.method,
        hasRangeHeader: request.get('range') !== undefined,
      }),
    });
  } catch (error) {
    // The response is already sent. An enqueue that throws must not become an
    // unhandled rejection that takes the process with it.
    deps.logger.warn(
      { error: error instanceof Error ? error.message : 'unknown' },
      'Failed to enqueue a tracking event',
    );
  }
}

function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? '';
}
