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

  if (campaign.templateVersionId === null) {
    return fail('no_template', 'This campaign has no template');
  }

  if (campaign.senderAccountId === null && campaign.sendingPoolId === null) {
    return fail('no_sender', 'This campaign has no sender or sending pool');
  }

  if (campaign.senderAccountId !== null && !(await port.senderIsUsable(campaign.senderAccountId))) {
    return fail(
      'unverified_sender',
      'This campaign’s sender is not usable — its identity may no longer be verified',
    );
  }

  // 3. The account itself. docs/06: "Email verification before any send."
  //
  // After the sender check and before the entitlement read, because an
  // unverified account is a cheaper refusal than a row lock and because the
  // sender message is the more useful one when both are wrong.
  if (!(await port.ownerEmailIsVerified(campaign.workspaceId))) {
    return fail(
      'unverified_account',
      'Verify the workspace owner’s email address before sending',
    );
  }

  // 4. Pool routing, for a workspace still in its ramp.
  //
  //    docs/06 excludes new accounts from pool routing. A pool spreads a
  //    campaign across several provider connections, which is exactly how a
  //    spammer spreads reputation damage and outruns a per-connection rate
  //    limit — and a workspace days old is the one whose reputation nobody
  //    knows yet.
  //
  //    Refused rather than silently downgraded to a single sender. Quietly
  //    sending from somewhere other than where the customer chose is worse
  //    than saying no: it works, so nobody asks why, and the first they hear
  //    of it is a report attributing sends to the wrong identity.
  if (campaign.sendingPoolId !== null && (await port.workspaceIsInRamp(campaign.workspaceId))) {
    return fail(
      'pool_routing_unavailable',
      'New workspaces send from a single verified sender for their first 7 days. Choose a sender, or contact support to lift the limit.',
    );
  }

  // 5. The entitlement row, FOR SHARE (R28). Read before the snapshot, held
  //    until this transaction ends, so a downgrade cannot commit in the gap.
  const entitlement = await port.readEntitlementForShare(campaign.workspaceId);

  if (entitlement === null) {
    // No rows means no active subscription. Refused before the snapshot,
    // because there is nothing to learn from taking one.
    return fail(
      'no_entitlement',
      'This workspace has no active subscription. Choose a plan to start sending.',
    );
  }

  // 6. Snapshot. Deduplicated by the unique index, so running twice inserts
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

  // 7. The limit, against the snapshot that was just taken — not against an
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
    templateVersionId: campaign.templateVersionId,
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
