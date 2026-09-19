/**
 * Link reputation (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
 *
 * docs/06: "Tracked link domains checked against a reputation feed;
 * known-bad domains block the launch."
 *
 * ## Why this is a port and not an HTTP call
 *
 * The feed is somebody else's service, and this runs inside the launch
 * transaction. Three things follow, and all three are about what happens
 * when the feed is having a bad day:
 *
 *   **It fails open.** A reputation feed that is down must not stop every
 *   customer launching. That is the opposite trade-off from the rate limiter
 *   (CLAUDE.md section 9: "The rate limiter fails closed"), and the reason is
 *   the direction of the harm: an unchecked link is a risk, an unavailable
 *   feed blocking every launch is an outage. The unchecked launch is recorded
 *   so the decision is visible afterwards.
 *
 *   **It is bounded.** A feed that hangs would hold a launch transaction open
 *   for as long as it liked, and a launch transaction holds a `FOR SHARE` on
 *   the entitlement row.
 *
 *   **Results are cached.** The same handful of domains appear in campaign
 *   after campaign, and a lookup per link per launch is a request per
 *   recipient-batch to somebody who rate-limits us.
 */

export type ReputationVerdict = 'clean' | 'malicious' | 'suspicious' | 'unknown';

export interface DomainReputation {
  domain: string;
  verdict: ReputationVerdict;
  /** What said so, for the audit trail and for an appeal. */
  source: string;
}

export interface ReputationPort {
  /**
   * Looks up several domains at once.
   *
   * Batched because a campaign has several links and every feed charges by
   * request. Must resolve within the caller's timeout or throw.
   */
  lookup(domains: readonly string[]): Promise<DomainReputation[]>;
}

/** How long a verdict is trusted before being looked up again. */
export const REPUTATION_TTL_MS = 6 * 60 * 60 * 1000;

/** The budget for the whole lookup, inside a launch transaction. */
export const REPUTATION_TIMEOUT_MS = 3_000;

export type ReputationOutcome =
  | { ok: true; checked: number; unavailable: false }
  | { ok: true; checked: 0; unavailable: true; error: string }
  | { ok: false; blocked: DomainReputation[]; checked: number; unavailable: false };

/**
 * Checks a campaign's link domains.
 *
 * Only `malicious` blocks. `suspicious` is reported and allowed: feeds
 * disagree about what suspicious means, and a category that blocks on a
 * maybe is a category that gets switched off within a month of launch.
 */
export async function checkLinkReputation(
  domains: readonly string[],
  port: ReputationPort,
  timeoutMs = REPUTATION_TIMEOUT_MS,
): Promise<ReputationOutcome> {
  const unique = [...new Set(domains.filter((domain) => domain !== ''))];
  if (unique.length === 0) return { ok: true, checked: 0, unavailable: false };

  let results: DomainReputation[];

  try {
    results = await withTimeout(port.lookup(unique), timeoutMs);
  } catch (error) {
    // Fails open, and says so. The alternative stops every customer
    // launching whenever a third party has an incident, which is a worse
    // outcome than an unchecked link — and unlike the unchecked link, it is
    // one we caused.
    return {
      ok: true,
      checked: 0,
      unavailable: true,
      error: error instanceof Error ? error.message : 'reputation lookup failed',
    };
  }

  const blocked = results.filter((result) => result.verdict === 'malicious');

  if (blocked.length > 0) {
    return { ok: false, blocked, checked: unique.length, unavailable: false };
  }

  return { ok: true, checked: unique.length, unavailable: false };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`reputation lookup timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    // Cleared whichever way the race went, or a pending timer keeps the
    // process alive past the end of a test run and the failure reads as a
    // hung suite rather than a leaked handle.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * An in-memory cache in front of a port.
 *
 * Deliberately not Redis. The values are small, public, and identical for
 * every process, so a per-process cache costs a few kilobytes and removes a
 * network hop from the launch path. A shared cache would add a dependency to
 * a path that is already allowed to proceed without the feed at all.
 */
export function cachedReputation(
  port: ReputationPort,
  now: () => Date,
  ttlMs = REPUTATION_TTL_MS,
): ReputationPort {
  const cache = new Map<string, { at: number; value: DomainReputation }>();

  return {
    async lookup(domains) {
      const current = now().getTime();
      const fresh: DomainReputation[] = [];
      const missing: string[] = [];

      for (const domain of domains) {
        const hit = cache.get(domain);

        if (hit !== undefined && current - hit.at < ttlMs) fresh.push(hit.value);
        else missing.push(domain);
      }

      if (missing.length === 0) return fresh;

      const looked = await port.lookup(missing);

      for (const result of looked) {
        // `unknown` is not cached. It usually means the feed had nothing to
        // say yet, and caching it for six hours would keep a newly-listed
        // domain clean for exactly the window that matters.
        if (result.verdict !== 'unknown') cache.set(result.domain, { at: current, value: result });
      }

      return [...fresh, ...looked];
    },
  };
}
