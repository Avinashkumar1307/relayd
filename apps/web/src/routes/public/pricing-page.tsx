import { useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '@relayd/ui';

/**
 * A2 Pricing · "/pricing" (design/A Public.dc.html, frame A2).
 *
 * Static marketing content. `GET /billing/plans` exists but is
 * authenticated and workspace-scoped, and an anonymous visitor has neither
 * a session nor a workspace, so the four cards are copy, exactly as the
 * frame draws them. When a public plans endpoint exists these become its
 * rendering; until then the prices live in one table below and nowhere
 * else.
 *
 * Every CTA goes to /register (the frame's "Start free"), including
 * Enterprise's "Talk to sales", which has no destination in the design —
 * kept as `#` rather than pointed at a page that does not exist.
 *
 * The monthly/annual toggle is the export's arithmetic, not an invented
 * discount: the annual headline price is `round(monthly * 10 / 12)` and the
 * billed line is `monthly * 10` — the "2 months free" the toggle advertises.
 */

interface Plan {
  name: string;
  tagline: string;
  /** `null` is Enterprise: "Custom", no per-month line. */
  monthly: number | null;
  cta: string;
  popular: boolean;
  limits: [string, string][];
  features: string[];
}

// BACKEND PENDING: GET /billing/plans (public, unauthenticated). docs/03
// only has the authenticated, workspace-scoped one.
const PLANS: Plan[] = [
  {
    name: 'Starter',
    tagline: 'For a first list and a monthly send.',
    monthly: 49,
    cta: 'Start free',
    popular: false,
    limits: [
      ['Emails / month', '25,000'],
      ['Contacts', '10,000'],
      ['Analytics retention', '3 months'],
      ['Seats', '3'],
    ],
    features: [
      '1 provider connection',
      'Segments and imports with consent log',
      'Click and approximate open tracking',
      'Email support',
    ],
  },
  {
    name: 'Growth',
    tagline: 'For teams sending every week across brands.',
    monthly: 249,
    cta: 'Start free',
    popular: true,
    limits: [
      ['Emails / month', '250,000'],
      ['Contacts', '100,000'],
      ['Analytics retention', '13 months'],
      ['Seats', '10'],
    ],
    features: [
      'Unlimited connections and sending pools',
      'API keys and outbound webhooks',
      'Roles: Owner, Admin, Editor, Viewer',
      'Overage $1.20 per 1,000 emails',
      'Priority support',
    ],
  },
  {
    name: 'Scale',
    tagline: 'For high volume with strict deliverability.',
    monthly: 749,
    cta: 'Start free',
    popular: false,
    limits: [
      ['Emails / month', '1,000,000'],
      ['Contacts', '500,000'],
      ['Analytics retention', '25 months'],
      ['Seats', '25'],
    ],
    features: [
      'Everything in Growth',
      'Complaint auto-pause thresholds per campaign',
      'Audit log export and SIEM webhook',
      'Overage $0.90 per 1,000 emails',
      'Named support contact',
    ],
  },
  {
    name: 'Enterprise',
    tagline: 'For 2M+ emails, procurement and SSO.',
    monthly: null,
    cta: 'Talk to sales',
    popular: false,
    limits: [
      ['Emails / month', '2M+'],
      ['Contacts', 'Custom'],
      ['Analytics retention', 'Custom'],
      ['Seats', 'Unlimited'],
    ],
    features: [
      'Everything in Scale',
      'SSO (SAML) and SCIM',
      'DPA, security review, custom retention',
      'Uptime SLA and dedicated support',
    ],
  },
];

const FAQ: [string, string][] = [
  [
    'Do I still pay Amazon SES or SendGrid?',
    'Yes. Your provider bills you for delivery exactly as before. Relayd bills only for orchestration: the audience, campaign engine, tracking, analytics and compliance tooling.',
  ],
  [
    'What counts as an email sent?',
    'Every message Relayd hands to your provider that the provider accepts. Delivery-uncertain messages, where the provider accepted but never confirmed, are not billed. Test sends are not billed.',
  ],
  [
    'What happens if I go over my monthly emails?',
    'Sending continues and the overage rate for your plan applies. We show the usage meter on every dashboard and warn at 80% and 100%. We never move you to a bigger plan without your say.',
  ],
  [
    'Can I downgrade?',
    'Yes, from Billing → Plans. Downgrades are scheduled for your renewal date. If you are over the target plan’s limits, we show exactly what to reduce before it can go through.',
  ],
  [
    'How does analytics retention work when I upgrade?',
    'Retention applies forward. Reports already archived under your old window are not restored. From the day you upgrade, new data is kept for the longer window.',
  ],
  [
    'How do I cancel?',
    'Billing → Cancel subscription. One confirmation, no retention offers. You keep everything until the end of the period you paid for, and can export contacts and reports for 30 days after.',
  ],
];

const SECTION_X = 'px-6 md:px-16';

/**
 * The segmented monthly/annual control.
 *
 * Not a sheet component — `Tabs` is the underlined page tab, and the design
 * system has no pill segmented control — so it is built here from the
 * frame's own geometry: 34px buttons in a 4px padded, 10px radius well.
 */
function BillingToggle({
  annual,
  onChange,
}: {
  annual: boolean;
  onChange: (annual: boolean) => void;
}) {
  const seg = (on: boolean): string =>
    [
      'inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-[7px] border-0 px-3.5 text-body font-medium',
      on ? 'bg-surface text-text shadow-[0_1px_2px_rgba(17,24,39,0.08)]' : 'bg-transparent text-text-2',
    ].join(' ');

  return (
    <div
      role="group"
      aria-label="Billing period"
      className="mt-7 inline-flex items-center gap-1 rounded-10 border border-border bg-bg p-1"
    >
      <button type="button" aria-pressed={!annual} className={seg(!annual)} onClick={() => onChange(false)}>
        Monthly
      </button>
      <button type="button" aria-pressed={annual} className={seg(annual)} onClick={() => onChange(true)}>
        Annual
        <span
          className={`inline-flex h-5 items-center rounded-badge px-[7px] text-label font-semibold ${
            annual ? 'bg-success-soft text-success-text' : 'bg-neutral-soft text-text-2'
          }`}
        >
          2 months free
        </span>
      </button>
    </div>
  );
}

function PlanCard({ plan, annual }: { plan: Plan; annual: boolean }) {
  const price =
    plan.monthly === null ? 'Custom' : `$${annual ? Math.round((plan.monthly * 10) / 12) : plan.monthly}`;
  const billed =
    plan.monthly === null
      ? 'Annual contract'
      : annual
        ? `$${plan.monthly * 10} billed yearly`
        : 'billed monthly · cancel anytime';

  return (
    <div
      className={`relative rounded-[16px] bg-surface px-6 py-[26px] ${
        plan.popular ? 'border border-brand shadow-[0_0_0_3px_var(--brand-soft)]' : 'border border-border'
      }`}
    >
      {plan.popular ? (
        <span className="absolute -top-3 left-[22px] inline-flex h-6 items-center rounded-full bg-brand px-2.5 text-caption font-semibold text-white">
          Most teams
        </span>
      ) : null}

      <div className="text-[18px] font-semibold">{plan.name}</div>
      <div className="mt-1 min-h-[42px] text-body text-text-2 text-pretty">{plan.tagline}</div>

      <div className="mt-[18px] flex items-baseline gap-1.5">
        <span className="text-[40px] leading-none font-semibold tracking-[-0.025em] tabular-nums">{price}</span>
        {plan.monthly === null ? null : <span className="text-body text-text-2">/ month</span>}
      </div>
      <div className="mt-1.5 min-h-5 text-ui text-text-2">{billed}</div>

      <Link
        to="/register"
        className={`mt-[18px] flex h-[42px] items-center justify-center rounded-control border text-[15px] font-medium no-underline ${
          plan.popular
            ? 'border-transparent bg-brand text-white hover:bg-brand-hover'
            : 'border-border bg-surface text-text hover:bg-tint'
        }`}
      >
        {plan.cta}
      </Link>

      <div className="mt-[22px] flex flex-col gap-2.5 border-t border-border pt-[18px] text-body">
        {plan.limits.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <span className="text-text-2">{label}</span>
            <span className="text-right font-medium tabular-nums">{value}</span>
          </div>
        ))}
      </div>

      <ul className="mt-[18px] flex list-none flex-col gap-2 p-0 text-body">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <Icon name="check" size={14} strokeWidth={3} className="mt-[3px] flex-none text-success" />
            <span className="text-text">{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PricingPage() {
  const [annual, setAnnual] = useState(false);
  const [openQuestion, setOpenQuestion] = useState<number | null>(0);

  return (
    <>
      <section className={`pt-14 pb-10 text-center lg:pt-[72px] ${SECTION_X}`}>
        <h1 className="text-[36px] leading-[1.1] font-semibold tracking-[-0.025em] md:text-[48px]">
          Pay for what you send
        </h1>
        <p className="mx-auto mt-3.5 max-w-[560px] text-[18px] text-text-2 text-pretty">
          Provider costs stay with your provider. Relayd bills for orchestration: emails per month,
          contacts, seats and how long we keep your analytics.
        </p>
        <BillingToggle annual={annual} onChange={setAnnual} />
      </section>

      <section className={`grid grid-cols-1 gap-5 pb-6 sm:grid-cols-2 xl:grid-cols-4 ${SECTION_X}`}>
        {PLANS.map((plan) => (
          <PlanCard key={plan.name} plan={plan} annual={annual} />
        ))}
      </section>

      <section className={`pt-2 pb-14 ${SECTION_X}`}>
        <div className="flex items-start gap-3 rounded-card border border-border bg-bg px-5 py-4 text-body text-text-2 text-pretty">
          <Icon name="info" size={18} strokeWidth={2} className="mt-px flex-none text-info-text" />
          <span>
            <span className="font-semibold text-text">Retention applies forward.</span> Each plan
            keeps campaign analytics for its retention window. When a report ages past that window
            it is archived and is not restored if you upgrade later; the longer window applies to
            new data from the day you upgrade. Contacts, suppressions and the audit trail of
            consent are kept for the life of your workspace on every plan. Overage on Starter,
            Growth and Scale is billed at the listed rate; we never silently upgrade you.
          </span>
        </div>
      </section>

      <section
        className={`grid grid-cols-1 gap-10 border-t border-border pt-14 pb-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-16 lg:pb-20 ${SECTION_X}`}
      >
        <div>
          <h2 className="text-headline leading-[1.15] font-semibold tracking-[-0.02em]">Questions</h2>
          <p className="mt-3 text-card text-text-2">
            Anything else, ask{' '}
            <a href="mailto:sales@relayd.io" className="font-medium text-brand no-underline">
              sales@relayd.io
            </a>
            .
          </p>
        </div>

        <div className="flex flex-col">
          {FAQ.map(([question, answer], index) => {
            const open = openQuestion === index;
            return (
              <div key={question} className="border-b border-border py-[18px]">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenQuestion(open ? null : index)}
                  className="flex w-full cursor-pointer items-center justify-between gap-4 border-0 bg-transparent p-0 text-left text-[17px] font-medium text-text"
                >
                  {question}
                  <Icon
                    name="chevronDown"
                    size={18}
                    strokeWidth={2}
                    className={`flex-none text-text-2 ${open ? 'rotate-180' : ''}`}
                  />
                </button>
                {open ? <p className="mt-2.5 text-[15px] text-text-2 text-pretty">{answer}</p> : null}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
