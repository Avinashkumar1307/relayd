import { describe, expect, it } from 'vitest';
import {
  BLOCK_SCORE,
  SIGNAL_WEIGHT,
  baseDomain,
  domainOf,
  editDistance,
  extractLinks,
  hostOf,
  lintCampaign,
  linkTextMismatch,
  looksLikeBrand,
  severityOf,
  type LintInput,
} from '../src/abuse/phishing.js';

/**
 * The launch-time phishing lint (docs/06 "Anti-abuse").
 *
 * docs/06: "Launch-time lint for phishing signals: credential-harvest
 * language, brand impersonation in the From name, URL shorteners, mismatched
 * link text and href, executable attachment types."
 *
 * ## Most of this file is about false positives
 *
 * That is deliberate. Every legitimate SaaS sends "verify your account"
 * emails with a button reading "Reset your password". If those are blocked,
 * the first thing every customer learns is which words to avoid — and the
 * lint then catches nobody except the honest.
 *
 * So for each signal there are two tests: one that it fires on the real
 * thing, and one that it does *not* fire on the innocent version. A test
 * suite with only the first kind is satisfied by a function that returns
 * every code every time.
 */

function input(over: Partial<LintInput> = {}): LintInput {
  return {
    fromName: 'Acme Newsletter',
    fromAddress: 'news@acme.example',
    subject: 'Our spring update',
    html: '<p>Hello, here is our <a href="https://acme.example/blog">latest post</a>.</p>',
    ...over,
  };
}

describe('the helpers', () => {
  it('reads a domain from an address', () => {
    expect(domainOf('a@b.example')).toBe('b.example');
    expect(domainOf('weird@@x.example')).toBe('x.example');
    expect(domainOf('not-an-address')).toBe('');
  });

  it('reduces a host to its last two labels', () => {
    expect(baseDomain('mail.news.acme.example')).toBe('acme.example');
    expect(baseDomain('acme.example')).toBe('acme.example');
    expect(baseDomain('localhost')).toBe('localhost');
  });

  it('returns an empty host for something that is not a URL', () => {
    expect(hostOf('not a url')).toBe('');
    expect(hostOf('https://acme.example/x')).toBe('acme.example');
  });

  it('measures edit distance', () => {
    expect(editDistance('paypal', 'paypa1')).toBe(1);
    expect(editDistance('paypal', 'paypal')).toBe(0);
    expect(editDistance('acme', 'paypal')).toBeGreaterThan(1);
  });
});

describe('extracting links', () => {
  it('finds href and visible text', () => {
    const links = extractLinks('<a href="https://x.example">Click</a>');

    expect(links).toEqual([{ href: 'https://x.example', text: 'Click' }]);
  });

  it('handles single quotes and bare attributes', () => {
    expect(extractLinks("<a href='https://x.example'>a</a>")).toHaveLength(1);
    expect(extractLinks('<a href=https://x.example>a</a>')).toHaveLength(1);
  });

  it('strips tags from the visible text', () => {
    // `<b>paypal.com</b>` reads as paypal.com to a person, which is the
    // whole point of the mismatch check below.
    const links = extractLinks('<a href="https://evil.test"><b>paypal.com</b></a>');

    expect(links[0]?.text).toBe('paypal.com');
  });

  it('keeps other attributes out of the way', () => {
    const links = extractLinks('<a class="btn" href="https://x.example" target="_blank">Go</a>');

    expect(links[0]?.href).toBe('https://x.example');
  });
});

describe('credential-harvest language', () => {
  it('notices it', () => {
    const result = lintCampaign(input({ subject: 'Verify your account immediately' }));

    expect(result.findings.map((f) => f.code)).toContain('credential_language');
  });

  it('never blocks on it alone', () => {
    // A normal transactional email. Blocking here is how the lint teaches
    // every honest customer to reword and catches nobody.
    const result = lintCampaign(input({ subject: 'Verify your account' }));

    expect(result.blocked).toBe(false);
  });

  it('ignores ordinary marketing copy', () => {
    const result = lintCampaign(
      input({ subject: 'Your monthly account summary', html: '<p>Here is your usage.</p>' }),
    );

    expect(result.findings).toEqual([]);
  });

  it('does not read phrases out of a stylesheet or a script', () => {
    // Matching inside a `<style>` or `<script>` block is a false positive
    // with a particularly confusing explanation — the sender cannot see the
    // phrase anywhere in what they wrote.
    //
    // The text has to be phrasing the patterns would really match. An
    // earlier version of this test used `.verify-your-account`, which the
    // patterns never match anyway (they want whitespace, not hyphens), so it
    // passed with the stripping removed entirely.
    const styled = lintCampaign(
      input({ html: '<style>/* verify your account */ p { color: red }</style><p>Hi</p>' }),
    );
    const scripted = lintCampaign(
      input({ html: '<script>var t = "verify your account";</script><p>Hi</p>' }),
    );

    expect(styled.findings.map((f) => f.code)).not.toContain('credential_language');
    expect(scripted.findings.map((f) => f.code)).not.toContain('credential_language');
  });

  it('still reads phrases out of the visible body', () => {
    // Without this, stripping everything would satisfy the test above.
    const result = lintCampaign(input({ html: '<p>Please verify your account today.</p>' }));

    expect(result.findings.map((f) => f.code)).toContain('credential_language');
  });
});

