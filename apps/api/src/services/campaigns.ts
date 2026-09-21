import {
  LAUNCHABLE_STATES,
  applyLifecycleAction,
  launchCampaign,
  retryFailedRecipients,
  runLaunchPreflight,
  type LaunchPort,
  type LifecycleAction,
  type LifecyclePort,
  type RetryFailedPort,
} from '@relayd/campaigns';
import type {
  AuditLogRepository,
  CampaignCountersRow,
  CampaignEventRow,
  CampaignRepository,
  ConsentRepository,
  WorkspaceScope,
} from '@relayd/db';
import { AppError } from '@relayd/types';
import { audienceFingerprint, validateAttestationInput } from '@relayd/campaigns';
import type { CampaignId } from '@relayd/types';
import { buildAuditEntry, type Actor } from './audit.js';

/**
 * Campaigns.
 *
 * This layer is thin on purpose. Every decision that matters — the guarded
 * claim, the entitlement lock, the snapshot, the lattice — lives in
 * `packages/campaigns` and is tested there against ports. What is left here
 * is the part that is genuinely an API concern: which errors map to which
 * status, what an idempotent launch returns to the loser, and making sure a
 * request path never asks a question that requires counting recipients.
 *
 * The one rule worth stating: nothing in this file may call a repository
 * method that aggregates over `campaign_recipients` (R13). `progress` reads
 * `campaign_counters`, and the service exposes no method that would do
 * otherwise, so a future controller cannot reach for one.
 */

export interface CampaignRepositories {
  campaigns: CampaignRepository;
  auditLogs: AuditLogRepository;
  consent: ConsentRepository;
}

export type CampaignUnitOfWork = <T>(
  fn: (repos: CampaignRepositories) => Promise<T>,
) => Promise<T>;

export interface CampaignServiceOptions {
  unitOfWork: CampaignUnitOfWork;
  newId: () => string;
  currentActor: () => Actor;

  /** Builds the engine ports for one transaction. Supplied by the composition root. */
  ports: {
    launch(repos: CampaignRepositories, scope: WorkspaceScope): LaunchPort;
    lifecycle(repos: CampaignRepositories, scope: WorkspaceScope): LifecyclePort;
    retry(repos: CampaignRepositories, scope: WorkspaceScope): RetryFailedPort;
  };

  /** ERROR_POLICY, passed in rather than imported — see docs/16. */
  errorPolicy: Readonly<Record<string, { retryable: boolean }>>;

  /** Enqueues the dispatch job after a successful launch. */
  enqueueDispatch(input: { workspaceId: string; campaignId: CampaignId }): Promise<void>;

  /**
   * The clock, for rendering timeline timestamps as "11:02" or "18 Sep,
   * 16:20". Injected so the test for that rule is not a test of what day it
   * happens to be. Defaults to the real one.
   */
  now?: () => Date;
}

export const AUDIT_ACTIONS_CAMPAIGNS = {
  created: 'campaign.created',
  updated: 'campaign.updated',
  deleted: 'campaign.deleted',
  scheduled: 'campaign.scheduled',
  launched: 'campaign.launched',
  paused: 'campaign.paused',
  resumed: 'campaign.resumed',
  cancelled: 'campaign.cancelled',
  retried: 'campaign.retry_failed',
  cloned: 'campaign.cloned',
  archived: 'campaign.archived',
  unarchived: 'campaign.unarchived',
} as const;

/**
 * How a launch failure reads over HTTP.
 *
 * 409 for "not in a state you can launch from", 422 for everything the author
 * has to go and fix. The distinction matters to the UI: a 409 means try again
 * or look at what someone else did, and a 422 means the review step should
 * have caught this and will now show you where.
 */
