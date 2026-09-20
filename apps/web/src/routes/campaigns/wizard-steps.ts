import type { Campaign } from '../../api/campaigns.js';

/**
 * The seven-step campaign wizard, as data.
 *
 * Kept out of the components so the rules about which steps are reachable are
 * testable without rendering anything, and so there is exactly one answer to
 * "can this campaign be launched" rather than one per component that asks.
 *
 * The order and the labels are the design's, from the `STEPS` table at the
 * foot of `design/G Campaigns.dc.html`:
 *
 *   Details · Audience · Sender & pool · Content · Tracking & compliance ·
 *   Schedule · Review
 *
 * Audience comes before content because the merge tags an author can use
 * depend on what the audience actually has, and sender comes before content
 * because an unverified sender is the most common reason a review fails —
 * finding that out after writing the email is the expensive order.
 *
 * `slug` is what appears in the URL. docs/09 wants the wizard linkable and
 * refresh-safe, so the step lives at `/campaigns/:id/edit/:step` rather than
 * in component state that a reload throws away.
 */

export const WIZARD_STEPS = [
  { key: 'details', slug: 'details', label: 'Details' },
  { key: 'audience', slug: 'audience', label: 'Audience' },
  { key: 'sender', slug: 'sender', label: 'Sender & pool' },
  { key: 'template', slug: 'content', label: 'Content' },
  { key: 'tracking', slug: 'tracking', label: 'Tracking & compliance' },
  { key: 'schedule', slug: 'schedule', label: 'Schedule' },
  { key: 'review', slug: 'review', label: 'Review' },
] as const;

export type WizardStepKey = (typeof WIZARD_STEPS)[number]['key'];
export type WizardStepSlug = (typeof WIZARD_STEPS)[number]['slug'];

/** The first step, which is where `/campaigns/new` opens. */
export const FIRST_STEP = WIZARD_STEPS[0];

/**
 * The index of a step named in the URL, or 0 for a slug that means nothing.
 *
 * A bad slug lands on step one rather than on an error page: the URL is
 * shareable, so a truncated paste is a normal way to arrive here.
 */
export function stepIndexFor(slug: string | undefined): number {
  const at = WIZARD_STEPS.findIndex((step) => step.slug === slug);
  return at === -1 ? 0 : at;
}

export interface PreflightIssue {
  step: WizardStepKey;
  /** `blocking` stops a launch; `warning` is shown and can be sent past. */
  severity: 'blocking' | 'warning';
  message: string;
}

export interface PreflightInput {
  campaign: Pick<
    Campaign,
    'name' | 'subjectOverride' | 'templateVersionId' | 'senderAccountId' | 'sendingPoolId' | 'audience'
  >;
  audienceCount: { eligible: number; suppressed: number } | null;
  senderVerified: boolean | null;
  /** Merge tags the template needs that the audience cannot all satisfy. */
  unsatisfiableMergeTags: readonly string[];
}

/**
 * Everything wrong with a campaign, in the order the wizard would fix it.
 *
 * This is the client's copy of the launch pre-flight, and it is deliberately
 * *not* the authority — `launchCampaign` on the server re-checks every one of
 * these inside the transaction, because the audience can change between the
 * review step and the click. What this buys is telling the author before they
 * click, on the step that can fix it.
 */
export function preflight(input: PreflightInput): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const { campaign } = input;

  if (campaign.name.trim() === '') {
    issues.push({ step: 'details', severity: 'blocking', message: 'Give this campaign a name' });
  }

  if ((campaign.subjectOverride ?? '').trim() === '') {
    issues.push({ step: 'details', severity: 'blocking', message: 'Add a subject line' });
  }

  const listIds = campaign.audience.listIds ?? [];
  const segmentIds = campaign.audience.segmentIds ?? [];

  if (listIds.length === 0 && segmentIds.length === 0) {
    issues.push({ step: 'audience', severity: 'blocking', message: 'Choose at least one list or segment' });
  } else if (input.audienceCount !== null) {
    if (input.audienceCount.eligible === 0) {
      issues.push({
        step: 'audience',
        severity: 'blocking',
        message:
          input.audienceCount.suppressed > 0
            ? 'Every contact in this audience is unsubscribed or suppressed'
            : 'This audience has no contacts',
      });
    } else if (input.audienceCount.suppressed > 0) {
      // A warning, not a block. Some suppression is normal and healthy, and
      // refusing to send because any exists would make the product unusable.
      issues.push({
        step: 'audience',
        severity: 'warning',
        message: `${input.audienceCount.suppressed.toLocaleString()} contacts will be skipped because they are suppressed`,
      });
    }
  }

  if (campaign.templateVersionId === null) {
    issues.push({ step: 'template', severity: 'blocking', message: 'Choose a template' });
  }

  for (const tag of input.unsatisfiableMergeTags) {
    // A warning: the merge tag has a default, so the send is correct — it is
    // just less personal than the author expects, and they should know before
    // rather than after.
    issues.push({
      step: 'template',
      severity: 'warning',
      message: `Not every contact has a value for {{${tag}}} — the default will be used`,
    });
  }

  if (campaign.senderAccountId === null && campaign.sendingPoolId === null) {
    issues.push({ step: 'sender', severity: 'blocking', message: 'Choose a sender or a sending pool' });
  } else if (campaign.senderAccountId !== null && input.senderVerified === false) {
    issues.push({
      step: 'sender',
      severity: 'blocking',
      message: 'This sender’s identity is not verified with its provider',
    });
  }

  return issues;
}

