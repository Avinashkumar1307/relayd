/**
 * The dunning ladder (docs/05 "Failed payments and dunning").
 *
 * A card fails and the account does not stop existing. What follows is a
 * sequence of progressively narrower states, each with a reason:
 *
 *   `past_due` (day 0–14) — the provider is still retrying. Almost everything
 *   works; there is a banner and there are emails. Most failures are resolved
 *   here by the customer updating a card, and cutting them off at the first
 *   failed charge is how a payment blip becomes a churn event.
 *
 *   `restricted` (day 15–30) — retries are exhausted. No new launches, and
 *   scheduled campaigns are **held, not cancelled**. Contacts are readable and
 *   deletable but not addable.
 *
 *   `suspended` (day 31–90) — billing pages only. Everything is retained.
 *
 *   `export_window` (day 90+) — the data is offered back.
 *
 *   `deletable` (day 120+) — and only after three notices and an export
 *   window.
 *
 * ## Two rules that are never bent
 *
 * **A running campaign always completes.** Killing a send mid-flight because
 * a card expired is worse for everybody, us included: the emails are already
 * partly out and the recipient experience is broken in a way nobody can
 * explain.
 *
 * **Scheduled campaigns are held, not cancelled**, and resume automatically on
 * payment. Cancelling loses the schedule, the audience snapshot and the
 * customer's intent, and none of that comes back when they pay.
 *
 * ## No free tier
 *
 * docs/05's cancellation example says entitlements "rebuild from the free
 * plan". Under D7 there is no free plan, so they rebuild to nothing: the
 * workspace keeps its data, keeps reading it, and cannot send. See docs/16.
 */

/** Day the provider stops retrying and restriction begins. */
export const GRACE_DAYS = 14;
/** Day restriction becomes suspension. */
export const SUSPEND_DAY = 30;
/** Day the export is offered. */
export const EXPORT_DAY = 90;
/** Earliest day data may be deleted, and only after the notices below. */
export const DELETE_DAY = 120;
/** Notices that must have been sent before anything is deleted. */
export const REQUIRED_DELETION_NOTICES = 3;

export type DunningStage =
  | 'current'
  | 'past_due'
  | 'restricted'
  | 'suspended'
  | 'export_window'
  | 'deletable';

/**
 * Which stage a workspace is in.
 *
 * Driven by elapsed days since the first failed payment, not by the provider
 * status alone: Stripe moves a subscription to `unpaid` when retries are
 * exhausted, which is a different clock from ours and can arrive early or
 * late depending on the retry schedule configured in the dashboard.
 */
export function dunningStage(input: {
  status: string;
  firstFailedAt: Date | null;
  now: Date;
}): DunningStage {
  if (input.firstFailedAt === null) return 'current';

  // A payment succeeded after the failure. The clock is not merely paused —
  // it is gone, and a later failure starts a new one.
  if (input.status === 'active' || input.status === 'trialing') return 'current';

  const day = daysBetween(input.firstFailedAt, input.now);

  if (day >= DELETE_DAY) return 'deletable';
  if (day >= EXPORT_DAY) return 'export_window';
  if (day >= SUSPEND_DAY) return 'suspended';
  if (day >= GRACE_DAYS) return 'restricted';
  return 'past_due';
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  // A clock skew that puts `now` before the failure must not read as
  // "day -2" and skip straight past `past_due`.
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 86_400_000);
}

export interface Capabilities {
  login: boolean;
  /** Add or edit contacts. Reading and deleting are always allowed. */
  writeContacts: boolean;
  launchCampaign: boolean;
  /** What happens to a campaign whose scheduled time arrives. */
  scheduledCampaigns: 'run' | 'hold';
  /** A campaign already sending. Always completes. */
  runningCampaigns: 'complete';
  apiWrites: boolean;
  apiSend: boolean;
  outboundWebhooks: boolean;
  analyticsWrites: boolean;
  exportOffered: boolean;
}

