import { describe, expect, it } from 'vitest';
import {
  DEDUPE_WINDOW_MS,
  PREFETCH_WINDOW_MS,
  classifyBot,
  dedupeKey,
  hashIp,
  isPrefetchByTiming,
} from '../src/tracking/bots.js';

/**
 * Bot and prefetch classification (docs/06 §13; INVARIANTS R6).
 *
 * An open is evidence that an image was fetched, not that a human read the
 * email, and the gap is 30–60%. The job here is to be honest about which
 * opens are which — not to make the number look better, which is why nothing
 * is ever discarded.
 */

function classify(userAgent: string, over: { method?: string; hasRangeHeader?: boolean } = {}) {
  return classifyBot({
    userAgent,
    method: over.method ?? 'GET',
    hasRangeHeader: over.hasRangeHeader ?? false,
  });
}

const HUMAN =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

describe('a real mail client', () => {
  it('is neither a bot nor a prefetch', () => {
    expect(classify(HUMAN)).toEqual({ isBot: false, isPrefetch: false, reason: null });
  });

  it('is not caught by a substring that happens to contain a scanner name', () => {
    // Matching loosely here means classifying real recipients as bots, and
    // their opens then vanish from the number the customer trusts.
    expect(classify('Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0 Safari/537.36').isBot).toBe(false);
    expect(classify('Mozilla/5.0 Robotics-Lab-Browser/2.0').isBot).toBe(false);
  });
});

describe('prefetch', () => {
  it('recognises Apple Mail’s privacy proxy', () => {
    // It fetches every image for every protected user, which is most of them.
    expect(classify('AppleMail/1.0').isPrefetch).toBe(true);
  });

  it('recognises Gmail’s image proxy', () => {
    expect(classify('Mozilla/5.0 (compatible; GoogleImageProxy)').isPrefetch).toBe(true);
  });

  it('is not a bot', () => {
    // The distinction matters: a prefetched open still belongs to a real
    // recipient whose client asked for it.
    const verdict = classify('AppleMail/1.0');
    expect(verdict.isPrefetch).toBe(true);
    expect(verdict.isBot).toBe(false);
  });

  it('wins over the scanner rules when both could match', () => {
    expect(classify('AppleMail/1.0 Proofpoint').isPrefetch).toBe(true);
  });
});

describe('scanners', () => {
  it('recognises the security vendors that walk every link', () => {
    for (const agent of ['Proofpoint-Scanner/1.0', 'Mimecast', 'Barracuda', 'ZScaler/3']) {
      expect(classify(agent).isBot, agent).toBe(true);
    }
  });

  it('recognises Microsoft Safe Links', () => {
    expect(classify('Mozilla/5.0 (compatible; SafeLinks)').isBot).toBe(true);
  });

  it('recognises honest crawlers that say so', () => {
    for (const agent of ['curl/8.4.0', 'python-requests/2.31.0', 'Go-http-client/1.1']) {
      expect(classify(agent).isBot, agent).toBe(true);
    }
  });

  it('recognises a headless browser', () => {
    expect(classify('Mozilla/5.0 HeadlessChrome/126.0').isBot).toBe(true);
  });
});

describe('the request-shape signals', () => {
  it('calls a HEAD request a bot', () => {
    expect(classify(HUMAN, { method: 'HEAD' })).toMatchObject({
      isBot: true,
      reason: 'head_request',
    });
  });

  it('is not fooled by a lowercase method', () => {
    expect(classify(HUMAN, { method: 'head' }).isBot).toBe(true);
  });

  it('calls a Range request for a 43-byte GIF a bot', () => {
    expect(classify(HUMAN, { hasRangeHeader: true })).toMatchObject({
      isBot: true,
      reason: 'range_request',
    });
  });

  it('calls an empty user agent a bot', () => {
    // No mail client sends one; every naive script does.
    expect(classify('')).toMatchObject({ isBot: true, reason: 'no_user_agent' });
    expect(classify('   ')).toMatchObject({ isBot: true, reason: 'no_user_agent' });
  });

  it('names the rule that fired', () => {
    // The UI shows the filtered share honestly, which needs to know why.
    expect(classify('curl/8.4.0').reason).toBe('scanner_agent');
    expect(classify('AppleMail/1.0').reason).toBe('prefetch_agent');
  });
});

