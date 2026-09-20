/**
 * Campaign launch.
 *
 * Launch is where a draft becomes irrevocable, and four things must hold at
 * once. Each is an invariant with a review finding behind it:
 *
 *   R29/F29 — the transition into `validating` is guarded. Double-clicking
 *   launch, or a retried HTTP request, must produce one snapshot. `UPDATE ...
 *   WHERE state IN ('draft','scheduled')` returning zero rows is the answer,
 *   and an Idempotency-Key gives the loser the winner's result rather than an
 *   error.
 *
 *   R28/F28 — the entitlement row is read `FOR SHARE` inside the launch
 *   transaction. Checking the limit, then snapshotting, then committing lets a
 *   downgrade commit in the gap and the campaign launches over the new plan's
 *   limit.
 *
 *   The template version is pinned. A campaign records what it rendered, so a
 *   later edit cannot change history.
 *
 *   The snapshot is the audience as it was. Suppression is re-checked at send
 *   time anyway (R30), because a six-hour campaign otherwise mails someone who
 *   unsubscribed in hour two.
 *
 * Everything here is expressed against ports. The transaction, the guarded
 * update and the snapshot query belong to packages/db; this is the ordering
 * and the decisions, which is the part that is easy to get wrong and hard to
 * see.
 */

import { attestationAuthorises, type Attestation } from '../abuse/consent.js';
import { mayLaunch, needsReview, type EnforcementStage } from '../abuse/enforcement.js';
import type { LintFinding } from '../abuse/phishing.js';

export type LaunchFailure =
  | 'not_launchable'
  | 'no_template'
  | 'no_sender'
  | 'empty_audience'
  | 'entitlement_exceeded'
  | 'no_entitlement'
  | 'unverified_sender'
  | 'unverified_account'
  | 'pool_routing_unavailable'
  | 'consent_not_attested'
  | 'consent_audience_changed'
  | 'enforcement_paused'
  | 'enforcement_review_required'
  | 'content_blocked'
  | 'blocked_link_domain'
  | 'unresolvable_merge_tags';

export interface LaunchPort {
  /**
   * The guarded transition (R29).
   *
   * Returns false when the campaign was not in `draft` or `scheduled` — which
   * means somebody else is launching it, or it has launched already.
   */
  claimForLaunch(campaignId: string): Promise<boolean>;

  /** Returns the campaign, or null. Read inside the same transaction. */
  readCampaign(campaignId: string): Promise<LaunchableCampaign | null>;

  /**
   * The entitlement row, locked `FOR SHARE` (R28).
   *
   * Holding the share lock blocks a concurrent downgrade from committing
   * until this transaction ends, so the limit cannot change underneath the
   * snapshot.
   *
   * Null means the workspace has no entitlement to send at all — no active
   * subscription, and under D7 there is no free tier — and refuses the
   * launch. Through Phase 6 this meant the opposite, "no limit enforced",
   * which was correct only for as long as billing did not exist.
   */
  readEntitlementForShare(workspaceId: string): Promise<{ monthlySendLimit: number | null; used: number } | null>;

  /** Whether the sender's identity is still verified with the provider. */
  senderIsUsable(senderAccountId: string): Promise<boolean>;

  /**
   * Whether the workspace owner has verified their email address.
   *
   * docs/06: "Email verification before any send." Checked at launch rather
   * than only at signup, because an account can be created, verified, have
   * its email changed, and be launched from — and the verification that
   * matters is the current one.
   */
  ownerEmailIsVerified(workspaceId: string): Promise<boolean>;

  /**
   * Whether the workspace is still inside its new-account ramp (docs/06).
   *
   * Only the boolean, not the daily counter: the per-day cap is a rate limit
   * enforced page by page in `dispatch`, and refusing a launch because
   * today's 500 are already spent would tell a real customer their campaign
   * is too big, which is neither true nor the message.
   *
   * What *is* refused here is pool routing, which is a property of the
   * campaign rather than of the day.
   */
  workspaceIsInRamp(workspaceId: string): Promise<boolean>;

