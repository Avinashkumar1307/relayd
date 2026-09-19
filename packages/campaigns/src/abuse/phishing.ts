/**
 * Launch-time phishing lint (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
 *
 * docs/06: "Launch-time lint for phishing signals: credential-harvest
 * language, brand impersonation in the From name, URL shorteners, mismatched
 * link text and href, executable attachment types."
 *
 * ## What this is for, and the thing that ruins it
 *
 * The purpose is to stop our platform being used to run a credential-harvest
 * campaign against somebody's customers. It is not a spam filter and it is
 * not a quality checker.
 *
 * The thing that ruins a lint like this is false positives. Every legitimate
 * SaaS sends "verify your account" emails with a button that says "Reset your
 * password". If those trip a block, the first thing every customer learns is
 * which words to avoid — and the lint then catches nobody except the honest.
 *
 * So the design is deliberately lopsided:
 *
 *   **One signal never blocks.** Credential language on its own is a normal
 *   transactional email. A lookalike domain on its own might be a typo.
 *   Blocking needs signals that *combine*, or one that has no innocent
 *   reading at all.
 *
 *   **Findings carry weights, and the weights are the policy.** They are in
 *   one table below rather than spread through the checks, so the question
 *   "what does it take to get blocked" has one answer somebody can read.
 *
 *   **Warnings are shown, not swallowed.** A campaign that scores below the
 *   block threshold still shows its findings in the review step. That is
 *   where most of the value is: an honest sender fixes a mismatched link,
 *   and a dishonest one learns we are looking.
 */

export type LintSeverity = 'blocking' | 'warning';

export type LintCode =
  | 'credential_language'
  | 'brand_impersonation'
  | 'url_shortener'
  | 'link_text_mismatch'
  | 'executable_attachment'
  | 'raw_ip_link'
  | 'punycode_domain'
  | 'lookalike_domain';

export interface LintFinding {
  code: LintCode;
  /**
   * Derived from the weight, never set by hand.
   *
   * Written independently, the two drift: a finding labelled `blocking`
   * whose weight is under the threshold reads as blocking everywhere it is
   * displayed and blocks nothing, which is the worst of both.
   */
  severity: LintSeverity;
  /** Shown to the sender. Says what to change, not what they are suspected of. */
  message: string;
  /** The offending fragment, for the UI to point at. Never the whole body. */
  evidence?: string;
}

/**
 * How much each signal contributes to the block decision.
 *
 * The table *is* the policy. Two things follow from the numbers:
 *
 *   Nothing weighted below `BLOCK_SCORE` blocks on its own, so no single
 *   innocent-looking campaign is stopped by one heuristic.
 *
 *   `executable_attachment` and `raw_ip_link` are at the threshold, because
 *   neither has an innocent reading in a marketing email. An .exe attachment
 *   is not a newsletter, and a link to `http://203.0.113.4/login` is not a
 *   company's website.
 */
export const SIGNAL_WEIGHT: Readonly<Record<LintCode, number>> = {
  executable_attachment: 100,
  raw_ip_link: 100,
  // Blocking on its own. A company legitimately called PayPal sends from
  // paypal.com; the checks below exempt the real brand and its subdomains,
  // and require the brand to be a whole word in the From name, so what is
  // left has no innocent reading.
  brand_impersonation: 100,
  punycode_domain: 60,
  lookalike_domain: 50,
  link_text_mismatch: 40,
  credential_language: 25,
  url_shortener: 20,
};

/** At or above this, the launch is refused. */
export const BLOCK_SCORE = 100;

/** A finding's severity is a function of its weight, so the two cannot disagree. */
export function severityOf(code: LintCode): LintSeverity {
  return SIGNAL_WEIGHT[code] >= BLOCK_SCORE ? 'blocking' : 'warning';
}

/**
 * Brands whose names in a From line are worth questioning.
 *
 * Deliberately short and deliberately the ones actually impersonated in
 * credential-harvest campaigns. A long list of every company in the world
 * would catch a customer who happens to be called Apex Microsoft Consulting,
 * and the cost of that is a support ticket from somebody legitimate.
 */
export const PROTECTED_BRANDS: readonly string[] = [
  'paypal',
  'apple',
  'microsoft',
  'google',
  'amazon',
  'netflix',
  'facebook',
  'instagram',
  'linkedin',
  'dhl',
  'fedex',
  'ups',
  'hmrc',
  'irs',
  'docusign',
  'dropbox',
  'coinbase',
  'binance',
  'metamask',
  'chase',
  'wellsfargo',
  'barclays',
  'hsbc',
];