describe('brand impersonation in the From name', () => {
  it('blocks a lookalike sender', () => {
    const result = lintCampaign(
      input({ fromName: 'PayPal Security', fromAddress: 'noreply@paypa1-alerts.test' }),
    );

    expect(result.blocked).toBe(true);
    expect(result.findings.map((f) => f.code)).toContain('brand_impersonation');
  });

  it('leaves the real brand alone', () => {
    // A company sending as "PayPal" from paypal.com is PayPal. Without this
    // the check is unusable by exactly the companies most likely to be
    // impersonated.
    const result = lintCampaign(
      input({ fromName: 'PayPal', fromAddress: 'service@paypal.com' }),
    );

    expect(result.findings.map((f) => f.code)).not.toContain('brand_impersonation');
  });

  it('leaves a subdomain of the real brand alone', () => {
    const result = lintCampaign(
      input({ fromName: 'Microsoft 365', fromAddress: 'noreply@email.microsoft.com' }),
    );

    expect(result.findings.map((f) => f.code)).not.toContain('brand_impersonation');
  });

  it('does not fire on a brand name inside a longer word', () => {
    // "Groups" contains "ups". A substring match here would flag a large
    // share of legitimate senders.
    const result = lintCampaign(
      input({ fromName: 'Acme Groups Digest', fromAddress: 'news@acme.example' }),
    );

    expect(result.findings.map((f) => f.code)).not.toContain('brand_impersonation');
  });
});

describe('link destinations', () => {
  it('blocks a raw IP link', () => {
    // No innocent reading: a company's website is not http://203.0.113.4.
    const result = lintCampaign(
      input({ html: '<a href="http://203.0.113.4/login">Sign in</a>' }),
    );

    expect(result.blocked).toBe(true);
    expect(result.findings.map((f) => f.code)).toContain('raw_ip_link');
  });

  it('warns about a shortener without blocking', () => {
    const result = lintCampaign(input({ html: '<a href="https://bit.ly/abc">Read</a>' }));

    expect(result.findings.map((f) => f.code)).toContain('url_shortener');
    expect(result.blocked).toBe(false);
  });

  it('warns about punycode', () => {
    const result = lintCampaign(
      input({ html: '<a href="https://xn--pypal-4ve.test/">Sign in</a>' }),
    );

    expect(result.findings.map((f) => f.code)).toContain('punycode_domain');
  });

  it('warns about a lookalike link domain', () => {
    const result = lintCampaign(
      input({ html: '<a href="https://paypal-secure.test/">Sign in</a>' }),
    );

    expect(result.findings.map((f) => f.code)).toContain('lookalike_domain');
  });

  it('leaves an ordinary link alone', () => {
    const result = lintCampaign(input());

    expect(result.findings).toEqual([]);
  });
});

describe('mismatched link text', () => {
  it('fires when the text claims another domain', () => {
    const result = lintCampaign(
      input({ html: '<a href="https://evil.test/login">paypal.com</a>' }),
    );

    expect(result.findings.map((f) => f.code)).toContain('link_text_mismatch');
  });

  it('does not fire on "click here"', () => {
    // Text that makes no claim about where it goes is not a mismatch, and
    // treating it as one would flag every marketing email ever sent.
    expect(linkTextMismatch({ href: 'https://evil.test', text: 'Click here' })).toBe(false);
  });

  it('does not fire when the text matches the destination', () => {
    expect(
      linkTextMismatch({ href: 'https://acme.example/blog', text: 'acme.example' }),
    ).toBe(false);
  });

  it('accepts a subdomain of the claimed domain', () => {
    // `www.acme.example` pointing at `mail.acme.example` is the same
    // organisation, and flagging it would be noise.
    expect(
      linkTextMismatch({ href: 'https://mail.acme.example/x', text: 'www.acme.example' }),
    ).toBe(false);
  });

  it('does not fire on empty text', () => {
    expect(linkTextMismatch({ href: 'https://x.example', text: '' })).toBe(false);
  });
});

