import { describe, expect, it, vi } from 'vitest';
import {
  REPUTATION_TIMEOUT_MS,
  cachedReputation,
  checkLinkReputation,
  type DomainReputation,
  type ReputationPort,
} from '../src/abuse/link-reputation.js';

/**
 * Link reputation (docs/06 "Anti-abuse").
 *
 * docs/06: "Tracked link domains checked against a reputation feed;
 * known-bad domains block the launch."
 *
 * The interesting behaviour is not the happy path — it is what happens when
 * the feed is having a bad day, because that decides whether this control is
 * a safety feature or an outage waiting for somebody else's incident.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

function port(results: DomainReputation[], onLookup?: (domains: readonly string[]) => void) {
  return {
    async lookup(domains: readonly string[]) {
      onLookup?.(domains);
      return results.filter((result) => domains.includes(result.domain));
    },
  } satisfies ReputationPort;
}

describe('the verdict', () => {
  it('blocks on malicious', () => {
    return checkLinkReputation(
      ['evil.test'],
      port([{ domain: 'evil.test', verdict: 'malicious', source: 'feed' }]),
    ).then((outcome) => {
      expect(outcome.ok).toBe(false);
    });
  });

  it('allows suspicious', async () => {
    // Feeds disagree about what suspicious means. A category that blocks on
    // a maybe is a category that gets switched off within a month of launch,
    // and then the malicious one goes with it.
    const outcome = await checkLinkReputation(
      ['maybe.test'],
      port([{ domain: 'maybe.test', verdict: 'suspicious', source: 'feed' }]),
    );

    expect(outcome.ok).toBe(true);
  });

  it('allows clean and unknown', async () => {
    const outcome = await checkLinkReputation(
      ['a.test', 'b.test'],
      port([
        { domain: 'a.test', verdict: 'clean', source: 'feed' },
        { domain: 'b.test', verdict: 'unknown', source: 'feed' },
      ]),
    );

    expect(outcome.ok).toBe(true);
  });

  it('reports which domains blocked, and who said so', async () => {
    // An appeal starts with "who says". Without the source the sender is
    // told their link is bad by nobody in particular.
    const outcome = await checkLinkReputation(
      ['evil.test'],
      port([{ domain: 'evil.test', verdict: 'malicious', source: 'spamhaus' }]),
    );

    expect(outcome).toMatchObject({
      ok: false,
      blocked: [{ domain: 'evil.test', source: 'spamhaus' }],
    });
  });

  it('checks nothing for a campaign with no links', async () => {
    const lookup = vi.fn();
    const outcome = await checkLinkReputation([], port([], lookup));

    expect(outcome).toEqual({ ok: true, checked: 0, unavailable: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('deduplicates before asking', async () => {
    // Every feed charges by request, and a campaign links to its own domain
    // a dozen times.
    let asked: readonly string[] = [];
    await checkLinkReputation(['a.test', 'a.test', 'a.test'], port([], (d) => (asked = d)));

    expect(asked).toEqual(['a.test']);
  });
});

describe('when the feed is down', () => {
  it('fails open', async () => {
    // The opposite trade-off from the rate limiter, which fails closed
    // (CLAUDE.md section 9). The direction of harm decides: an unchecked
    // link is a risk we accept; every customer unable to launch because a
    // third party is down is an outage we caused.
    const broken: ReputationPort = {
      async lookup() {
        throw new Error('feed unreachable');
      },
    };

    const outcome = await checkLinkReputation(['a.test'], broken);

    expect(outcome.ok).toBe(true);
  });

  it('says that it did', async () => {
    // Failing open silently would leave "was this campaign checked" with no
    // answer, which is the part that matters afterwards.
    const broken: ReputationPort = {
      async lookup() {
        throw new Error('feed unreachable');
      },
    };

    const outcome = await checkLinkReputation(['a.test'], broken);

    expect(outcome).toMatchObject({ unavailable: true, checked: 0 });
  });

  it('gives up rather than holding the launch transaction open', async () => {
    // A launch transaction holds a FOR SHARE on the entitlement row. A feed
    // that hangs would hold it for as long as it liked.
    const hanging: ReputationPort = {
      async lookup() {
        return new Promise(() => {
          // never resolves
        });
      },
    };

    const started = Date.now();
    const outcome = await checkLinkReputation(['a.test'], hanging, 50);

    expect(outcome).toMatchObject({ unavailable: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('has a timeout short enough to sit inside a launch', () => {
    expect(REPUTATION_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('caching', () => {
  it('asks once for a repeated domain', async () => {
    const calls: string[][] = [];
    const cached = cachedReputation(
      port([{ domain: 'a.test', verdict: 'clean', source: 'feed' }], (d) => calls.push([...d])),
      () => NOW,
    );

    await cached.lookup(['a.test']);
    await cached.lookup(['a.test']);

    expect(calls).toEqual([['a.test']]);
  });

  it('asks again once the entry is stale', async () => {
    const calls: string[][] = [];
    let clock = NOW;

    const cached = cachedReputation(
      port([{ domain: 'a.test', verdict: 'clean', source: 'feed' }], (d) => calls.push([...d])),
      () => clock,
      1_000,
    );

    await cached.lookup(['a.test']);
    clock = new Date(NOW.getTime() + 2_000);
    await cached.lookup(['a.test']);

    expect(calls).toHaveLength(2);
  });

  it('only asks for the domains it is missing', async () => {
    const calls: string[][] = [];
    const cached = cachedReputation(
      port(
        [
          { domain: 'a.test', verdict: 'clean', source: 'feed' },
          { domain: 'b.test', verdict: 'clean', source: 'feed' },
        ],
        (d) => calls.push([...d]),
      ),
      () => NOW,
    );

    await cached.lookup(['a.test']);
    await cached.lookup(['a.test', 'b.test']);

    expect(calls).toEqual([['a.test'], ['b.test']]);
  });

  it('does not cache an unknown verdict', async () => {
    // `unknown` usually means the feed had nothing to say *yet*. Caching it
    // for six hours would keep a newly-listed domain looking clean for
    // exactly the window that matters.
    const calls: string[][] = [];
    const cached = cachedReputation(
      port([{ domain: 'a.test', verdict: 'unknown', source: 'feed' }], (d) => calls.push([...d])),
      () => NOW,
    );

    await cached.lookup(['a.test']);
    await cached.lookup(['a.test']);

    expect(calls).toHaveLength(2);
  });

  it('still returns a cached malicious verdict', async () => {
    // The cache must not soften a block. Caching that returned `clean` for a
    // known-bad domain on the second call would be worse than no cache.
    const cached = cachedReputation(
      port([{ domain: 'evil.test', verdict: 'malicious', source: 'feed' }]),
      () => NOW,
    );

    await cached.lookup(['evil.test']);
    const second = await cached.lookup(['evil.test']);

    expect(second).toEqual([{ domain: 'evil.test', verdict: 'malicious', source: 'feed' }]);
  });
});
