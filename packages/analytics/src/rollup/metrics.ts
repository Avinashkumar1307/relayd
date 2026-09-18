/**
 * What the numbers mean, and which ones the UI is allowed to lead with.
 *
 * This file is small and unusually opinionated because the opinions are the
 * product decision from docs/06 §13, and the consequence of getting them
 * wrong is a customer making a business decision on a number that is wrong by
 * 30-60%.
 *
 * An open is evidence that an image was fetched. It is not evidence that a
 * human read the email. Apple's Mail Privacy Protection fetches every image
 * for every protected user; image blocking suppresses the rest. The error
 * runs in both directions and its size is unknowable per campaign.
 *
 * A click is evidence that something followed a link. Scanners do that too,
 * which is why `is_bot` exists — but the residual error is small and, crucially,
 * mostly one-directional.
 *
 * So: click rate is the headline. Open rate is secondary and always labelled.
 */

export type RateKind = 'click' | 'open' | 'bounce' | 'complaint' | 'unsubscribe' | 'delivery';

export interface RateDefinition {
  readonly numerator: string;
  readonly denominator: string;
  /** How much weight the UI should give it. */
  readonly confidence: 'reliable' | 'directional';
  /** Shown beside the number whenever confidence is not 'reliable'. */
  readonly caveat?: string;
}

export const RATE_DEFINITIONS: Readonly<Record<RateKind, RateDefinition>> = {
  click: {
    numerator: 'clicks_unique_nonbot',
    denominator: 'delivered',
    confidence: 'reliable',
  },
  open: {
    numerator: 'opens_unique_nonbot',
    denominator: 'delivered',
    confidence: 'directional',
    caveat:
      'Privacy features in some mail apps fetch images automatically, which inflates this, and image blocking suppresses it. Treat it as directional.',
  },
  bounce: {
    numerator: 'bounced_hard',
    denominator: 'sent',
    confidence: 'reliable',
  },
  complaint: {
    numerator: 'complained',
    denominator: 'delivered',
    confidence: 'reliable',
  },
  unsubscribe: {
    numerator: 'unsubscribed',
    denominator: 'delivered',
    confidence: 'reliable',
  },
  delivery: {
    numerator: 'delivered',
    denominator: 'sent',
    confidence: 'reliable',
  },
};

/** The one metric a campaign should be judged by. */
export const HEADLINE_RATE: RateKind = 'click';

export interface Rate {
  kind: RateKind;
  numerator: number;
  denominator: number;
  /** Null rather than zero when there is nothing to divide by. */
  value: number | null;
  confidence: RateDefinition['confidence'];
  caveat?: string;
  /**
   * How many events were excluded as automated (R6).
   *
   * Every rate response carries this, per BUILD-PLAN. A filtered number
   * without the size of the filter is a number the customer cannot check, and
   * "your open rate dropped when you moved to Relayd" is answered by showing
   * them what we removed rather than by arguing.
   */
  botFiltered: number;
}

/**
 * Computes one rate.
 *
 * A zero denominator gives null, never zero and never NaN. A campaign that
 * has delivered nothing has no click rate — reporting 0% would say the
 * campaign performed badly when in fact it has not been measured yet.
 */
export function rate(input: {
  kind: RateKind;
  numerator: number;
  denominator: number;
  botFiltered?: number;
}): Rate {
  const definition = RATE_DEFINITIONS[input.kind];
  const denominator = whole(input.denominator);
  const numerator = whole(input.numerator);

  return {
    kind: input.kind,
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    confidence: definition.confidence,
    ...(definition.caveat === undefined ? {} : { caveat: definition.caveat }),
    botFiltered: whole(input.botFiltered ?? 0),
  };
}

/**
 * A non-negative whole number, whatever it is handed.
 *
 * `Math.max(0, Math.trunc(NaN))` is `NaN`, which then divides into a `NaN`
 * rate that renders as "NaN%" and serialises into JSON as `null` — so the
 * failure reaches the customer looking like a missing value rather than like
 * the bad input it is. A count is always a count.
 */
function whole(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * The engagement score for one contact, 0-100.
 *
 * Recomputed wholesale by the hourly pass (R26), never incremented, so it is
 * a pure function of the contact's history and two rollups of the same data
 * always agree.
 *
 * Clicks weigh far more than opens for the reason above: an open may be a
 * proxy, a click is a person. Recency matters because a contact who engaged
 * two years ago and not since is not engaged, and a score that ignored time
 * would keep them at the top of every segment forever.
 */
export function engagementScore(input: {
  campaignsReceived: number;
  opens: number;
  clicks: number;
  lastClickedAt: Date | null;
  lastOpenedAt: Date | null;
  now: Date;
}): number {
  if (input.campaignsReceived <= 0) return 0;

  const clickRate = Math.min(1, input.clicks / input.campaignsReceived);
  const openRate = Math.min(1, input.opens / input.campaignsReceived);

  // 70/30. A contact who clicks half of what they receive and opens nothing
  // else scores higher than one who opens everything and clicks nothing,
  // which matches which of the two is worth mailing.
  const base = clickRate * 70 + openRate * 30;

  const lastEngaged = mostRecent(input.lastClickedAt, input.lastOpenedAt);
  return Math.round(base * recencyFactor(lastEngaged, input.now));
}

/**
 * How much a contact's history still counts for.
 *
 * Full weight for 90 days, then a linear decay to a floor rather than to
 * zero. A floor rather than zero because a contact who clicked once a year
 * ago is still meaningfully different from one who has never clicked, and a
 * score of zero would merge them.
 */
export const RECENCY_FULL_DAYS = 90;
export const RECENCY_ZERO_DAYS = 365;
export const RECENCY_FLOOR = 0.2;

export function recencyFactor(lastEngaged: Date | null, now: Date): number {
  if (lastEngaged === null) return 0;

  const days = (now.getTime() - lastEngaged.getTime()) / 86_400_000;
  if (days <= RECENCY_FULL_DAYS) return 1;
  if (days >= RECENCY_ZERO_DAYS) return RECENCY_FLOOR;

  const span = RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS;
  const decayed = 1 - ((days - RECENCY_FULL_DAYS) / span) * (1 - RECENCY_FLOOR);

  return decayed;
}

function mostRecent(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