/**
 * Link shorteners.
 *
 * A warning, never a block. Shorteners have legitimate uses and plenty of
 * senders use them by habit. What they do is hide the destination from both
 * the recipient and from us, which is worth saying out loud.
 */
export const SHORTENER_DOMAINS: readonly string[] = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  'rb.gy',
  't.ly',
];

/**
 * Extensions that do not belong on a marketing email.
 *
 * Checked on the *filename*, because the declared content type is whatever
 * the sender says it is.
 */
export const EXECUTABLE_EXTENSIONS: readonly string[] = [
  'exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'msi', 'msp', 'hta', 'cpl',
  'jar', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'lnk', 'reg', 'dll', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'iso', 'img',
];

/**
 * Phrases that ask somebody to hand over a credential under time pressure.
 *
 * On their own these are a normal transactional email, which is why the
 * weight is low. They matter in combination: "verify your account" plus a
 * lookalike domain plus mismatched link text is a different thing from any
 * one of them.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bverify\s+your\s+(?:account|identity|password|details)\b/iu,
  /\bconfirm\s+your\s+(?:password|account\s+details|payment\s+(?:details|information))\b/iu,
  /\b(?:account|access)\s+(?:will\s+be\s+)?(?:suspended|terminated|locked|closed)\b/iu,
  /\bunusual\s+(?:sign[\s-]?in|login|activity)\b/iu,
  /\bre-?enter\s+your\s+(?:password|credentials|card)\b/iu,
  /\bvalidate\s+your\s+(?:account|credentials|wallet)\b/iu,
  /\bseed\s+phrase\b/iu,
  /\brecovery\s+phrase\b/iu,
  /\bupdate\s+your\s+(?:billing|payment)\s+(?:details|information)\s+(?:immediately|now|within)\b/iu,
];

export interface LintInput {
  /** The display name on the From header. */
  fromName: string;
  /** The address the campaign sends from. */
  fromAddress: string;
  subject: string;
  /** The rendered HTML body. */
  html: string;
  attachments?: readonly { filename: string }[];
}

export interface LintResult {
  findings: LintFinding[];
  score: number;
  blocked: boolean;
}

/** Everything after the last `@`, lowercased. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).trim().toLowerCase();
}

/** The registrable-ish domain: the last two labels. */
export function baseDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter((label) => label !== '');
  if (labels.length <= 2) return labels.join('.');

  return labels.slice(-2).join('.');
}

/** Every `href` in the HTML, in order. */
export function extractLinks(html: string): { href: string; text: string }[] {
  const links: { href: string; text: string }[] = [];
  const anchor = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu;

  for (const match of html.matchAll(anchor)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    // Tags stripped so the comparison is against what a person sees, which
    // is the whole point of the mismatch check — `<b>paypal.com</b>` reads
    // as paypal.com.
    const text = (match[4] ?? '').replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim();

    if (href !== '') links.push({ href, text });
  }

  return links;
}

/** The host of a URL, or '' when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * Levenshtein distance, capped.
 *
 * Only used to compare a host against a short brand list, so the input is
 * tiny and the cap keeps a pathological case bounded.
 */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }

    previous = current;
  }

  return previous[b.length] ?? cap + 1;
}

/**
 * Whether a host is a near-miss of a protected brand.
 *
 * `paypa1.com` and `paypal-secure.com` both qualify; `paypal.com` itself does
 * not, and neither does a host that merely contains a short brand name as a
 * substring of a longer word — `ups` inside `groups.example.com` is the
 * obvious way to make this fire on everybody.
 */
export function looksLikeBrand(host: string): string | null {
  const base = baseDomain(host);
  const name = base.split('.')[0] ?? '';

  for (const brand of PROTECTED_BRANDS) {
    if (name === brand) return null;

    // A brand name joined to something else: `paypal-secure`, `secure-paypal`.
    const parts = name.split(/[-_.]/u).filter((part) => part !== '');
    if (parts.includes(brand) && parts.length > 1) return brand;

    // A near-miss spelling, for brands long enough that one edit is not a
    // coincidence. `ups` and `irs` are too short to compare this way.
    if (brand.length >= 5 && editDistance(name, brand, 1) === 1) return brand;
  }

  return null;
}

function findCredentialLanguage(text: string): string | null {
  for (const pattern of CREDENTIAL_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }

  return null;
}