const CAPABILITIES: Readonly<Record<DunningStage, Capabilities>> = {
  current: {
    login: true,
    writeContacts: true,
    launchCampaign: true,
    scheduledCampaigns: 'run',
    runningCampaigns: 'complete',
    apiWrites: true,
    apiSend: true,
    outboundWebhooks: true,
    analyticsWrites: true,
    exportOffered: false,
  },
  past_due: {
    // Day 0–14: a banner and emails, and otherwise a working product.
    login: true,
    writeContacts: true,
    launchCampaign: true,
    scheduledCampaigns: 'run',
    runningCampaigns: 'complete',
    apiWrites: true,
    apiSend: true,
    outboundWebhooks: true,
    analyticsWrites: true,
    exportOffered: false,
  },
  restricted: {
    // Day 15–30: nothing new goes out. Everything already out finishes.
    login: true,
    writeContacts: false,
    launchCampaign: false,
    scheduledCampaigns: 'hold',
    runningCampaigns: 'complete',
    apiWrites: true,
    apiSend: false,
    outboundWebhooks: true,
    analyticsWrites: true,
    exportOffered: false,
  },
  suspended: {
    // Day 31–90: billing pages only. Nothing is deleted, nothing is used.
    login: true,
    writeContacts: false,
    launchCampaign: false,
    scheduledCampaigns: 'hold',
    runningCampaigns: 'complete',
    apiWrites: false,
    apiSend: false,
    outboundWebhooks: false,
    analyticsWrites: false,
    exportOffered: false,
  },
  export_window: {
    login: true,
    writeContacts: false,
    launchCampaign: false,
    scheduledCampaigns: 'hold',
    runningCampaigns: 'complete',
    apiWrites: false,
    apiSend: false,
    outboundWebhooks: false,
    analyticsWrites: false,
    exportOffered: true,
  },
  deletable: {
    login: true,
    writeContacts: false,
    launchCampaign: false,
    scheduledCampaigns: 'hold',
    runningCampaigns: 'complete',
    apiWrites: false,
    apiSend: false,
    outboundWebhooks: false,
    analyticsWrites: false,
    exportOffered: true,
  },
};

export function capabilitiesFor(stage: DunningStage): Capabilities {
  return CAPABILITIES[stage];
}

/**
 * Days after the first failure on which a notice is sent.
 *
 * Day 13 is the final warning before restriction and day 85 the final warning
 * before deletion becomes possible; both exist so nothing narrows without the
 * customer having been told it was about to.
 */
export const NOTICE_DAYS: readonly number[] = [0, 3, 7, 13, 14, 30, 60, 85];

/**
 * Notices that are due and have not been sent.
 *
 * Returns everything missed, not just today's. A worker that did not run for
 * three days must not silently skip the day-13 final warning and restrict on
 * day 14 with no warning at all.
 */
export function dueNotices(input: {
  day: number;
  sentDays: readonly number[];
}): number[] {
  const sent = new Set(input.sentDays);
  return NOTICE_DAYS.filter((noticeDay) => noticeDay <= input.day && !sent.has(noticeDay));
}

/**
 * Whether the data may be deleted.
 *
 * Three conditions, all of them: the stage, the notice count, and an export
 * window that has actually opened. Any one of them alone has deleted a paying
 * customer's data somewhere.
 */
export function mayDelete(input: {
  stage: DunningStage;
  noticesSent: number;
  exportOfferedAt: Date | null;
}): boolean {
  if (input.stage !== 'deletable') return false;
  if (input.noticesSent < REQUIRED_DELETION_NOTICES) return false;
  return input.exportOfferedAt !== null;
}

export interface DunningPort {
  /**
   * Workspaces the ladder still has something to say about.
   *
   * A live failure clock **or** a stage other than `current`. The second half
   * is what makes recovery observable: a payment that succeeds clears the
   * clock, and a query that only looked at the clock would drop the workspace
   * out of the job on exactly the tick that was supposed to release its held
   * campaigns.
   */
  workspacesInDunning(now: Date): Promise<
    {
      workspaceId: string;
      subscriptionId: string;
      status: string;
      /** Null once a payment has cleared it; the stage is then what matters. */
      firstFailedAt: Date | null;
      stage: DunningStage;
      noticesSentDays: number[];
    }[]
  >;