describe('attachments', () => {
  it('blocks an executable', () => {
    const result = lintCampaign(input({ attachments: [{ filename: 'invoice.exe' }] }));

    expect(result.blocked).toBe(true);
  });

  it('blocks regardless of case', () => {
    const result = lintCampaign(input({ attachments: [{ filename: 'Invoice.EXE' }] }));

    expect(result.blocked).toBe(true);
  });

  it('blocks a double extension', () => {
    // `invoice.pdf.exe` is the oldest trick in the file, and checking only
    // the first extension would miss it.
    const result = lintCampaign(input({ attachments: [{ filename: 'invoice.pdf.exe' }] }));

    expect(result.blocked).toBe(true);
  });

  it('allows a PDF', () => {
    const result = lintCampaign(input({ attachments: [{ filename: 'brochure.pdf' }] }));

    expect(result.blocked).toBe(false);
  });
});

describe('the score is what blocks, not any one signal', () => {
  it('blocks when warnings combine past the threshold', () => {
    // Credential language plus a mismatched link plus a lookalike domain:
    // none blocks alone, together they are a phishing email.
    const result = lintCampaign(
      input({
        subject: 'Verify your account',
        html: '<a href="https://paypal-secure.test/login">paypal.com</a>',
      }),
    );

    expect(result.score).toBeGreaterThanOrEqual(BLOCK_SCORE);
    expect(result.blocked).toBe(true);
  });

  it('lets exactly three signals block on their own', () => {
    // The list is pinned here rather than derived from the weights, because
    // deriving it would make the test agree with whatever the weights say.
    // These three have no innocent reading in a marketing email; everything
    // else has to combine with something, which is the whole design.
    const blockingAlone = ['executable_attachment', 'raw_ip_link', 'brand_impersonation'];

    for (const [code, weight] of Object.entries(SIGNAL_WEIGHT)) {
      if (blockingAlone.includes(code)) {
        expect(weight, code).toBeGreaterThanOrEqual(BLOCK_SCORE);
      } else {
        expect(weight, code).toBeLessThan(BLOCK_SCORE);
      }
    }
  });

  it('labels a finding blocking exactly when its weight blocks', () => {
    // Severity is derived rather than written by hand. Set independently,
    // the two drift — and a finding labelled `blocking` whose weight is
    // under the threshold reads as blocking everywhere it is displayed
    // while blocking nothing.
    for (const code of Object.keys(SIGNAL_WEIGHT) as (keyof typeof SIGNAL_WEIGHT)[]) {
      const expected = SIGNAL_WEIGHT[code] >= BLOCK_SCORE ? 'blocking' : 'warning';
      expect(severityOf(code), code).toBe(expected);
    }
  });

  it('marks a real finding with the derived severity', () => {
    // Both sides. A version that labelled everything `warning` passes a test
    // that only checks a warning — and would then show a blocking finding as
    // a warning in the review step while refusing the launch.
    const warning = lintCampaign(input({ html: '<a href="https://bit.ly/x">Read</a>' }));
    const blocking = lintCampaign(input({ attachments: [{ filename: 'x.exe' }] }));

    expect(warning.findings[0]?.severity).toBe('warning');
    expect(blocking.findings[0]?.severity).toBe('blocking');
  });

  it('counts each signal once however many times it appears', () => {
    // Ten mismatched links are one problem to fix. Counting them ten times
    // would push an otherwise fine campaign over the threshold by repetition
    // alone — and the sender would have no idea why ten links block when
    // nine did not.
    const one = lintCampaign(input({ html: '<a href="https://evil.test">paypal.com</a>' }));
    const many = lintCampaign(
      input({
        html: Array.from(
          { length: 10 },
          () => '<a href="https://evil.test">paypal.com</a>',
        ).join(''),
      }),
    );

    expect(many.score).toBe(one.score);
  });

  it('reports findings even when it does not block', () => {
    // Most of the value: an honest sender fixes a mismatched link, and a
    // dishonest one learns we are looking.
    const result = lintCampaign(input({ html: '<a href="https://bit.ly/x">Read</a>' }));

    expect(result.blocked).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

describe('looksLikeBrand', () => {
  it('spots a near-miss spelling', () => {
    expect(looksLikeBrand('paypa1.test')).toBe('paypal');
  });

  it('spots a brand joined to another word', () => {
    expect(looksLikeBrand('paypal-secure.test')).toBe('paypal');
  });

  it('does not flag the brand itself', () => {
    expect(looksLikeBrand('paypal.com')).toBeNull();
  });

  it('does not flag an unrelated domain', () => {
    expect(looksLikeBrand('acme.example')).toBeNull();
  });

  it('does not near-miss on short brand names', () => {
    // `ups` is three letters; one edit from it reaches `ups`, `ips`, `us`,
    // and a great many real domains. Only brands long enough for an edit to
    // be improbable are compared this way.
    expect(looksLikeBrand('cups.example')).toBeNull();
    expect(looksLikeBrand('irc.example')).toBeNull();
  });
});