const LAUNCH_FAILURE_STATUS: Readonly<Record<string, number>> = {
  not_launchable: 409,
  no_template: 422,
  no_sender: 422,
  empty_audience: 422,
  entitlement_exceeded: 402,
  no_entitlement: 402,
  unverified_sender: 422,
  // 403, not 422. Both are things the customer must change, but a 422 says
  // "this request was malformed" and these two are "you are not allowed to
  // do this yet" — an anti-abuse refusal, not a validation error. A support
  // agent reading a 422 goes looking for a bug in the request.
  unverified_account: 403,
  pool_routing_unavailable: 403,
  // 422, unlike the two above. These are not "you are not allowed yet" —
  // they are "this request is missing something the sender can supply right
  // now", which is what 422 means and what the launch dialog acts on.
  consent_not_attested: 422,
  consent_stale: 422,
  consent_audience_changed: 422,
  // 403: the workspace is not allowed to send right now. Not 422 — there is
  // nothing wrong with the request, and telling somebody their campaign is
  // malformed when their account is paused sends them looking in the wrong
  // place entirely.
  enforcement_paused: 403,
  enforcement_review_required: 403,
  // 422: something in the campaign itself has to change, and the sender can
  // change it right now. Unlike the enforcement refusals above, this is not
  // about the account.
  content_blocked: 422,
  blocked_link_domain: 422,
  unresolvable_merge_tags: 422,
};

export class CampaignService {
  constructor(private readonly options: CampaignServiceOptions) {}