  /**
   * The workspace's enforcement stage (docs/06 "Response ladder").
   *
   * Read inside the launch transaction. A workspace paused by the nightly
   * sweep between the client loading the page and pressing send must not get
   * one more campaign out.
   */
  readEnforcementStage(workspaceId: string): Promise<EnforcementStage>;

  /**
   * Whether an operator has approved this specific campaign.
   *
   * Only consulted at `review_required`. Per campaign rather than per
   * workspace, because "we looked at this one" is the thing being asserted —
   * a workspace-level approval would wave through every campaign after it,
   * which is the same as not being in review at all.
   */
  launchIsApproved(campaignId: string): Promise<boolean>;

  /**
   * The phishing lint and the link-reputation check, run together
   * (docs/06 "Content scanning" and "Link reputation").
   *
   * One port rather than two because both need the rendered message, and
   * rendering it twice inside a launch transaction to ask two questions
   * would double the most expensive part of the check.
   *
   * Returning `blocked: false` with findings is the normal case: most
   * campaigns have something worth saying and nothing worth stopping.
   */
  scanContent(campaignId: string): Promise<{
    blocked: boolean;
    findings: readonly LintFinding[];
    /** Domains a reputation feed called malicious. Any entry blocks. */
    blockedDomains: readonly string[];
    /** True when the feed could not be reached. Recorded, never fatal. */
    reputationUnavailable: boolean;
  }>;

  /**
   * The newest consent attestation for this campaign, or null.
   *
   * docs/06: "every launch re-confirms it". Read inside the launch
   * transaction, so an attestation written concurrently is either visible to
   * this launch or belongs to the next one — never half of each.
   */
  readConsentAttestation(campaignId: string): Promise<Attestation | null>;


  /**
   * Writes the audience snapshot.
   *
   * One row per contact, deduplicated by the unique index on
   * (campaign_id, contact_id) — so a snapshot that somehow runs twice inserts
   * nothing the second time rather than doubling the campaign.
   */
  snapshotAudience(input: {
    campaignId: string;
    audience: unknown;
  }): Promise<{ inserted: number; suppressedAtSnapshot: number }>;

  /** Initialises campaign_counters from the snapshot (R13). */
  initialiseCounters(input: { campaignId: string; total: number }): Promise<void>;

  /** Moves the campaign on, recording what was pinned. */
  markQueueing(input: {
    campaignId: string;
    recipientCount: number;
    templateVersionId: string;
  }): Promise<void>;

  /** Releases the claim when validation fails, so the draft is editable again. */
  releaseClaim(input: { campaignId: string; reason: LaunchFailure }): Promise<void>;

  recordEvent(input: { campaignId: string; eventType: string; detail: unknown }): Promise<void>;
}

export interface LaunchableCampaign {
  id: string;
  workspaceId: string;
  templateVersionId: string | null;
  senderAccountId: string | null;
  sendingPoolId: string | null;
  audience: unknown;
  /** Required merge tags the template declares, for the pre-flight check. */
  requiredMergeTags?: readonly string[];
}

export interface LaunchResult {
  ok: boolean;
  failure?: LaunchFailure;
  message?: string;
  recipientCount?: number;
  suppressedAtSnapshot?: number;
}

/* ------------------------------------------------------------ pre-flight -- */

/**
 * The pre-flight, factored out so launch and `POST /campaigns/:id/preflight`
 * cannot disagree.
 *
 * G2 step 7 shows the customer a list of checks before they press send. The
 * only safe way to build that list is to run the checks launch runs — a
 * pre-flight that says "7 pass" and is then refused by the launch it was
 * supposed to predict is worse than no pre-flight at all, because it teaches
 * the customer that the page is wrong and the error is noise.
 *
 * So there is one function, called twice:
 *
 *   Launch calls it with `stopAtFirstFailure: true`, which reproduces the
 *   original control flow exactly — including *not* running the expensive
 *   content scan when a cheaper check has already refused the launch.
 *
 *   The pre-flight endpoint calls it with `stopAtFirstFailure: false` and
 *   renders every row.
 *
 * Everything the pre-flight cannot answer without launching stays out of it:
 * the audience snapshot, and therefore `empty_audience` and
 * `entitlement_exceeded`, which are decided against the rows the snapshot
 * actually wrote. Those two remain in `launchCampaign` below. Reporting a
 * guess at them here is exactly the disagreement this refactor exists to
 * prevent.
 */
