import {
  LAUNCHABLE_STATES,
  applyLifecycleAction,
  launchCampaign,
  retryFailedRecipients,
  type LaunchPort,
  type LifecycleAction,
  type LifecyclePort,
  type RetryFailedPort,
} from '@relayd/campaigns';
import type { AuditLogRepository, CampaignRepository, WorkspaceScope } from '@relayd/db';
import { AppError } from '@relayd/types';
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
  unresolvable_merge_tags: 422,
};

export class CampaignService {
  constructor(private readonly options: CampaignServiceOptions) {}

  async list(
    scope: WorkspaceScope,
    query: { state?: string | undefined; search?: string | undefined; limit: number; cursor?: string | undefined },
  ) {
    return this.options.unitOfWork((repos) => repos.campaigns.list(scope, query));
  }

  async get(scope: WorkspaceScope, id: CampaignId) {
    return this.options.unitOfWork(async (repos) => {
      const campaign = await repos.campaigns.findById(scope, id);
      if (campaign === null) throw new AppError('not_found', 'Campaign not found', 404);

      // Counters, never a count. See R13.
      const counters = await repos.campaigns.readCounters(scope, id);
      return { campaign, counters };
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

      const outstanding = counters.pending + counters.queued + counters.sending;

      return {
        ...counters,
        outstanding,
        complete: outstanding === 0,
        // Shown as its own number, not folded into failures. D3 makes these
        // terminal and unbilled, and a customer looking at a report needs to
        // know the difference between "we could not send" and "we do not
        // know whether we sent".
        deliveryUncertain: counters.uncertain,
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
  async launch(scope: WorkspaceScope, id: CampaignId, options: { idempotencyKey?: string } = {}) {
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
