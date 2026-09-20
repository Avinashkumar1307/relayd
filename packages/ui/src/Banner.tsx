import type { ComponentType, ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';
import type { LinkProps } from './Shell.js';
import type { Tone } from './states.js';

/**
 * Global banners (design/00 Design System.dc.html, "Global banners (K1)";
 * design/K System States.dc.html, `BANNERS`; design/Shell.dc.html, the slot
 * under the top bar).
 *
 * The sheet's rule, verbatim: "Rendered in the slot under the top bar. One
 * at a time, highest severity wins. Copy says what happened and what
 * continues to work."
 *
 * Measured from the sheet: `10px 16px`, 12px gap, an 8px radius, the tone's
 * soft tint behind a 1px border in the tone's hue, an 18px icon in the
 * tone's text colour, 13px copy with the title at 600 and the body in
 * text-2, then the action and the state key in 11px mono.
 *
 * `Shell` renders the same content full-bleed in its own slot (no radius, a
 * bottom rule instead of a border, 32px side padding). This component is the
 * card form the sheet draws — for the banner list in K1 and for a banner
 * inside a page, like the "Held by billing" line on G3b.
 */

export type BannerTone = Extract<Tone, 'warning' | 'danger' | 'info'>;

const TONE: Record<BannerTone, string> = {
  warning: 'border-warning bg-warning-soft',
  danger: 'border-danger bg-danger-soft',
  info: 'border-info bg-info-soft',
};

const ICON_TONE: Record<BannerTone, string> = {
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  info: 'text-info-text',
};

function DefaultLink({ href, children, ...rest }: LinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

export interface BannerProps {
  tone: BannerTone;
  icon: IconName;
  /** "Payment failed on 15 Sep." — 600, ends with a full stop in every frame. */
  title: ReactNode;
  /** What continues to work, and what does not. */
  body?: ReactNode | undefined;
  action?: { label: string; href: string } | undefined;
  Link?: ComponentType<LinkProps> | undefined;
  /** The state key in mono at the right, as the K1 list shows it. */
  code?: string | undefined;
}

export function Banner({ tone, icon, title, body, action, Link = DefaultLink, code }: BannerProps) {
  return (
    <div
      // Danger means a workspace has just lost the ability to send; that is
      // worth interrupting for. The other two are read when reached.
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex items-center gap-3 rounded-control border px-4 py-2.5 ${TONE[tone]}`}
    >
      <span className={`flex-none ${ICON_TONE[tone]}`}>
        <Icon name={icon} size={18} />
      </span>
      <div className="min-w-0 flex-1 text-ui text-text">
        <span className="font-semibold">{title}</span> {body === undefined ? null : <span className="text-text-2">{body}</span>}
      </div>
      {action === undefined ? null : (
        <Link href={action.href} className="whitespace-nowrap text-ui font-medium text-brand no-underline">
          {action.label}
        </Link>
      )}
      {code === undefined ? null : (
        <code className="whitespace-nowrap font-mono text-label text-text-3">{code}</code>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The six K1 banners and their state contracts                        */
/* ------------------------------------------------------------------ */

export type BannerKey = 'past_due' | 'restricted' | 'suspended' | 'new_cap' | 'complaint_pause' | 'provider_failed';

/**
 * What the K1 frames state about each banner: the state that raises it,
 * what still works while it is up, what it blocks, and what takes it down.
 *
 * None of the six is dismissible — there is no ✕ on any of them in the
 * export. `clearedBy` is the only way each one goes away, which is the
 * point: a banner a user can dismiss is a billing state a user can forget.
 */
export interface BannerContract {
  /** The condition that raises it. */
  trigger: string;
  /** What keeps working while it is up — the sheet insists this is said. */
  keepsWorking: readonly string[];
  /** What it blocks. */
  blocked: readonly string[];
  /** What takes it down, and what happens if it is left up. */
  clearedBy: string;
  /** Whose banner the action belongs to; other roles see "Ask your workspace owner". */
  actor: 'Owner' | 'Admin';
  /** `suspended` puts the whole workspace in read-only (Shell.dc.html). */
  readOnly: boolean;
}

export interface BannerDefinition {
  key: BannerKey;
  tone: BannerTone;
  icon: IconName;
  title: string;
  body: string;
  /** The link's words. The route is the app's: a campaign id is not the design's to know. */
  actionLabel: string;
  contract: BannerContract;
}

/**
 * Copy is verbatim from `BANNERS` in design/Shell.dc.html; the contract is
 * verbatim from `BANNERS` in design/K System States.dc.html. Both are the
 * design's words, not a paraphrase — apps/web picks by key and renders,
 * so this table and the frames cannot drift.
 */
export const BANNERS: Readonly<Record<BannerKey, BannerDefinition>> = {
  past_due: {
    key: 'past_due',
    tone: 'warning',
    icon: 'alert',
    title: 'Payment failed on 15 Sep.',
    body: 'Sending continues while we retry your card for 14 days. Scheduled campaigns run as planned until 29 Sep.',
    actionLabel: 'Update payment method',
    contract: {
      trigger: 'Card declined on the renewal date. Retries on days 2, 4, 7 and 11.',
      keepsWorking: ['Sending, scheduling and launches', 'Imports, API, webhooks', 'Everything else'],
      blocked: ['Nothing yet'],
      clearedBy:
        'At day 15 the workspace becomes restricted. Owner sees “Update payment method”; other roles see “Ask your workspace owner”.',
      actor: 'Owner',
      readOnly: false,
    },
  },
  restricted: {
    key: 'restricted',
    tone: 'warning',
    icon: 'lock',
    title: 'Payment is 18 days overdue.',
    body: 'New launches are blocked and 2 scheduled campaigns are held until the invoice is paid. Contacts and reports stay available.',
    actionLabel: 'Update payment method',
    contract: {
      trigger: 'Invoice still unpaid after 14 days of retries.',
      keepsWorking: [
        'Viewing contacts, campaigns and reports',
        'Editing drafts and templates',
        'Imports and exports',
        'Campaigns already sending finish',
      ],
      blocked: ['New launches and launch requests', 'Scheduled campaigns (moved to held)', 'API sends'],
      clearedBy:
        'At day 31 the workspace is suspended. Held campaigns launch automatically when payment clears.',
      actor: 'Owner',
      readOnly: false,
    },
  },
  suspended: {
    key: 'suspended',
    tone: 'danger',
    icon: 'lock',
    title: 'Workspace suspended.',
    body: 'Everything is read-only until billing is resolved. Nothing has been deleted; your data is retained for 30 days.',
    actionLabel: 'Resolve billing',
    contract: {
      trigger: 'Invoice unpaid after 30 days.',
      keepsWorking: ['Signing in', 'Viewing everything', 'Exporting contacts, suppressions and reports'],
      blocked: [
        'Every write: sending, editing, imports, API writes, outbound webhooks',
        'Inviting members',
      ],
      clearedBy:
        'Data is retained 30 more days, then deleted with 3 email warnings. Paying the open invoice restores full access within a minute.',
      actor: 'Owner',
      readOnly: true,
    },
  },
  new_cap: {
    key: 'new_cap',
    tone: 'info',
    icon: 'info',
    title: 'New account sending cap: 500 emails/day.',
    body: 'Applies for your first 7 days (ends 24 Sep). Your provider limits also apply.',
    actionLabel: 'How caps work',
    contract: {
      trigger: 'Workspace created less than 7 days ago.',
      keepsWorking: ['Everything', 'Up to 500 emails per day across all campaigns'],
      blocked: ['Sending more than 500 in a day (queued until the next day)'],
      clearedBy: 'Cap lifts automatically on day 8. Provider limits still apply underneath it.',
      actor: 'Owner',
      readOnly: false,
    },
  },
  complaint_pause: {
    key: 'complaint_pause',
    tone: 'warning',
    icon: 'alert',
    title: 'Paused automatically: complaint rate exceeded 0.3%.',
    body: '"Eid al-Etihad flash sale" stopped at 0.34%. Review the audience and content before resuming.',
    actionLabel: 'Review campaign',
    contract: {
      trigger: 'Complaint rate on a sending campaign crossed 0.3% of delivered.',
      keepsWorking: ['Every other campaign', 'Editing the paused campaign’s audience and content'],
      blocked: ['That campaign’s remaining sends until an Owner or Admin resumes'],
      clearedBy:
        'Resume re-checks the rate every 500 sends and pauses again if it stays above 0.3%. Suppressions from the complaints are already applied.',
      actor: 'Owner',
      readOnly: false,
    },
  },
  provider_failed: {
    key: 'provider_failed',
    tone: 'danger',
    icon: 'plug',
    title: 'Provider connection failed: SendGrid · marketing.',
    body: 'Authentication was rejected at 08:40 GST. 1 sending campaign is paused until credentials are rotated.',
    actionLabel: 'Fix connection',
    contract: {
      trigger: 'SendGrid rejected the API key at 08:40 GST.',
      keepsWorking: ['Campaigns on other connections', 'Viewing and editing everything'],
      blocked: ['Sends through the failed connection (campaigns using it pause)', 'Delivery events from it'],
      clearedBy:
        'Rotate credentials in Providers. Paused campaigns resume where they stopped; nothing is sent twice.',
      actor: 'Admin',
      readOnly: false,
    },
  },
};

/** The six, in the order K1 lists them: dunning ladder, then the abuse states. */
export const BANNER_ORDER: readonly BannerKey[] = [
  'past_due',
  'restricted',
  'suspended',
  'new_cap',
  'complaint_pause',
  'provider_failed',
];
