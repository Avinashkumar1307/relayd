import { createHash } from 'node:crypto';

/**
 * Bot and prefetch classification (docs/06 §13; INVARIANTS R6).
 *
 * An open is evidence that an image was fetched. It is not evidence that a
 * human read the email, and the gap between those two is 30–60% depending on
 * the audience's mail clients. Apple's Mail Privacy Protection prefetches
 * every image for every user who enabled it, which is most of them.
 *
 * So this classifies rather than filters. Raw events are always stored; the
 * two booleans travel with them and the UI decides what to show. Deleting a
 * bot open would make the numbers prettier and destroy the only evidence that
 * they were wrong.
 *
 * The signals available on the request path are the weak ones — user agent,
 * method, headers. The strong ones need state the edge does not have: how
 * long after `sent_at` the open arrived, whether the IP is in a scanner
 * range, whether three links were clicked in one second. Those are applied by
 * the event-ingest consumer, which has the recipient row in front of it.
 * Splitting them this way keeps the request path free of database reads.
 */

export interface BotVerdict {
  isBot: boolean;
  isPrefetch: boolean;
  /** Which rule fired, for the aggregate the UI shows honestly. */
  reason: string | null;
}

const NOT_A_BOT: BotVerdict = { isBot: false, isPrefetch: false, reason: null };

/**
 * Apple's Mail Privacy Protection proxy.
 *
 * It fetches every image in every message for a protected user, usually
 * within seconds of delivery and always from Apple's own infrastructure. Its
 * user agent is the one reliable signal available without an IP database.
 */
const PREFETCH_AGENTS: readonly RegExp[] = [
  // Apple MPP, which reports a generic Mac Safari-ish agent via its proxy.
  /\bMacOutlook\b/iu,
  /\bAppleMail\b/iu,
  // Gmail's image proxy fetches on display; it is a proxy, not a human.
  /\bGoogleImageProxy\b/iu,
  /\bYahooMailProxy\b/iu,
];

/**
 * Security scanners that walk every link in a message before delivering it.
 *
 * This list is deliberately of vendors rather than of generic words: matching
 * "bot" alone would classify a real user of a browser whose agent happens to
 * contain it, and there are more of those than people expect.
 */
const SCANNER_AGENTS: readonly RegExp[] = [
  /\bProofpoint\b/iu,
  /\bMimecast\b/iu,
  /\bBarracuda\b/iu,
  /\bSymantec\b/iu,
  /\bForcepoint\b/iu,
  /\bTrendMicro\b/iu,
  /\bMicrosoft Defender\b/iu,
  /\bSafeLinks\b/iu,
  /\bZScaler\b/iu,
  // Honest crawlers, which say so.
  /\bcurl\/|wget\/|python-requests\/|Go-http-client\/|libwww-perl\b/iu,
  /\bheadlesschrome\b/iu,
];

/**
 * Classifies from what a single request can see.
 *
 * Prefetch is checked before scanner: Apple's proxy is a prefetch rather than
 * a bot, and the distinction matters because a prefetched open still belongs
 * to a real recipient whose client asked for it.
 */
export function classifyBot(input: {
  userAgent: string;
  method: string;
  hasRangeHeader: boolean;
}): BotVerdict {
  const agent = input.userAgent;

  // A HEAD request for a pixel, or a Range request for 43 bytes, is not a
  // mail client rendering an image.
  if (input.method.toUpperCase() === 'HEAD') {
    return { isBot: true, isPrefetch: false, reason: 'head_request' };
  }

  if (input.hasRangeHeader) {
    return { isBot: true, isPrefetch: false, reason: 'range_request' };
  }

  // An empty user agent is not proof of anything, but no mail client sends
  // one and every naive script does.
  if (agent.trim() === '') {
    return { isBot: true, isPrefetch: false, reason: 'no_user_agent' };
  }

  for (const pattern of PREFETCH_AGENTS) {
    if (pattern.test(agent)) {
      return { isBot: false, isPrefetch: true, reason: 'prefetch_agent' };
    }
  }

  for (const pattern of SCANNER_AGENTS) {
    if (pattern.test(agent)) {
      return { isBot: true, isPrefetch: false, reason: 'scanner_agent' };
    }
  }

  return NOT_A_BOT;
}

/**
 * Whether an open arrived too soon after the send to be a person.
 *
 * Applied by the consumer, which knows `sent_at`. Two seconds is docs/06's
 * threshold and it is generous: nothing human opens a message, renders it and
 * fetches an image inside two seconds of the provider accepting it.
 */
export const PREFETCH_WINDOW_MS = 2_000;

export function isPrefetchByTiming(input: { sentAt: Date; occurredAt: Date }): boolean {
  const delta = input.occurredAt.getTime() - input.sentAt.getTime();
  // A negative delta means clock skew between the sender and the edge, which
  // is certainly not a human reading it either.
  return delta < PREFETCH_WINDOW_MS;
}

/**
 * Hashes an IP with the day's rotating salt.
 *
 * The raw address is never stored. The salt rotates daily so the hashes
 * cannot be correlated across days, which is what stops the column becoming a
 * pseudonymous identifier in everything but name — and a daily salt keeps the
 * five-minute dedup window working, which is all the hash is actually for.
 *
 * Country is derived before hashing and stored separately, because it is
 * genuinely useful and is not identifying on its own.
 */
export function hashIp(ip: string, salt: string): string {
  if (ip === '') return '';

  // The salt is reduced to a fixed 32 bytes before the address is appended.
  // Concatenating them directly would make ("ab", "cde") and ("abc", "de")
  // the same input, and a fixed-length prefix settles that without needing a
  // separator byte — which matters here because IPv6 addresses contain most
  // of the punctuation one would reach for.
  const saltDigest = createHash('sha256').update(salt).digest();

  return createHash('sha256').update(saltDigest).update(ip).digest('base64url').slice(0, 22);
}

/** The dedup key for one event. An open from the same client within 5 minutes is one open. */
export function dedupeKey(input: {
  messageToken: Buffer;
  kind: string;
  linkIndex: number;
  ipHash: string;
  userAgent: string;
}): string {
  return createHash('sha256')
    .update(input.messageToken)
    .update(input.kind)
    .update(String(input.linkIndex))
    .update(input.ipHash)
    .update(createHash('sha256').update(input.userAgent).digest())
    .digest('base64url');
}

export const DEDUPE_WINDOW_MS = 5 * 60_000;
