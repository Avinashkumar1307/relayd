import type { AuditEntry, ActorType } from '@relayd/db';
import { getTraceContext } from '@relayd/logger';

/**
 * Who performed an action, for the audit trail.
 *
 * docs/02 models four actor types. A mutating action always has one: a user
 * through the dashboard, an API key, the system on a schedule, or a provider
 * via a webhook. "Unknown" is not an option — an audit row that cannot say who
 * did something is not an audit row.
 */
export interface Actor {
  type: ActorType;
  id?: string;
}

export interface AuditContext {
  ip?: string;
  userAgent?: string;
}

/**
 * Builds an audit entry, filling in what the request context already knows.
 *
 * requestId comes from the ambient trace context, which is what ties an audit
 * row back to the log lines and the HTTP response that produced it (docs/10).
 */
export function buildAuditEntry(input: {
  id: string;
  actor: Actor;
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  context?: AuditContext;
}): AuditEntry {
  const requestId = getTraceContext()?.requestId;

  return {
    id: input.id,
    actorType: input.actor.type,
    action: input.action,
    resourceType: input.resourceType,
    ...(input.actor.id === undefined ? {} : { actorId: input.actor.id }),
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(input.context?.ip === undefined ? {} : { ip: input.context.ip }),
    ...(input.context?.userAgent === undefined ? {} : { userAgent: input.context.userAgent }),
  };
}

/**
 * The action names used by Phase 1, as constants.
 *
 * Dotted resource.verb, per docs/02's examples (campaign.launched,
 * billing.plan_changed). Constants rather than inline strings so a rename is a
 * compile error and so the set is greppable when someone asks "what do we
 * audit".
 */
export const AUDIT_ACTIONS = {
  workspaceUpdated: 'workspace.updated',
  workspaceDeleted: 'workspace.deleted',
  memberRoleChanged: 'member.role_changed',
  memberRemoved: 'member.removed',
  invitationCreated: 'invitation.created',
  invitationRevoked: 'invitation.revoked',
  invitationAccepted: 'invitation.accepted',
} as const;
