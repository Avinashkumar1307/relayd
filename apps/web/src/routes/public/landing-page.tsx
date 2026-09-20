import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  Icon,
  SegmentedBar,
  StateBadge,
  CAMPAIGN_STATES,
  SEG_ORDER,
  fmtCount,
  segmentValues,
  type IconName,
} from '@relayd/ui';

/**
 * A1 Landing · "/" (design/A Public.dc.html, frame A1).
 *
 * Marketing copy, so every string here is the frame's, verbatim. The hero
 * panel is the sample workspace's live campaign — `sample-data.js`
 * `campaigns[0]`, "Autumn Escapes: Dubai → Santorini" — drawn with the real
 * `SegmentedBar` and the real `StateBadge`, not a picture of them. That is
 * deliberate in the design: the landing page shows the product's own
 * vocabulary (delivery uncertain hatched, open rate labelled approximate)
 * rather than a stock screenshot.
 *
 * Nothing here is fetched. There is no public API, an anonymous visitor has
 * no workspace, and the numbers are illustrative — the frame's own fixture
 * values.
 */

/** sample-data.js `campaigns[0]`, the campaign the frame draws. */
const HERO_CAMPAIGN = {
  name: 'Autumn Escapes: Dubai → Santorini',
  state: 'sending',
  recipients: 48_213,
  counts: { delivered: 29_876, sending: 1_240, pending: 16_595, soft: 214, hard: 96, complaint: 12, failed: 0, uncertain: 180 },
} as const;

const HERO_PROCESSED = HERO_CAMPAIGN.recipients - HERO_CAMPAIGN.counts.pending;
const HERO_PERCENT = Math.round((HERO_PROCESSED / HERO_CAMPAIGN.recipients) * 100);
const n = (value: number): string => value.toLocaleString('en-US');

const STEPS = [
  {
    n: '1',
    time: '5 minutes',
    title: 'Connect your provider',
    body: 'Paste Amazon SES keys, a SendGrid API key or SMTP details. We verify with a dry-run send and hand you the webhook URL for delivery events.',
    chip: 'SES',
    chipText: 'Amazon SES · eu-west-1 · Healthy',
    tone: 'success',
  },
  {
    n: '2',
    time: '10 minutes',
    title: 'Import your audience',
    body: 'CSV or XLSX, mapped automatically. You attest consent before anything is saved; suppressed addresses stay suppressed.',
    chip: 'CSV',
    chipText: '14,286 rows · consent attested',
    tone: 'brand',
  },
  {
    n: '3',
    time: 'when you are ready',
    title: 'Launch a campaign',
    body: 'Pick a segment, a verified sender or pool and a locked template version. Pre-flight checks block a launch that would hurt you.',
    chip: 'OK',
    chipText: '7 checks passed · Launch',
    tone: 'success',
  },
] as const;

const PROVIDERS = [
  { kind: 'SES', name: 'Amazon SES', note: 'Full events via SNS' },
  { kind: 'SG', name: 'SendGrid', note: 'Full events via Event Webhook' },
  { kind: 'SMTP', name: 'Any SMTP server', note: 'Best-effort delivery feedback' },
] as const;

const HONEST = [
  { title: 'Click rate leads.', body: 'It is the one metric privacy proxies cannot fake.' },
  { title: 'Open rate is always labelled approximate.', body: 'With a tooltip that explains why.' },
  { title: 'Delivery uncertain is a first-class state.', body: 'Hatched, counted, never hidden, never billed.' },
  { title: 'Bot traffic is excluded and shown as excluded.', body: 'You see the number we removed.' },
] as const;

/**
 * The six trust cards. Five of the export's icons are already in
 * `ICON_PATHS` under the name the app uses for them: `ban` is
 * `suppressions`, `gauge` is `reports`, `scroll` is `audit`. `globe` is the
 * one path the shared set does not have (see `GlobeIcon` below).
 */
const TRUST: { icon: IconName | 'globe'; title: string; body: string }[] = [
  {
    icon: 'check',
    title: 'Consent attestation',
    body: 'Every import and every launch asks you to confirm consent, and records who confirmed, when, and for which audience.',
  },
  {
    icon: 'suppressions',
    title: 'Suppression that cannot be bypassed',
    body: 'Unsubscribes, bounces and complaints are removed at launch. Imports never reactivate them.',
  },
  {
    icon: 'mail',
    title: 'Unsubscribe always on',
    body: 'A one-click link in every template and the List-Unsubscribe header on every message. Not a setting.',
  },
  {
    icon: 'reports',
    title: 'Your provider limits, respected',
    body: 'Daily quotas and per-second limits are read from the connection and enforced. Pools never pretend to raise them.',
  },
  {
    icon: 'audit',
    title: 'Complete audit log',
    body: 'Launches, approvals, role changes, key reveals and imports, with the actor and the request ID.',
  },
  {
    icon: 'globe',
    title: 'EU data region',
    body: 'Hosted in Frankfurt, encrypted at rest, DPA available. Credentials are shown once and never again.',
  },
];