/**
 * Whether the visible text of a link claims a different destination.
 *
 * Only fires when the text *looks like* a URL or a bare domain. "Click here"
 * is not a mismatch — it makes no claim about where it goes — and treating it
 * as one would flag every marketing email ever sent.
 */
export function linkTextMismatch(link: { href: string; text: string }): boolean {
  const text = link.text.trim();
  if (text === '') return false;

  // A URL, or something shaped like `example.com` / `www.example.com`.
  const claimed = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/?#]|$)/iu.exec(text);
  if (claimed === null) return false;

  const claimedHost = baseDomain((claimed[1] ?? '').toLowerCase());
  const actualHost = baseDomain(hostOf(link.href));

  if (claimedHost === '' || actualHost === '') return false;

  return claimedHost !== actualHost;
}

export function lintCampaign(input: LintInput): LintResult {
  const findings: LintFinding[] = [];
  const add = (finding: Omit<LintFinding, 'severity'>): void => {
    // One finding per code. Ten mismatched links are one problem to fix, and
    // ten copies of the same warning would push an otherwise fine campaign
    // over the block threshold by repetition alone.
    if (!findings.some((existing) => existing.code === finding.code)) {
      findings.push({ ...finding, severity: severityOf(finding.code) });
    }
  };

  // --- credential-harvest language ---
  const credential = findCredentialLanguage(`${input.subject}\n${stripTags(input.html)}`);
  if (credential !== null) {
    add({
      code: 'credential_language',
      message: 'This campaign asks recipients to verify or confirm account details.',
      evidence: credential,
    });
  }

  // --- brand impersonation in the From name ---
  //
  // Only when the sending domain is not that brand's. A company sending as
  // "Microsoft" from `@microsoft.com` is Microsoft.
  const fromDomain = baseDomain(domainOf(input.fromAddress));
  const fromNameWords = input.fromName.toLowerCase().split(/[^a-z0-9]+/u).filter((w) => w !== '');

  for (const brand of PROTECTED_BRANDS) {
    if (!fromNameWords.includes(brand)) continue;
    if (fromDomain.startsWith(`${brand}.`) || fromDomain === `${brand}.com`) break;

    add({
      code: 'brand_impersonation',
      message: `The From name says "${input.fromName}" but this campaign sends from ${fromDomain || 'an unrelated domain'}.`,
      evidence: brand,
    });
    break;
  }

  // --- links ---
  for (const link of extractLinks(input.html)) {
    const host = hostOf(link.href);
    if (host === '') continue;

    if (IPV4.test(host)) {
      add({
        code: 'raw_ip_link',
        message: 'A link points at a raw IP address rather than a domain name.',
        evidence: link.href,
      });
    }

    if (host.startsWith('xn--') || host.includes('.xn--')) {
      add({
        code: 'punycode_domain',
        message: 'A link uses an internationalised domain, which can be made to resemble another.',
        evidence: host,
      });
    }

    if (SHORTENER_DOMAINS.includes(baseDomain(host))) {
      add({
        code: 'url_shortener',
        message: 'A link uses a URL shortener, which hides its destination from recipients.',
        evidence: host,
      });
    }

    const brand = looksLikeBrand(host);
    if (brand !== null) {
      add({
        code: 'lookalike_domain',
        message: `A link points at ${host}, which resembles ${brand}.`,
        evidence: host,
      });
    }

    if (linkTextMismatch(link)) {
      add({
        code: 'link_text_mismatch',
        message: `A link reads "${link.text}" but points somewhere else.`,
        evidence: link.text,
      });
    }
  }

  // --- attachments ---
  for (const attachment of input.attachments ?? []) {
    const extension = attachment.filename.split('.').pop()?.toLowerCase() ?? '';

    if (EXECUTABLE_EXTENSIONS.includes(extension)) {
      add({
        code: 'executable_attachment',
        message: `${attachment.filename} is an executable file type and cannot be sent.`,
        evidence: attachment.filename,
      });
    }
  }

  const score = findings.reduce((total, finding) => total + SIGNAL_WEIGHT[finding.code], 0);

  return { findings, score, blocked: score >= BLOCK_SCORE };
}

function stripTags(html: string): string {
  // Script and style contents dropped entirely rather than un-tagged: their
  // text is not what a recipient reads, and matching phishing phrases inside
  // a CSS block is a false positive with a confusing explanation.
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ');
}