export type PreflightOutcome = 'pass' | 'warn' | 'fail';

export const PREFLIGHT_KEYS = [
  'template',
  'sender',
  'account',
  'pool_routing',
  'enforcement',
  'links',
  'content',
  'consent',
  'entitlement',
] as const;

export type PreflightKey = (typeof PREFLIGHT_KEYS)[number];

export interface PreflightCheck {
  key: PreflightKey;
  outcome: PreflightOutcome;
  title: string;
  detail: string;
  /**
   * The launch failure this check would produce, or null.
   *
   * Carried on the row rather than only in the summary so a caller can map
   * one row to one remedy — and so a reader can see, per row, that the
   * pre-flight and the launch are naming the same thing.
   */
  failure: LaunchFailure | null;
}

/**
 * What the pre-flight needs. A strict subset of `LaunchPort`, so any
 * implementation of the launch port is already an implementation of this and
 * the two can never be wired to different data.
 */
export type PreflightPort = Pick<
  LaunchPort,
  | 'senderIsUsable'
  | 'ownerEmailIsVerified'
  | 'workspaceIsInRamp'
  | 'readEnforcementStage'
  | 'launchIsApproved'
  | 'scanContent'
  | 'readConsentAttestation'
  | 'readEntitlementForShare'
>;

export interface PreflightResult {
  checks: PreflightCheck[];
  /** The first failure in launch order, or null. */
  failure: { failure: LaunchFailure; message: string } | null;
  /**
   * The entitlement row the check read, so launch can apply the limit
   * against its snapshot without reading — and re-locking — it twice.
   */
  entitlement: { monthlySendLimit: number | null; used: number } | null;
}

export interface PreflightOptions {
  /** True for launch: stop as soon as something refuses it. */
  stopAtFirstFailure: boolean;
  /**
   * Called immediately after a content scan that did not block, at the exact
   * point `launchCampaign` used to record its warning events.
   *
   * A callback rather than a `recordEvent` on the port because the
   * pre-flight endpoint must write nothing: the wizard polls it, and a
   * campaign whose timeline fills with "content warnings" every time
   * somebody opens step 7 has a useless timeline.
   */
  onContentScanned?: (scan: {
    findings: readonly LintFinding[];
    reputationUnavailable: boolean;
  }) => Promise<void>;
}