/**
 * The export's `ICON.globe`, which `packages/ui`'s set does not carry — the
 * app has no screen that needs a globe, only this page. Kept local rather
 * than added to the shared set (see uiGaps in the section report).
 */
function GlobeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

/** relayd-ui.js `HATCH`: delivery uncertain, in the same hatch the bar uses. */
const HATCH: CSSProperties = {
  background: 'repeating-linear-gradient(135deg,var(--uncertain) 0 2px,transparent 2px 5px)',
  outline: '1px dashed var(--uncertain)',
  outlineOffset: '-1px',
};

/** relayd-ui.js `swatchStyle('hatch')` — the finer 1.5/4 hatch at 10px. */
const HATCH_SWATCH: CSSProperties = {
  background: 'repeating-linear-gradient(135deg,var(--uncertain) 0 1.5px,transparent 1.5px 4px)',
  outline: '1px dashed var(--uncertain)',
  outlineOffset: '-1px',
};

/**
 * The hero panel's legend.
 *
 * `SegmentedBar`'s own legend is the design-system sheet's: one wrapping row.
 * A1 draws the same six segments as a three-column grid with the count
 * pinned to the right of its column (`grid-template-columns: 1fr 1fr 1fr;
 * gap: 8px 16px`), so the bar is rendered with `legend={false}` and the
 * frame's shape is built here, from the sheet's own `SEG_ORDER`,
 * `segmentValues` and `fmtCount` — the labels, the order and the formatting
 * still come from one place. Reported under uiGaps.
 */