/** Whether the launch button should be enabled. */
export function canLaunch(issues: readonly PreflightIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'blocking');
}

/**
 * Whether a step is worth visiting given what is filled in.
 *
 * Deliberately permissive: every step is always reachable. A wizard that
 * locks step five until steps one to four are perfect is a wizard people
 * fight — authors jump to the content step first and fill in the name later,
 * and that is a reasonable way to work.
 *
 * What the wizard does instead is mark which steps still have something
 * wrong, so the author can see where to go without being sent there.
 */
export function stepsWithIssues(issues: readonly PreflightIssue[]): Set<WizardStepKey> {
  return new Set(issues.filter((i) => i.severity === 'blocking').map((issue) => issue.step));
}

/**
 * Whether the campaign can still be edited at all.
 *
 * The server refuses an edit to anything past `scheduled` — a launched
 * campaign has a snapshot and a pinned template behind it, and editing the
 * subject would change what the report claims was sent. The wizard shows the
 * campaign read-only rather than letting the author type into fields whose
 * save will be rejected.
 */
export function isEditable(status: Campaign['status']): boolean {
  return status === 'draft' || status === 'scheduled';
}

/* ------------------------------------------------------- pre-flight checks */

/**
 * One row of G2s7's pre-flight list.
 *
 * Three outcomes, not two. A warning that blocked would make the quota check
 * unusable — leaning on one pool member is normal — and a warning that read
 * as a pass would hide the one thing worth reading before a 48,000-recipient
 * send.
 */
export type CheckOutcome = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  key: string;
  outcome: CheckOutcome;
  title: string;
  detail: string;
  /** The link or button at the right of the row: "Review pool". */
  action?: { label: string; href?: string } | undefined;
}

/** "1 fail · 1 warning · 5 pass" — the badge beside the Review heading. */
export function preflightSummary(checks: readonly PreflightCheck[]): {
  label: string;
  tone: 'danger' | 'warning' | 'success';
} {
  const fail = checks.filter((check) => check.outcome === 'fail').length;
  const warn = checks.filter((check) => check.outcome === 'warn').length;
  const pass = checks.filter((check) => check.outcome === 'pass').length;

  const plural = (n: number, word: string) => `${n} ${word}${word === 'pass' || n === 1 ? '' : 's'}`;

  return {
    label: `${fail} fail · ${plural(warn, 'warning')} · ${pass} pass`,
    tone: fail > 0 ? 'danger' : warn > 0 ? 'warning' : 'success',
  };
}

/**
 * Why the launch button is disabled, in the words G2s7 puts in its tooltip.
 *
 * `null` means it is enabled. Returning the reason rather than a boolean is
 * the point: docs/09's rule is that a control which says no says why, and a
 * disabled button with no title is the commonest way that rule is broken.
 */
export function launchBlockedReason(input: {
  checks: readonly PreflightCheck[];
  consentAttested: boolean;
  canLaunchPermission: boolean;
  readOnly: boolean;
}): string | null {
  if (!input.canLaunchPermission) {
    return 'Editors cannot launch. Ask an Owner or Admin to approve this campaign.';
  }
  if (input.readOnly) return 'Workspace is read-only';
  if (input.checks.some((check) => check.outcome === 'fail')) return 'Clear the failing check first';
  if (!input.consentAttested) return 'Confirm consent in step 5';
  return null;
}