export async function runLaunchPreflight(
  campaign: LaunchableCampaign,
  port: PreflightPort,
  options: PreflightOptions,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  // An array rather than a `let`, so the first failure survives being
  // written from inside the closure below without the reader — or the type
  // checker — having to reason about when it was assigned.
  const failures: { failure: LaunchFailure; message: string }[] = [];
  const first = (): { failure: LaunchFailure; message: string } | null => failures[0] ?? null;

  /** Records a row and, for a failure, the first one. Returns "stop now?". */
  const add = (check: PreflightCheck): boolean => {
    checks.push(check);

    if (check.outcome === 'fail' && check.failure !== null) {
      failures.push({ failure: check.failure, message: check.detail });
    }

    return options.stopAtFirstFailure && check.outcome === 'fail';
  };

  const pass = (key: PreflightKey, title: string, detail: string): PreflightCheck => ({
    key,
    outcome: 'pass',
    title,
    detail,
    failure: null,
  });

  const fail = (
    key: PreflightKey,
    title: string,
    failure: LaunchFailure,
    detail: string,
  ): PreflightCheck => ({ key, outcome: 'fail', title, detail, failure });

  /** A check that could not be evaluated, because one before it failed. */
  const skipped = (key: PreflightKey, title: string, detail: string): PreflightCheck => ({
    key,
    outcome: 'warn',
    title,
    detail,
    failure: null,
  });

  // 1. Template.
  const hasTemplate = campaign.templateVersionId !== null;

  if (
    add(
      hasTemplate
        ? pass('template', 'Template chosen', 'A published version is pinned at launch')
        : fail('template', 'Template chosen', 'no_template', 'This campaign has no template'),
    )
  ) {
    return { checks, failure: first(), entitlement: null };
  }

  // 2. A sender, or a pool.
  const hasSender = campaign.senderAccountId !== null || campaign.sendingPoolId !== null;

  if (
    add(
      hasSender
        ? pass(
            'sender',
            'Sender verified',
            campaign.senderAccountId === null
              ? 'Sending from a pool; every member is checked as it is used'
              : 'The sender identity is still verified with the provider',
          )
        : fail(
            'sender',
            'Sender verified',
            'no_sender',
            'This campaign has no sender or sending pool',
          ),
    )
  ) {
    return { checks, failure: first(), entitlement: null };
  }

  // The identity check, only when a single sender was chosen. Launch does
  // not check pool members here either — routing picks one at send time and
  // checks it then.
  if (campaign.senderAccountId !== null && !(await port.senderIsUsable(campaign.senderAccountId))) {
    if (
      add(
        fail(
          'sender',
          'Sender verified',
          'unverified_sender',
          'This campaign’s sender is not usable — its identity may no longer be verified',
        ),
      )
    ) {
      return { checks, failure: first(), entitlement: null };
    }
  }

  // 3. The account itself. docs/06: "Email verification before any send."
  if (
    add(
      (await port.ownerEmailIsVerified(campaign.workspaceId))
        ? pass('account', 'Workspace verified', 'The workspace owner’s email address is verified')
        : fail(
            'account',
            'Workspace verified',
            'unverified_account',
            'Verify the workspace owner’s email address before sending',
          ),
    )
  ) {
    return { checks, failure: first(), entitlement: null };
  }

  // 4. Pool routing, for a workspace still in its ramp.
  const poolRefused =
    campaign.sendingPoolId !== null && (await port.workspaceIsInRamp(campaign.workspaceId));

  if (
    add(
      poolRefused
        ? fail(
            'pool_routing',
            'Pool routing available',
            'pool_routing_unavailable',
            'New workspaces send from a single verified sender for their first 7 days. Choose a sender, or contact support to lift the limit.',
          )
        : pass(
            'pool_routing',
            'Pool routing available',
            campaign.sendingPoolId === null
              ? 'Sending from a single sender'
              : 'This workspace is past its new-account ramp',
          ),
    )
  ) {
    return { checks, failure: first(), entitlement: null };
  }

  // 5. The enforcement ladder (docs/06 "Response ladder").
  const stage = await port.readEnforcementStage(campaign.workspaceId);

  if (!mayLaunch(stage)) {
    if (
      add(
        fail(
          'enforcement',
          'Account in good standing',
          'enforcement_paused',
          'Sending is paused for this workspace. Check the notice in your dashboard for what to do next.',
        ),
      )
    ) {
      return { checks, failure: first(), entitlement: null };
    }
  } else if (needsReview(stage) && !(await port.launchIsApproved(campaign.id))) {
    if (
      add(
        fail(
          'enforcement',
          'Account in good standing',
          'enforcement_review_required',
          'This workspace is under review. Campaigns need approval before they can be sent.',
        ),
      )
    ) {
      return { checks, failure: first(), entitlement: null };
    }
  } else {
    add(pass('enforcement', 'Account in good standing', 'No sending restrictions on this workspace'));
  }

  // 6. Content: the phishing lint and link reputation, docs/06.
  //
  //    Skipped when there is no template — there is nothing to render, and
  //    asking the scanner to do it anyway is how a pre-flight on an empty
  //    draft turns into a 500.
  if (!hasTemplate) {
    add(skipped('links', 'Link reputation', 'Checked once a template is chosen'));
    add(skipped('content', 'No phishing patterns detected', 'Checked once a template is chosen'));
  } else {
    const scan = await port.scanContent(campaign.id);

    // docs/06: "known-bad domains block the launch." Somebody else's verdict
    // about a domain, not a heuristic about wording, so it blocks on its own.
    if (
      add(
        scan.blockedDomains.length > 0
          ? fail(
              'links',
              'Link reputation',
              'blocked_link_domain',
              `This campaign links to ${scan.blockedDomains.join(', ')}, which a security feed has flagged. Remove the link or contact support.`,
            )
          : pass(
              'links',
              'Link reputation',
              scan.reputationUnavailable
                ? 'The reputation feed could not be reached; links were not checked'
                : 'No link domain is on a security feed’s block list',
            ),
      )
    ) {
      return { checks, failure: first(), entitlement: null };
    }

    if (
      add(
        scan.blocked
          ? fail(
              'content',
              'No phishing patterns detected',
              'content_blocked',
              'This campaign was held by our content checks. Review the warnings on this page, or contact support if you believe this is wrong.',
            )
          : scan.findings.length > 0
            ? {
                key: 'content',
                outcome: 'warn',
                title: 'No phishing patterns detected',
                detail: `${scan.findings.length} warning${scan.findings.length === 1 ? '' : 's'}: ${scan.findings.map((finding) => finding.code).join(', ')}`,
                failure: null,
              }
            : pass(
                'content',
                'No phishing patterns detected',
                'No look-alike domains, hidden text or credential prompts',
              ),
      )
    ) {
      return { checks, failure: first(), entitlement: null };
    }

    // The same point in the sequence `launchCampaign` used to write its
    // warning events: after both content refusals, before consent. Findings
    // that did not block are recorded rather than discarded — an honest
    // sender fixes a mismatched link; a dishonest one leaves a trail — and
    // a feed that failed open has to be visible afterwards, or "was this
    // campaign checked" has no answer.
    await options.onContentScanned?.({
      findings: scan.findings,
      reputationUnavailable: scan.reputationUnavailable,
    });
  }

  // 7. Consent. docs/06: "every launch re-confirms it."
  const attestation = await port.readConsentAttestation(campaign.id);
  const verdict = attestationAuthorises(attestation, campaign.audience);

  if (
    add(
      verdict.ok
        ? pass('consent', 'Consent confirmed', 'This audience’s consent was attested for this send')
        : verdict.reason === 'audience_changed'
          ? fail(
              'consent',
              'Consent confirmed',
              'consent_audience_changed',
              'The audience changed after consent was confirmed. Review the recipients and confirm again.',
            )
          : fail(
              'consent',
              'Consent confirmed',
              'consent_not_attested',
              'Confirm where this audience gave consent before sending',
            ),
    )
  ) {
    return { checks, failure: first(), entitlement: null };
  }

  // 8. The entitlement row, FOR SHARE (R28). Read before the snapshot and
  //    held until the transaction ends, so a downgrade cannot commit in the
  //    gap. The *limit* is applied against the snapshot, in launch.
  const entitlement = await port.readEntitlementForShare(campaign.workspaceId);

  if (
    add(
      entitlement === null
        ? fail(
            'entitlement',
            'Plan allows sending',
            'no_entitlement',
            'This workspace has no active subscription. Choose a plan to start sending.',
          )
        : pass(
            'entitlement',
            'Plan allows sending',
            entitlement.monthlySendLimit === null
              ? 'This plan has no monthly send limit'
              : `${Math.max(entitlement.monthlySendLimit - entitlement.used, 0).toLocaleString()} of ${entitlement.monthlySendLimit.toLocaleString()} sends remain this month`,
          ),
    )
  ) {
    return { checks, failure: first(), entitlement: null };
  }

  return { checks, failure: first(), entitlement };
}