describe('prefetch by timing', () => {
  const sentAt = new Date('2026-09-18T12:00:00.000Z');

  it('calls an open within two seconds of the send a prefetch', () => {
    // Nothing human opens a message, renders it and fetches an image inside
    // two seconds of the provider accepting it.
    expect(
      isPrefetchByTiming({ sentAt, occurredAt: new Date(sentAt.getTime() + 500) }),
    ).toBe(true);
  });

  it('does not call a later open a prefetch', () => {
    expect(
      isPrefetchByTiming({ sentAt, occurredAt: new Date(sentAt.getTime() + 5_000) }),
    ).toBe(false);
  });

  it('treats the boundary as not a prefetch', () => {
    expect(
      isPrefetchByTiming({ sentAt, occurredAt: new Date(sentAt.getTime() + PREFETCH_WINDOW_MS) }),
    ).toBe(false);
  });

  it('treats clock skew as a prefetch rather than as a human', () => {
    // An open timestamped before the send is skew between the sender and the
    // edge. It is certainly not somebody reading it.
    expect(
      isPrefetchByTiming({ sentAt, occurredAt: new Date(sentAt.getTime() - 10_000) }),
    ).toBe(true);
  });

  it('uses the two seconds docs/06 specifies', () => {
    expect(PREFETCH_WINDOW_MS).toBe(2_000);
  });
});

describe('IP hashing', () => {
  it('does not contain the address', () => {
    const hash = hashIp('203.0.113.42', 'salt');
    expect(hash).not.toContain('203');
    expect(hash).not.toContain('113');
  });

  it('is stable for one address on one day', () => {
    // The five-minute dedup window is the only thing the hash is for, and it
    // needs the same address to hash the same way within a day.
    expect(hashIp('203.0.113.42', 'monday')).toBe(hashIp('203.0.113.42', 'monday'));
  });

  it('changes when the salt rotates', () => {
    // Without rotation the column is a pseudonymous identifier in everything
    // but name.
    expect(hashIp('203.0.113.42', 'monday')).not.toBe(hashIp('203.0.113.42', 'tuesday'));
  });

  it('separates two addresses', () => {
    expect(hashIp('203.0.113.42', 's')).not.toBe(hashIp('203.0.113.43', 's'));
  });

  it('cannot be confused by a salt that runs into the address', () => {
    // Concatenating salt and address without a separator makes
    // ("ab", "cde") and ("abc", "de") the same input.
    expect(hashIp('cde', 'ab')).not.toBe(hashIp('de', 'abc'));
  });

  it('returns empty for a missing address rather than hashing nothing', () => {
    // A hash of the empty string looks like a real value and would group
    // every IP-less request together as one client.
    expect(hashIp('', 'salt')).toBe('');
  });

  it('is URL-safe and short enough to index', () => {
    expect(hashIp('203.0.113.42', 'salt')).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });
});

describe('the dedup key', () => {
  const base = {
    messageToken: Buffer.alloc(16, 1),
    kind: 'open',
    linkIndex: 0,
    ipHash: 'abc',
    userAgent: HUMAN,
  };

  it('is the same for a repeat from the same client', () => {
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }));
  });

  it('separates two recipients', () => {
    expect(dedupeKey(base)).not.toBe(
      dedupeKey({ ...base, messageToken: Buffer.alloc(16, 2) }),
    );
  });

  it('separates an open from a click', () => {
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, kind: 'click' }));
  });

  it('separates two links in one message', () => {
    // Otherwise clicking the second link within five minutes of the first is
    // silently dropped.
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, linkIndex: 1 }));
  });

  it('separates two clients behind one IP', () => {
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, userAgent: 'curl/8.4.0' }));
  });

  it('separates two IPs', () => {
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, ipHash: 'def' }));
  });

  it('uses the five-minute window docs/06 specifies', () => {
    expect(DEDUPE_WINDOW_MS).toBe(5 * 60_000);
  });
});