  async list(
    scope: WorkspaceScope,
    query: {
      state?: string | undefined;
      search?: string | undefined;
      archived?: 'active' | 'archived' | 'all' | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    return this.options.unitOfWork((repos) => repos.campaigns.list(scope, query));
  }

  async get(scope: WorkspaceScope, id: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const campaign = await repos.campaigns.findById(scope, id);
      if (campaign === null) throw new AppError('not_found', 'Campaign not found', 404);

      // Counters, never a count. See R13.
      //
      // Derived through the same function `progress` uses, because the
      // browser types both as one `CampaignProgress` and reads whichever
      // arrived first: `progress.data ?? campaign.counters`. Returning the
      // bare counters row here meant that on the detail page's first paint
      // — before the poll has answered — `outstanding`, `complete` and
      // `deliveryUncertain` were all missing, and the uncertain tile read
      // zero on a campaign that had some.
      const counters = await repos.campaigns.readCounters(scope, id);
      return { campaign, counters: counters === null ? null : toProgress(counters) };
    });
  }

  /**
   * Progress for the polling UI.
   *
   * A single-row read. `completed` is derived here rather than stored, so it
   * cannot disagree with the numbers beside it.
   */
  async progress(scope: WorkspaceScope, id: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const counters = await repos.campaigns.readCounters(scope, id);
      if (counters === null) throw new AppError('not_found', 'Campaign not found', 404);

      return toProgress(counters);
    });
  }

  /**
   * G3's "Event timeline".
   *
   * Reads `campaign_events` and nothing else. Every number a row quotes was
   * written into the event's `detail` at the moment it was true, which is
   * both why the timeline is cheap and why it still reads correctly when the
   * page is reopened a week later — recomputing "31,618 of 48,213 handed to
   * providers" from today's counters would print a different sentence every
   * time.
   */
  async timeline(scope: WorkspaceScope, id: CampaignId): Promise<TimelineEvent[]> {
    return this.options.unitOfWork(async (repos) => {
      // Checked first, so a campaign in another workspace is a 404 and not
      // an empty list. An empty list would be a slow oracle: it tells the
      // caller the id exists, just quietly.
      const campaign = await repos.campaigns.findById(scope, id);
      if (campaign === null) throw new AppError('not_found', 'Campaign not found', 404);

      const rows = await repos.campaigns.listEvents(scope, id);
      const zone = campaign.timezone ?? 'UTC';
      const now = this.options.now?.() ?? new Date();

      return rows.map((row) => describeCampaignEvent(row, { zone, now }));
    });
  }

  /**
   * Files a terminal campaign away (G1's Archive action).
   *
   * `campaign:write`, not `campaign:launch`: archiving a finished campaign
   * changes nothing about sending. The repository's guard is what stops a
   * live one being hidden.
   */
  async archive(scope: WorkspaceScope, id: CampaignId) {
    return this.setArchived(scope, id, true);
  }

  async unarchive(scope: WorkspaceScope, id: CampaignId) {
    return this.setArchived(scope, id, false);
  }

  private async setArchived(scope: WorkspaceScope, id: CampaignId, archived: boolean) {
    return this.options.unitOfWork(async (repos) => {
      const updated = archived
        ? await repos.campaigns.archive(scope, id)
        : await repos.campaigns.unarchive(scope, id);

      if (updated === null) {
        // Zero rows is three different things — no such campaign, already in
        // that state, or still running — and the customer has to do
        // something different for each.
        const existing = await repos.campaigns.findById(scope, id);
        if (existing === null) throw new AppError('not_found', 'Campaign not found', 404);

        if (archived && existing.archivedAt === null) {
          throw new AppError(
            'conflict',
            'Only a campaign that has finished can be archived',
            409,
          );
        }

        throw new AppError(
          'conflict',
          archived ? 'That campaign is already archived' : 'That campaign is not archived',
          409,
        );
      }

      await this.audit(repos, scope, {
        action: archived
          ? AUDIT_ACTIONS_CAMPAIGNS.archived
          : AUDIT_ACTIONS_CAMPAIGNS.unarchived,
        resourceId: id,
        after: { archived },
      });

      return updated;
    });
  }

  /**
   * G2 step 7's pre-flight: the launch checks, without launching.
   *
   * Runs `runLaunchPreflight` — the same function, in the same order, with
   * the same messages the launch would produce — against the same port. It
   * takes no claim, writes no event and takes no snapshot, so it can be
   * polled while the author edits.
   *
   * Two checks are deliberately absent, and their absence is the honest
   * part: `empty_audience` and `entitlement_exceeded` are decided against
   * the rows the snapshot actually wrote, and there is no snapshot here.
   * The wizard already shows an audience count from
   * `POST /campaigns/audience-preview`, which counts with the snapshot's own
   * predicates; guessing at those two here would be the disagreement this
   * endpoint exists to avoid.
   */
  async preflight(scope: WorkspaceScope, id: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const port = this.options.ports.launch(repos, scope);

      const campaign = await port.readCampaign(id);
      if (campaign === null) throw new AppError('not_found', 'Campaign not found', 404);

      const result = await runLaunchPreflight(campaign, port, { stopAtFirstFailure: false });

      return {
        ok: result.failure === null,
        // The launch failure code this campaign would be refused with, so a
        // caller can map the summary to the same remedy the launch error
        // would have named.
        failure: result.failure?.failure ?? null,
        checks: result.checks,
      };
    });
  }

  async listRecipients(
    scope: WorkspaceScope,
    id: CampaignId,
    query: {
      state?: string | undefined;
      deliveryState?: string | undefined;
      search?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    return this.options.unitOfWork((repos) => repos.campaigns.listRecipients(scope, id, query));
  }

  async create(
    scope: WorkspaceScope,
    input: {
      name: string;
      subject?: string;
      preheader?: string;
      fromName?: string;
      fromEmail?: string;
      replyTo?: string;
      templateId?: string;
      senderAccountId?: string;
      sendingPoolId?: string;
      audience?: unknown;
    },
  ) {
    return this.options.unitOfWork(async (repos) => {
      const id = this.options.newId() as CampaignId;
      const createdBy = this.actorUserId();

      const campaign = await repos.campaigns.create(scope, {
        id,
        name: input.name,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
        ...(input.senderAccountId === undefined
          ? {}
          : { senderAccountId: input.senderAccountId }),
        ...(input.sendingPoolId === undefined ? {} : { sendingPoolId: input.sendingPoolId }),
        ...(input.audience === undefined ? {} : { audience: input.audience }),
        ...(createdBy === undefined ? {} : { createdBy: createdBy as never }),
      });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_CAMPAIGNS.created,
        resourceId: id,
        after: { name: input.name },
      });

      return campaign;
    });
  }

  async update(scope: WorkspaceScope, id: CampaignId, input: Record<string, unknown>) {
    return this.options.unitOfWork(async (repos) => {
      const before = await repos.campaigns.findById(scope, id);
      if (before === null) throw new AppError('not_found', 'Campaign not found', 404);

      // A campaign that has left `draft` has a snapshot and a pinned template
      // behind it. Editing the subject at that point changes what the report
      // says was sent, not what was sent.
      if (!(LAUNCHABLE_STATES as readonly string[]).includes(before.status)) {
        throw new AppError(
          'conflict',
          'This campaign has already been launched and can no longer be edited',
          409,
        );
      }

      const campaign = await repos.campaigns.update(scope, id, input);

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_CAMPAIGNS.updated,
        resourceId: id,
        before,
        after: input,
      });

      return campaign;
    });
  }

  async remove(scope: WorkspaceScope, id: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const campaign = await repos.campaigns.findById(scope, id);
      if (campaign === null) throw new AppError('not_found', 'Campaign not found', 404);

      // Deleting a sent campaign would delete the record of what was sent to
      // whom, which is the one thing a customer may be legally required to
      // produce.
      if (!(LAUNCHABLE_STATES as readonly string[]).includes(campaign.status)) {
        throw new AppError(
          'conflict',
          'A campaign that has been launched cannot be deleted',
          409,
        );
      }

      await repos.campaigns.remove(scope, id);
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_CAMPAIGNS.deleted,
        resourceId: id,
        before: campaign,
      });
    });
  }

  async schedule(
    scope: WorkspaceScope,
    id: CampaignId,
    input: { scheduledAt: Date; timezone: string },
  ) {
    if (input.scheduledAt.getTime() <= Date.now()) {
      throw new AppError('validation_failed', 'A campaign cannot be scheduled in the past', 400);
    }

    return this.options.unitOfWork(async (repos) => {
      const campaign = await repos.campaigns.schedule(scope, id, input);
      if (campaign === null) {
        throw new AppError('conflict', 'This campaign cannot be scheduled in its current state', 409);
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_CAMPAIGNS.scheduled,
        resourceId: id,
        after: { scheduledAt: input.scheduledAt.toISOString(), timezone: input.timezone },
      });

      return campaign;
    });
  }

  /**
   * Launch (R28, R29).
   *
   * The Idempotency-Key is checked first and recorded last, both inside the
   * same transaction as the launch. A retried request that arrives while the
   * first is still running blocks on the row rather than racing it, and the
   * guarded claim in the engine is what makes the outcome correct even if the
   * key mechanism were absent entirely.
   */
  async launch(
    scope: WorkspaceScope,
    id: CampaignId,
    options: {
      idempotencyKey?: string;
      /**
       * The consent declaration this launch is made under (docs/06).
       *
       * Part of the launch request rather than a separate endpoint, and that
       * is what makes docs/06's "every launch re-confirms it" structural: a
       * launch without a deliberate assertion cannot be expressed. See the
       * note in `packages/campaigns/src/abuse/consent.ts` on why there is no
       * expiry instead.
       */
      consent?: { source: string; detail?: string | null; ip?: string | null };
    } = {},
  ) {
    return this.options.unitOfWork(async (repos) => {
      if (options.idempotencyKey !== undefined) {
        const claim = await repos.campaigns.claimLaunchKey(scope, {
          id,
          key: options.idempotencyKey,
        });

        if (claim === 'taken') {
          // Somebody already holds a key on this campaign. If it is the same
          // key, this is the same request arriving twice and it gets the
          // winner's answer rather than a 409 it cannot tell from a real
          // conflict. If it is a different key, it is a second launch of an
          // already-launched campaign and falls through to the engine, which
          // refuses it properly.
          const replayed = await repos.campaigns.findLaunchByKey(scope, {
            id,
            key: options.idempotencyKey,
          });

          if (replayed !== null) return replayed;
        }
      }

      // Recorded before the engine reads it, in the same transaction, so a
      // launch that then fails for an unrelated reason still leaves the
      // declaration on the record. An attestation that only survives a
      // successful launch would be missing from exactly the workspaces worth
      // investigating — the ones whose launches keep being refused.
      if (options.consent !== undefined) {
        const problem = validateAttestationInput(options.consent);

        if (problem !== null) {
          throw new AppError(
            'validation_failed',
            problem.reason === 'unknown_source'
              ? 'Choose where this audience gave consent'
              : 'Describe where this audience gave consent',
            422,
          );
        }

        // docs/06: "attributed to a user". An API key is not a somebody, and
        // an attestation it signed would name nobody in the dispute the
        // record exists for. This is also why `billing:write` is not
        // grantable to a key (CLAUDE.md section 11) — the same principle.
        const actor = this.options.currentActor();

        if (actor.type !== 'user' || actor.id === undefined) {
          throw new AppError(
            'insufficient_permission',
            'A consent declaration must be made by a signed-in user, not an API key',
            403,
          );
        }

        const campaign = await repos.campaigns.findById(scope, id);
        if (campaign === null) throw new AppError('not_found', 'Campaign not found', 404);

        await repos.consent.record(scope, {
          id: this.options.newId(),
          subjectKind: 'campaign',
          subjectId: id,
          source: options.consent.source,
          detail: options.consent.detail ?? null,
          audienceFingerprint: audienceFingerprint(campaign.audience),
          attestedBy: actor.id,
          attestedIp: options.consent.ip ?? null,
        });
      }

      const result = await launchCampaign(id, this.options.ports.launch(repos, scope));

      if (!result.ok) {
        const status = LAUNCH_FAILURE_STATUS[result.failure ?? ''] ?? 409;
        throw new AppError(
          status === 409 ? 'conflict' : 'validation_failed',
          result.message ?? 'This campaign could not be launched',
          status,
        );
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_CAMPAIGNS.launched,
        resourceId: id,
        after: { recipientCount: result.recipientCount },
      });

      // After the transaction would be better, but the unit of work owns the
      // boundary. The dispatch job is idempotent — it reads state from
      // Postgres — so an enqueue whose transaction then rolls back produces a
      // job that finds a draft campaign and exits.
      await this.options.enqueueDispatch({ workspaceId: scope.workspaceId, campaignId: id });

      return result;
    });
  }

  async lifecycle(scope: WorkspaceScope, id: CampaignId, action: LifecycleAction) {
    return this.options.unitOfWork(async (repos) => {
      const result = await applyLifecycleAction(id, action, this.options.ports.lifecycle(repos, scope));

      if (!result.ok) {
        throw new AppError('conflict', result.reason ?? 'This action is not available', 409);
      }

      await this.audit(repos, scope, {
        action: `campaign.${action}`,
        resourceId: id,
        after: { state: result.state },
      });

      return result;
    });
  }

  async retryFailed(scope: WorkspaceScope, id: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const result = await retryFailedRecipients(
        id,
        this.options.errorPolicy,
        this.options.ports.retry(repos, scope),
      );

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_CAMPAIGNS.retried,
        resourceId: id,
        after: { retried: result.retried },
      });

      if (result.reopened) {
        await this.options.enqueueDispatch({ workspaceId: scope.workspaceId, campaignId: id });
      }

      return result;
    });
  }

  async clone(scope: WorkspaceScope, id: CampaignId, name?: string) {
    return this.options.unitOfWork(async (repos) => {
      const source = await repos.campaigns.findById(scope, id);
      if (source === null) throw new AppError('not_found', 'Campaign not found', 404);

      const newCampaignId = this.options.newId() as CampaignId;

      // A clone is a draft. Copying the state would produce a second campaign
      // claiming to have sent what the first one sent.
      const campaign = await repos.campaigns.clone(scope, {
        sourceId: id,
        id: newCampaignId,
        name: name ?? `${source.name} (copy)`,
      });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_CAMPAIGNS.cloned,
        resourceId: newCampaignId,
        after: { clonedFrom: id },
      });

      return campaign;
    });
  }

  async testSend(scope: WorkspaceScope, id: CampaignId, to: readonly string[]) {
    return this.options.unitOfWork(async (repos) => {
      const campaign = await repos.campaigns.findById(scope, id);
      if (campaign === null) throw new AppError('not_found', 'Campaign not found', 404);

      // A test send is not a send: it creates no `campaign_recipients` row,
      // is never metered, and never appears in the campaign's counters.
      return repos.campaigns.enqueueTestSend(scope, { campaignId: id, to: [...to] });
    });
  }

  /**
   * The count the wizard's audience step shows.
   *
   * Over `contacts`, not over `campaign_recipients` — R13 forbids the latter
   * in a request path and says nothing about the former, which is the whole
   * point of a preview: telling the author how many people this will reach
   * before they commit to reaching them.
   */
  async previewAudience(scope: WorkspaceScope, input: { listIds: readonly string[] }) {
    return this.options.unitOfWork(async (repos) => {
      const counts = await repos.campaigns.previewAudienceCount(scope, input);

      return {
        ...counts,
        // Stated rather than left to the caller, so the wizard's number and
        // the launch report's number are computed in one place.
        total: counts.eligible + counts.suppressed,
      };
    });
  }

  private actorUserId(): string | undefined {
    const actor = this.options.currentActor();
    return actor.type === 'user' ? actor.id : undefined;
  }

  private async audit(
    repos: CampaignRepositories,
    scope: WorkspaceScope,
    entry: { action: string; resourceId: string; before?: unknown; after?: unknown },
  ): Promise<void> {
    await repos.auditLogs.append(
      scope,
      buildAuditEntry({
        id: this.options.newId(),
        actor: this.options.currentActor(),
        resourceType: 'campaign',
        ...entry,
      }),
    );
  }
}