/**
 * Launches a campaign.
 *
 * The caller opens the transaction. Everything from the claim to
 * `markQueueing` must be in it: a snapshot that commits without the state
 * change would leave a campaign in `validating` with a full recipient table
 * and no dispatcher.
 */
export async function launchCampaign(
  campaignId: string,
  port: LaunchPort,
): Promise<LaunchResult> {
  // 1. Claim. First, before anything is read, so two concurrent launches
  //    cannot both pass validation and both snapshot.
  if (!(await port.claimForLaunch(campaignId))) {
    return {
      ok: false,
      failure: 'not_launchable',
      message: 'This campaign is not in a state that can be launched',
    };
  }

  const campaign = await port.readCampaign(campaignId);
  if (campaign === null) {
    return { ok: false, failure: 'not_launchable', message: 'Campaign not found' };
  }

  // 2. Pre-flight. Each failure releases the claim, so the draft stays
  //    editable rather than stranded in `validating`.
  const fail = async (failure: LaunchFailure, message: string): Promise<LaunchResult> => {
    await port.releaseClaim({ campaignId, reason: failure });
    await port.recordEvent({ campaignId, eventType: 'launch.rejected', detail: { failure } });
    return { ok: false, failure, message };
  };

  // The same function `POST /campaigns/:id/preflight` calls, in the same
  // order, with the same messages. `stopAtFirstFailure` reproduces the
  // control flow this block used to spell out inline — in particular, the
  // content scan is still not paid for when a cheaper check has already
  // refused the launch.
  const preflight = await runLaunchPreflight(campaign, port, {
    stopAtFirstFailure: true,
    // At the exact point this used to sit: after both content refusals,
    // before consent.
    onContentScanned: async ({ findings, reputationUnavailable }) => {
      // Findings that did not block are recorded rather than discarded. An
      // honest sender fixes a mismatched link; a dishonest one has a trail.
      if (findings.length > 0) {
        await port.recordEvent({
          campaignId,
          eventType: 'launch.content_warnings',
          detail: { codes: findings.map((finding) => finding.code) },
        });
      }

      if (reputationUnavailable) {
        // The feed failed open (see link-reputation.ts). That decision has
        // to be visible afterwards, or "was this campaign checked" has no
        // answer.
        await port.recordEvent({
          campaignId,
          eventType: 'launch.reputation_unavailable',
          detail: {},
        });
      }
    },
  });

  if (preflight.failure !== null) {
    return fail(preflight.failure.failure, preflight.failure.message);
  }

  // Not reachable: a pre-flight with no failure has read the entitlement and
  // the template. Narrowed rather than asserted, because a `!` here would be
  // the one place a future edit to the check order could launch a campaign
  // over a plan limit without the compiler noticing.
  const entitlement = preflight.entitlement;
  const templateVersionId = campaign.templateVersionId;

  if (entitlement === null || templateVersionId === null) {
    return fail(
      'no_entitlement',
      'This workspace has no active subscription. Choose a plan to start sending.',
    );
  }

  // 9. Snapshot. Deduplicated by the unique index, so running twice inserts
  //    nothing the second time.
  const snapshot = await port.snapshotAudience({
    campaignId,
    audience: campaign.audience,
  });

  if (snapshot.inserted === 0) {
    return fail(
      'empty_audience',
      snapshot.suppressedAtSnapshot > 0
        ? 'Every contact in this audience is suppressed'
        : 'This audience has no contacts',
    );
  }

  // 10. The limit, against the snapshot that was just taken — not against an
  //    estimate made before it.
  if (entitlement.monthlySendLimit !== null) {
    const remaining = entitlement.monthlySendLimit - entitlement.used;

    if (snapshot.inserted > remaining) {
      return fail(
        'entitlement_exceeded',
        `This campaign needs ${snapshot.inserted.toLocaleString()} sends and ${Math.max(remaining, 0).toLocaleString()} remain on your plan this month`,
      );
    }
  }

  await port.initialiseCounters({ campaignId, total: snapshot.inserted });

  await port.markQueueing({
    campaignId,
    recipientCount: snapshot.inserted,
    // Pinned. A later edit to the template cannot change what this campaign
    // sent.
    templateVersionId,
  });

  await port.recordEvent({
    campaignId,
    eventType: 'launch.queued',
    detail: {
      recipientCount: snapshot.inserted,
      suppressedAtSnapshot: snapshot.suppressedAtSnapshot,
      templateVersionId: campaign.templateVersionId,
    },
  });

  return {
    ok: true,
    recipientCount: snapshot.inserted,
    suppressedAtSnapshot: snapshot.suppressedAtSnapshot,
  };
}

/**
 * States a campaign may be launched from.
 *
 * Exported so the repository's guarded UPDATE and this module cannot disagree
 * about it — the guard is the invariant, and two copies of a list is how a
 * guard drifts.
 */
export const LAUNCHABLE_STATES = ['draft', 'scheduled'] as const;