function HeroLegend({ counts }: { counts: Parameters<typeof segmentValues>[0] }) {
  const values = segmentValues(counts);
  const present = SEG_ORDER.filter((seg) => values[seg.key] > 0);

  return (
    <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-ui sm:grid-cols-3">
      {present.map((seg) => (
        <span key={seg.key} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 flex-none rounded-2 ${seg.fill === 'hatch' ? '' : seg.fill}`}
            {...(seg.fill === 'hatch' ? { style: HATCH_SWATCH } : null)}
          />
          <span className="min-w-0 flex-1 truncate text-text-2">{seg.label}</span>
          <span className="font-medium tabular-nums">{fmtCount(values[seg.key])}</span>
        </span>
      ))}
    </div>
  );
}

const PRIMARY_CTA =
  'inline-flex h-[46px] items-center justify-center rounded-control bg-brand px-5 text-[15px] font-medium text-white no-underline hover:bg-brand-hover';
const SECONDARY_CTA =
  'inline-flex h-[46px] items-center justify-center gap-1.5 rounded-control border border-border px-[18px] text-[15px] font-medium text-text no-underline hover:bg-tint';

const SECTION_X = 'px-6 md:px-16';
const EYEBROW = 'text-ui font-semibold tracking-label uppercase text-brand';
const H2 = 'text-[36px] leading-[1.15] font-semibold tracking-[-0.02em]';
const CARD_16 = 'rounded-[16px] border border-border';

export function LandingPage() {
  return (
    <>
      {/* Hero */}
      <section
        className={`grid grid-cols-1 items-center gap-10 pt-16 pb-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16 lg:pt-24 lg:pb-[72px] ${SECTION_X}`}
      >
        <div>
          <div className="inline-flex min-h-7 items-center gap-2 rounded-[14px] border border-border px-2.5 py-1 text-ui text-text-2">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-3 bg-success" />
            Works with Amazon SES, SendGrid and any SMTP server
          </div>

          <h1 className="mt-5 text-[40px] leading-[1.08] font-semibold tracking-[-0.025em] text-balance md:text-[56px]">
            Send campaigns through your own provider
          </h1>

          <p className="mt-5 max-w-[560px] text-[17px] leading-[1.55] text-text-2 text-pretty md:text-[19px]">
            Relayd is the audience, campaign and analytics layer on top of the email account you
            already trust. Your reputation stays yours. Your numbers stay honest.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/register" className={PRIMARY_CTA}>
              Start free — no card
            </Link>
            <a href="#" className={SECONDARY_CTA}>
              Read the docs
            </a>
          </div>

          <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-ui text-text-2">
            <span>500 emails/day free for 7 days</span>
            <span>EU data region</span>
            <span>Cancel in one click</span>
          </div>
        </div>

        <div className={`flex flex-col gap-3.5 bg-bg p-5 ${CARD_16}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="truncate text-[15px] font-semibold">{HERO_CAMPAIGN.name}</span>
              <StateBadge states={CAMPAIGN_STATES} state={HERO_CAMPAIGN.state} />
            </div>
            <span className="text-ui whitespace-nowrap text-text-2">via Amazon SES + SendGrid</span>
          </div>

          <div className="rounded-card border border-border bg-surface px-[18px] py-4">
            <SegmentedBar
              counts={HERO_CAMPAIGN.counts}
              total={HERO_CAMPAIGN.recipients}
              note={false}
              legend={false}
              label={<span className="text-ui font-medium">Progress</span>}
              labelAside={
                <>
                  <span className="font-medium text-text">{n(HERO_PROCESSED)}</span>{' '}
                  of {n(HERO_CAMPAIGN.recipients)} · {HERO_PERCENT}%
                </>
              }
            />
            <HeroLegend counts={HERO_CAMPAIGN.counts} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="rounded-card border border-border bg-surface px-4 py-3.5">
              <div className="flex items-center gap-1.5 text-caption text-text-2">
                Click rate
                <span className="inline-flex h-[18px] items-center rounded-badge bg-brand-soft px-1.5 text-pill font-medium text-brand">
                  Headline
                </span>
              </div>
              <div className="mt-1 text-[28px] leading-heading font-semibold tracking-[-0.02em]">4.0%</div>
            </div>

            <div className="rounded-card border border-border bg-surface px-4 py-3.5">
              <div className="flex items-center gap-1.5 text-caption text-text-2">
                Open rate
                <span className="inline-flex h-[18px] items-center rounded-badge bg-neutral-soft px-1.5 text-pill font-medium text-neutral-text">
                  approx.
                </span>
              </div>
              <div className="mt-2 text-[22px] leading-heading font-medium">~38.1%</div>
            </div>

            <div className="rounded-card border border-border bg-surface px-4 py-3.5">
              <div className="text-caption text-text-2">Complaints</div>
              <div className="mt-2 text-[22px] leading-heading font-semibold">0.04%</div>
              <div className="text-label text-text-2">pause at 0.3%</div>
            </div>
          </div>
        </div>
      </section>

      {/* Three steps */}
      <section className={`border-t border-border py-14 lg:py-[72px] ${SECTION_X}`}>
        <div className="max-w-[640px]">
          <h2 className={H2}>Three steps to your first send</h2>
          <p className="mt-3 text-[17px] text-text-2 text-pretty">
            Relayd never carries delivery reputation itself. You connect, we orchestrate, your
            provider delivers.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
          {STEPS.map((step) => (
            <div key={step.n} className={`flex flex-col gap-3.5 bg-bg p-6 ${CARD_16}`}>
              <div className="flex items-center justify-between">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-brand text-body font-semibold text-white">
                  {step.n}
                </span>
                <span className="text-caption text-text-3">{step.time}</span>
              </div>

              <div>
                <div className="text-section leading-heading font-semibold">{step.title}</div>
                <p className="mt-2 text-[15px] text-text-2 text-pretty">{step.body}</p>
              </div>

              <div className="flex items-center gap-2.5 rounded-10 border border-border bg-surface px-3.5 py-3 text-ui">
                <span
                  className={`grid h-8 w-8 flex-none place-items-center rounded-control font-mono text-pill font-medium ${
                    step.tone === 'success' ? 'bg-success-soft text-success-text' : 'bg-brand-soft text-brand'
                  }`}
                >
                  {step.chip}
                </span>
                <span className="truncate text-text-2">{step.chipText}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Sends through */}
      <section
        className={`flex flex-col gap-6 border-y border-border bg-bg py-10 lg:flex-row lg:items-center ${SECTION_X}`}
      >
        <span className="text-body font-medium whitespace-nowrap text-text-2">Sends through</span>

        <div className="flex flex-1 flex-wrap justify-center gap-4">
          {PROVIDERS.map((provider) => (
            <div
              key={provider.kind}
              className="flex min-w-[260px] flex-1 items-center gap-3 rounded-card border border-border bg-surface px-[18px] py-3"
            >
              <span className="grid h-10 w-10 flex-none place-items-center rounded-10 bg-brand-soft font-mono text-caption font-medium text-brand">
                {provider.kind}
              </span>
              <span>
                <span className="block text-[15px] font-semibold">{provider.name}</span>
                <span className="block text-ui text-text-2">{provider.note}</span>
              </span>
            </div>
          ))}
        </div>

        <span className="text-ui whitespace-nowrap text-text-2">Billing by Stripe · no card to start</span>
      </section>

      {/* Honest numbers */}
      <section
        className={`grid grid-cols-1 items-center gap-10 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16 lg:py-20 ${SECTION_X}`}
      >
        <div>
          <div className={EYEBROW}>Honest numbers</div>
          <h2 className={`mt-3 ${H2} text-balance`}>
            Click rate is the headline. Everything else says what it really is.
          </h2>
          <p className="mt-4 text-[17px] text-text-2 text-pretty">
            Open rates are inflated by privacy proxies, so we label them approximate. When a
            provider accepts a message but never confirms it, we call it delivery uncertain and we
            don&apos;t bill you for it. Bot traffic is shown as excluded, never quietly deleted.
          </p>

          <ul className="mt-6 flex list-none flex-col gap-3 p-0 text-[15px]">
            {HONEST.map((item) => (
              <li key={item.title} className="flex items-start gap-3">
                <span className="mt-px grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-success-soft text-success-text">
                  <Icon name="check" size={12} strokeWidth={3} />
                </span>
                <span>
                  <span className="font-medium">{item.title}</span>{' '}
                  <span className="text-text-2">{item.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className={`flex flex-col gap-3 bg-bg p-5 ${CARD_16}`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="rounded-card border border-border bg-surface px-[18px] py-4">
              <div className="flex items-center gap-2 text-ui text-text-2">
                Click rate
                <span className="inline-flex h-5 items-center rounded-badge bg-brand-soft px-[7px] text-label font-medium text-brand">
                  Headline
                </span>
              </div>
              <div className="mt-1.5 text-[36px] leading-heading font-semibold tracking-[-0.02em]">4.6%</div>
              <div className="mt-1 text-ui text-text-2">1,023 unique clickers of 22,241 delivered</div>
            </div>

            <div className="rounded-card border border-border bg-surface px-[18px] py-4">
              <div className="flex items-center gap-1.5 text-ui text-text-2">
                Open rate
                <span className="inline-flex h-5 items-center rounded-badge bg-neutral-soft px-[7px] text-label font-medium text-neutral-text">
                  approximate
                </span>
              </div>
              <div className="mt-2.5 text-[26px] leading-heading font-medium">~44.6%</div>
              <div className="mt-1 text-caption text-text-2">61% from Apple Mail proxies</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-[18px] py-3.5 text-ui">
            <span className="flex flex-wrap items-center gap-2">
              <span aria-hidden="true" className="h-3 w-3 flex-none rounded-3" style={HATCH} />
              <span className="font-medium">Delivery uncertain · 335</span>
              <span className="text-text-2">provider accepted, never confirmed</span>
            </span>
            <span className="font-medium text-success-text">Not billed</span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-[18px] py-3.5 text-ui">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone="bot">Excluded: 1,204 bot events</Badge>
              <span className="text-text-2">link scanners and pre-fetchers</span>
            </span>
            <span className="text-text-2">Shown, not deleted</span>
          </div>
        </div>
      </section>

      {/* Trust and compliance */}
      <section className={`border-t border-border bg-bg py-16 lg:py-20 ${SECTION_X}`}>
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div className="max-w-[640px]">
            <div className={EYEBROW}>Trust and compliance</div>
            <h2 className={`mt-3 ${H2}`}>Consent, suppression and limits are on the surface</h2>
            <p className="mt-3 text-[17px] text-text-2 text-pretty">
              Nothing here is buried in a settings page. The UI shows you what will happen before
              you press launch.
            </p>
          </div>
          <a href="#" className="text-[15px] font-medium whitespace-nowrap text-brand no-underline">
            Security overview →
          </a>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {TRUST.map((card) => (
            <div key={card.title} className={`bg-surface px-6 py-[22px] ${CARD_16}`}>
              <span className="grid h-9 w-9 place-items-center rounded-10 bg-brand-soft text-brand">
                {card.icon === 'globe' ? <GlobeIcon /> : <Icon name={card.icon} size={18} />}
              </span>
              <div className="mt-4 text-[17px] leading-heading font-semibold">{card.title}</div>
              <p className="mt-2 text-body text-text-2 text-pretty">{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Closing */}
      <section className={`border-t border-border py-16 text-center lg:py-24 ${SECTION_X}`}>
        <h2 className="text-[32px] leading-[1.1] font-semibold tracking-[-0.025em] md:text-[40px]">
          Keep your provider. Upgrade everything around it.
        </h2>
        <p className="mx-auto mt-4 max-w-[560px] text-[17px] text-text-2 text-pretty">
          Connect Amazon SES, SendGrid or SMTP in five minutes. Free for 7 days at 500 emails a day,
          then from $49 a month.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/register" className={`${PRIMARY_CTA} px-[22px]`}>
            Create your workspace
          </Link>
          <Link to="/pricing" className={SECONDARY_CTA}>
            See pricing
          </Link>
        </div>
      </section>
    </>
  );
}