/* --------------------------------------------------------------- progress -- */

/**
 * The counters row as every caller reads it — `apps/web`'s `CampaignProgress`.
 *
 * One shape for `GET /campaigns/:id/progress` and for the `counters` on
 * `GET /campaigns/:id`, because the browser assigns whichever arrived first
 * to one variable. Two shapes behind one type is how a tile that is correct
 * after the first poll is wrong on the first paint.
 */
export interface CampaignProgressView extends CampaignCountersRow {
  outstanding: number;
  complete: boolean;
  deliveryUncertain: number;
}

export function toProgress(counters: CampaignCountersRow): CampaignProgressView {
  const outstanding = counters.pending + counters.queued + counters.sending;

  return {
    ...counters,
    outstanding,
    complete: outstanding === 0,
    // Shown as its own number, not folded into failures. D3 makes these
    // terminal and unbilled, and a customer looking at a report needs to
    // know the difference between "we could not send" and "we do not know
    // whether we sent".
    deliveryUncertain: counters.uncertain,
  };
}

/* --------------------------------------------------------------- timeline -- */

/**
 * One row of G3's "Event timeline", as the client declares it.
 *
 * `time` is a rendered string because that is what the frame draws and what
 * `apps/web/src/api/campaigns.ts` types. Rendering it here rather than in
 * the browser is the only way it can be in the *campaign's* timezone: a
 * Dubai campaign read from a laptop in London says 09:00 on both, which is
 * the time the customer scheduled and the time their recipients saw.
 * `occurredAt` carries the instant alongside it for anything that needs to
 * sort, diff or re-render.
 */