  /** Records the new stage. Idempotent — writing the same stage is a no-op. */
  setStage(input: {
    workspaceId: string;
    subscriptionId: string;
    stage: DunningStage;
  }): Promise<boolean>;

  /** Holds every scheduled campaign. Never cancels one. */
  holdScheduledCampaigns(workspaceId: string): Promise<number>;

  /** Releases held campaigns when payment resolves. */
  releaseHeldCampaigns(workspaceId: string): Promise<number>;

  sendNotice(input: { workspaceId: string; day: number; stage: DunningStage }): Promise<void>;

  recordEvent(input: { workspaceId: string; eventType: string; detail: unknown }): Promise<void>;
}

export interface DunningOutcome {
  workspaceId: string;
  stage: DunningStage;
  stageChanged: boolean;
  noticesSent: number[];
  campaignsHeld: number;
  campaignsReleased: number;
}

/**
 * Advances one workspace along the ladder.
 *
 * Ordered so that nothing narrows before the notice that warns about it is
 * out: notices first, then the stage, then the effect on campaigns.
 */
export async function advanceDunning(
  workspace: {
    workspaceId: string;
    subscriptionId: string;
    status: string;
    firstFailedAt: Date | null;
    stage: DunningStage;
    noticesSentDays: number[];
  },
  now: Date,
  port: DunningPort,
): Promise<DunningOutcome> {
  const stage = dunningStage({
    status: workspace.status,
    firstFailedAt: workspace.firstFailedAt,
    now,
  });

  const outcome: DunningOutcome = {
    workspaceId: workspace.workspaceId,
    stage,
    stageChanged: false,
    noticesSent: [],
    campaignsHeld: 0,
    campaignsReleased: 0,
  };

  if (stage === 'current') {
    // Paid. Held campaigns resume automatically — that is the whole reason
    // they were held rather than cancelled.
    outcome.campaignsReleased = await port.releaseHeldCampaigns(workspace.workspaceId);

    if (workspace.stage !== 'current') {
      outcome.stageChanged = await port.setStage({
        workspaceId: workspace.workspaceId,
        subscriptionId: workspace.subscriptionId,
        stage: 'current',
      });

      await port.recordEvent({
        workspaceId: workspace.workspaceId,
        eventType: 'dunning.resolved',
        detail: { released: outcome.campaignsReleased },
      });
    }

    return outcome;
  }

  const failedAt = workspace.firstFailedAt;

  // Unreachable: `dunningStage` answers `current` for a null clock, and that
  // branch returned above. Narrowed rather than defaulted, because a default
  // here would be a made-up day number nobody could trace back to anything.
  if (failedAt === null) return outcome;

  const day = daysBetween(failedAt, now);

  for (const noticeDay of dueNotices({ day, sentDays: workspace.noticesSentDays })) {
    await port.sendNotice({ workspaceId: workspace.workspaceId, day: noticeDay, stage });
    outcome.noticesSent.push(noticeDay);
  }

  if (stage !== workspace.stage) {
    outcome.stageChanged = await port.setStage({
      workspaceId: workspace.workspaceId,
      subscriptionId: workspace.subscriptionId,
      stage,
    });

    await port.recordEvent({
      workspaceId: workspace.workspaceId,
      eventType: 'dunning.stage_changed',
      detail: { from: workspace.stage, to: stage, day },
    });
  }

  if (capabilitiesFor(stage).scheduledCampaigns === 'hold') {
    // Idempotent: a campaign already held is not held again, and the count
    // reflects what actually moved.
    outcome.campaignsHeld = await port.holdScheduledCampaigns(workspace.workspaceId);
  }

  return outcome;
}