export interface TimelineEvent {
  id: string;
  title: string;
  time: string;
  detail: string;
  tone: 'brand' | 'success' | 'warning' | 'danger' | 'neutral';
  occurredAt: string;
}

type Tone = TimelineEvent['tone'];

/**
 * How each `campaign_events.event_type` reads on the timeline.
 *
 * A table rather than a chain of ifs, so "what can the timeline say" is one
 * thing to read — and so an event type nobody thought about falls through to
 * the default below instead of disappearing. A timeline that silently drops
 * the entry explaining why a campaign stopped is worse than one that prints
 * a clumsy title.
 */
const EVENT_COPY: Readonly<Record<string, { title: string; tone: Tone }>> = {
  'launch.queued': { title: 'Queued', tone: 'neutral' },
  'launch.rejected': { title: 'Launch refused', tone: 'danger' },
  'launch.content_warnings': { title: 'Content warnings', tone: 'warning' },
  'launch.reputation_unavailable': { title: 'Link reputation unavailable', tone: 'warning' },
  'campaign.pause': { title: 'Paused', tone: 'warning' },
  'campaign.paused': { title: 'Paused automatically', tone: 'warning' },
  'campaign.resume': { title: 'Resumed', tone: 'brand' },
  'campaign.cancel': { title: 'Cancelled', tone: 'danger' },
  'campaign.completed': { title: 'Completed', tone: 'success' },
  'campaign.forced_transition': { title: 'Recovered automatically', tone: 'warning' },
  'campaign.retry_failed': { title: 'Failed recipients retried', tone: 'neutral' },
  'campaign.test_send': { title: 'Test message sent', tone: 'neutral' },
  'campaign.sent': { title: 'Sending finished', tone: 'success' },
  'dispatch.stalled': { title: 'Dispatch stalled', tone: 'warning' },
  'dispatch.ramp_capped': { title: 'New-account daily cap reached', tone: 'warning' },
  'dunning.notice': { title: 'Payment notice', tone: 'warning' },
  'dunning.stage_changed': { title: 'Billing status changed', tone: 'warning' },
  'dunning.resolved': { title: 'Payment resolved', tone: 'success' },
};

export function describeCampaignEvent(
  row: CampaignEventRow,
  context: { zone: string; now: Date },
): TimelineEvent {
  const copy = EVENT_COPY[row.eventType] ?? { title: humanise(row.eventType), tone: 'neutral' as Tone };

  return {
    id: row.id,
    title: copy.title,
    tone: copy.tone,
    time: formatEventTime(row.createdAt, context),
    detail: eventDetail(row),
    occurredAt: row.createdAt.toISOString(),
  };
}

/**
 * "11:02" today, "18 Sep, 16:20" before that — the two forms G3 draws.
 *
 * An unknown IANA zone throws inside `Intl`, and a campaign whose timezone
 * column holds something a migration once allowed must still render a
 * timeline. So the zone is tried once and UTC is the fallback.
 */
function formatEventTime(at: Date, context: { zone: string; now: Date }): string {
  const zone = usableZone(context.zone);

  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const on = datePartsOf(parts, at);
  const today = datePartsOf(parts, context.now);

  if (on.year === today.year && on.month === today.month && on.day === today.day) {
    return clock.format(at);
  }

  // "18 Sep", not "18 Sept": the month is sliced to three letters because
  // en-GB's own abbreviation for September is four, and which one ICU gives
  // is a property of the Node build rather than a decision anybody made.
  // The year is dropped deliberately — it is on `occurredAt` for anyone who
  // needs it, and a timeline reads as a sequence, not a set of dates.
  return `${on.day} ${on.month.slice(0, 3)}, ${clock.format(at)}`;
}

function datePartsOf(
  formatter: Intl.DateTimeFormat,
  at: Date,
): { year: string; month: string; day: string } {
  const parts = formatter.formatToParts(at);
  const find = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return { year: find('year'), month: find('month'), day: find('day') };
}

function usableZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/**
 * The sentence under the title.
 *
 * Built from the event's own `detail` blob and from the actor's name — never
 * from a live count. What the timeline says happened is what was true when
 * it happened.
 */
function eventDetail(row: CampaignEventRow): string {
  const detail = isRecord(row.detail) ? row.detail : {};
  const parts: string[] = [];

  const who = actorPhrase(row);
  if (who !== null) parts.push(who);

  switch (row.eventType) {
    case 'launch.queued': {
      const recipients = asCount(detail['recipientCount']);
      const suppressed = asCount(detail['suppressedAtSnapshot']);

      if (recipients !== null) {
        parts.push(
          suppressed !== null && suppressed > 0
            ? `${recipients.toLocaleString()} recipients · ${suppressed.toLocaleString()} suppressed removed`
            : `${recipients.toLocaleString()} recipients`,
        );
      }
      break;
    }

    case 'launch.rejected': {
      // The launch failure code, spelled out. It is the same refusal the
      // launch endpoint answered with, which is what makes "why was this
      // refused" answerable from the timeline alone.
      const failure = detail['failure'];
      if (typeof failure === 'string') parts.push(humanise(failure));
      break;
    }

    case 'launch.content_warnings': {
      const codes = detail['codes'];
      if (Array.isArray(codes) && codes.length > 0) parts.push(codes.join(', '));
      break;
    }

    case 'campaign.retry_failed': {
      const retried = asCount(detail['retried']);
      if (retried !== null) parts.push(`${retried.toLocaleString()} recipients requeued`);
      break;
    }

    case 'campaign.test_send': {
      const to = detail['to'];
      if (Array.isArray(to)) {
        parts.push(`${to.length} test recipient${to.length === 1 ? '' : 's'}`);
      }
      break;
    }

    case 'campaign.forced_transition': {
      const from = detail['from'];
      const to = detail['to'];
      if (typeof from === 'string' && typeof to === 'string') parts.push(`${from} to ${to}`);
      break;
    }

    default:
      break;
  }

  return parts.join(' · ');
}

/**
 * "Farah Al-Mansoori", "An API key", "The provider".
 *
 * Never an id: a timeline that prints a uuid in place of a name answers
 * "who" with "look it up yourself", and the join that resolves the name has
 * already been paid for.
 */
function actorPhrase(row: CampaignEventRow): string | null {
  switch (row.actorType) {
    case 'user':
      return row.actorName ?? 'A member of this workspace';
    case 'api_key':
      return 'An API key';
    case 'provider':
      return 'The provider';
    default:
      return null;
  }
}

/** `launch.content_warnings` becomes "Launch content warnings". */
function humanise(value: string): string {
  const words = value.replace(/[._]/gu, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
