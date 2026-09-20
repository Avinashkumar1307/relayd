import { AppError } from '@relayd/types';
import type { UserId } from '@relayd/types';
import type {
  AuditLogRepository,
  OutboundWebhookRepository,
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WorkspaceScope,
} from '@relayd/db';
import { buildAuditEntry } from './audit.js';

/**
 * Outbound webhook endpoint management (BUILD-PLAN Phase 9).
 *
 * The delivery policy — backoff, health, what to retry — lives in
 * `@relayd/notifications`. This is the management surface: subscribe an
 * endpoint, change what it listens to, rotate its secret, read why an event
 * did not arrive.
 *
 * Two rules the routes rely on:
 *
 *   **The secret is shown once, at creation and at rotation.** Only an ARN is
 *   stored, so there is nothing to show later even to us. An integrator who
 *   loses it rotates; that is what rotation is for.
 *
 *   **The URL must be https and must not be internal.** A webhook endpoint is
 *   a URL we fetch on a customer's instruction from inside our network, which
 *   is the definition of SSRF. The check is here rather than in the worker
 *   because refusing at subscribe time is a message the customer can act on,
 *   and refusing at delivery time is a support ticket.
 */

/** The events a customer may subscribe to. `*` means all of them, now and later. */
export const WEBHOOK_EVENT_TYPES = [
  'campaign.launched',
  'campaign.completed',
  'campaign.paused',
  'email.sent',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
  'contact.created',
  'contact.unsubscribed',
  'contact.suppressed',
  'import.completed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** How many endpoints one workspace may hold. */
export const MAX_ENDPOINTS = 10;

/**
 * The type on a test delivery.
 *
 * Not in `WEBHOOK_EVENT_TYPES`, deliberately: nobody subscribes to it, and
 * adding it to the list would let a customer subscribe to an event the
 * product never emits on its own. It is addressed at one endpoint by id,
 * bypassing subscription entirely, which is what a test is.
 */
export const TEST_EVENT_TYPE = 'endpoint.test';

/** How far back a replay reaches. Also what J4c prints as `replayableUntil`. */
export const REPLAY_WINDOW_DAYS = 7;

/** The most one replay will re-queue, so the button cannot start an avalanche. */
export const MAX_REPLAY = 5_000;

export interface OutboundWebhookRepositories {
  webhooks: OutboundWebhookRepository;
  auditLogs: AuditLogRepository;
}

export type OutboundWebhookUnitOfWork = <T>(
  fn: (repos: OutboundWebhookRepositories) => Promise<T>,
) => Promise<T>;

export interface OutboundWebhookServiceOptions {
  unitOfWork: OutboundWebhookUnitOfWork;
  newId: () => string;
  /** Generates a signing secret and stores it, returning its ARN. */
  storeSecret: (input: { workspaceId: string; endpointId: string }) => Promise<{
    ref: string;
    secret: string;
  }>;
  now?: () => Date;
}

/** An endpoint as the API returns it. Never carries a secret or an ARN. */
export interface PublicEndpoint {
  id: string;
  url: string;
  events: string[];
  status: WebhookEndpointRow['status'];
  description: string | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  disabledAt: Date | null;
  disabledReason: string | null;
  secretRotatedAt: Date | null;
  createdAt: Date;
}

export class OutboundWebhookService {
  constructor(private readonly options: OutboundWebhookServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  eventTypes(): readonly string[] {
    return WEBHOOK_EVENT_TYPES;
  }

  async list(scope: WorkspaceScope): Promise<PublicEndpoint[]> {
    return this.options.unitOfWork(async (repos) =>
      (await repos.webhooks.list(scope)).map(toPublic),
    );
  }

  async create(
    scope: WorkspaceScope,
    input: {
      url: string;
      events: readonly string[];
      description?: string;
      actor: { userId: UserId };
    },
  ): Promise<{ endpoint: PublicEndpoint; secretShownOnce: string }> {
    assertDeliverableUrl(input.url);
    const events = normaliseEvents(input.events);

    const id = this.options.newId();

    return this.options.unitOfWork(async (repos) => {
      if ((await repos.webhooks.list(scope)).length >= MAX_ENDPOINTS) {
        throw new AppError(
          'limit_reached',
          `A workspace may have ${MAX_ENDPOINTS} webhook endpoints. Remove one first.`,
          402,
        );
      }

      const { ref, secret } = await this.options.storeSecret({
        workspaceId: scope.workspaceId as string,
        endpointId: id,
      });

      const row = await repos.webhooks.create(scope, {
        id,
        url: input.url,
        secretRef: ref,
        events,
        ...(input.description === undefined ? {} : { description: input.description }),
        createdBy: input.actor.userId,
      });

      await repos.auditLogs.append(
        scope,
        buildAuditEntry({
          id: this.options.newId(),
          actor: { type: 'user', id: input.actor.userId },
          action: 'webhook_endpoint.created',
          resourceType: 'webhook_endpoint',
          resourceId: id,
          // The URL and the events. Never the secret, and never the ARN — an
          // audit log is read by more people than the endpoint is.
          after: { url: input.url, events },
        }),
      );

      return { endpoint: toPublic(row), secretShownOnce: secret };
    });
  }

  async update(
    scope: WorkspaceScope,
    input: {
      endpointId: string;
      url?: string;
      events?: readonly string[];
      description?: string | null;
      /** Only `active` and `paused`. Health states are not the customer's to set. */
      status?: 'active' | 'paused';
      actor: { userId: UserId };
    },
  ): Promise<PublicEndpoint> {
    if (input.url !== undefined) assertDeliverableUrl(input.url);

    return this.options.unitOfWork(async (repos) => {
      const existing = await repos.webhooks.find(scope, input.endpointId);
      if (existing === null) throw new AppError('not_found', 'Not found', 404);

      const row = await repos.webhooks.update(scope, {
        endpointId: input.endpointId,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.events === undefined ? {} : { events: normaliseEvents(input.events) }),
        ...(input.description === undefined ? {} : { description: input.description }),
        // Re-enabling a disabled endpoint is a status change to `active`,
        // which is how a customer says "I fixed it" — and the failure count
        // is cleared with it, so they are not one failure from disabled.
        ...(input.status === undefined ? {} : { status: input.status }),
      });

      if (row === null) throw new AppError('not_found', 'Not found', 404);

      if (input.status === 'active' && existing.status === 'disabled') {
        await repos.webhooks.recordHealth(scope, {
          endpointId: input.endpointId,
          status: 'active',
          consecutiveFailures: 0,
        });
      }

      await repos.auditLogs.append(
        scope,
        buildAuditEntry({
          id: this.options.newId(),
          actor: { type: 'user', id: input.actor.userId },
          action: 'webhook_endpoint.updated',
          resourceType: 'webhook_endpoint',
          resourceId: input.endpointId,
          before: { url: existing.url, events: existing.events, status: existing.status },
          after: { url: row.url, events: row.events, status: row.status },
        }),
      );

      return toPublic(row);
    });
  }

  /**
   * Rotates the signing secret.
   *
   * The previous one stays live for the overlap window
   * (`SECRET_OVERLAP_MS` in `@relayd/notifications`), so an integrator who has
   * not redeployed keeps verifying.
   */
  async rotateSecret(
    scope: WorkspaceScope,
    input: { endpointId: string; actor: { userId: UserId } },
  ): Promise<{ endpoint: PublicEndpoint; secretShownOnce: string }> {
    return this.options.unitOfWork(async (repos) => {
      const existing = await repos.webhooks.find(scope, input.endpointId);
      if (existing === null) throw new AppError('not_found', 'Not found', 404);

      const { ref, secret } = await this.options.storeSecret({
        workspaceId: scope.workspaceId as string,
        endpointId: input.endpointId,
      });

      const row = await repos.webhooks.rotateSecret(scope, {
        endpointId: input.endpointId,
        secretRef: ref,
        at: this.now(),
      });

      if (row === null) throw new AppError('not_found', 'Not found', 404);

      await repos.auditLogs.append(
        scope,
        buildAuditEntry({
          id: this.options.newId(),
          actor: { type: 'user', id: input.actor.userId },
          action: 'webhook_endpoint.secret_rotated',
          resourceType: 'webhook_endpoint',
          resourceId: input.endpointId,
        }),
      );

      return { endpoint: toPublic(row), secretShownOnce: secret };
    });
  }

  async remove(
    scope: WorkspaceScope,
    input: { endpointId: string; actor: { userId: UserId } },
  ): Promise<void> {
    return this.options.unitOfWork(async (repos) => {
      const removed = await repos.webhooks.remove(scope, input.endpointId);
      if (!removed) throw new AppError('not_found', 'Not found', 404);

      await repos.auditLogs.append(
        scope,
        buildAuditEntry({
          id: this.options.newId(),
          actor: { type: 'user', id: input.actor.userId },
          action: 'webhook_endpoint.deleted',
          resourceType: 'webhook_endpoint',
          resourceId: input.endpointId,
        }),
      );
    });
  }

  /**
   * J4b's "Send test event".
   *
   * Queued as a real delivery rather than posted inline. Three reasons, and
   * the third is the one that matters: an inline POST would be an
   * unauthenticated outbound request made from the API process on a
   * customer's instruction, it would block the request for as long as the
   * customer's server felt like taking, and — the point of the button — it
   * would not exercise the signing, the retry policy or the delivery log
   * that a real event goes through. A test that takes a different path from
   * the thing it is testing proves nothing.
   *
   * The event id carries a timestamp, so pressing the button twice sends two
   * tests. That is deliberate and is the one place in this file where
   * duplicate suppression is *not* wanted: the customer pressed it twice
   * because the first one did not arrive.
   */
  async sendTest(
    scope: WorkspaceScope,
    input: { endpointId: string; actor: { userId: UserId } },
  ): Promise<{ sent: boolean }> {
    const now = this.now();

    return this.options.unitOfWork(async (repos) => {
      const endpoint = await repos.webhooks.find(scope, input.endpointId);
      if (endpoint === null) throw new AppError('not_found', 'Not found', 404);

      if (endpoint.status === 'disabled') {
        throw new AppError(
          'conflict',
          'This endpoint is disabled. Re-enable it before sending a test event.',
          409,
        );
      }

      const queued = await repos.webhooks.enqueueDelivery(scope, {
        endpointId: input.endpointId,
        eventId: `${TEST_EVENT_TYPE}:${input.endpointId}:${now.getTime()}`,
        eventType: TEST_EVENT_TYPE,
        payload: {
          type: TEST_EVENT_TYPE,
          test: true,
          workspaceId: scope.workspaceId,
          endpointId: input.endpointId,
          sentAt: now.toISOString(),
        },
        scheduledFor: now,
      });

      await repos.auditLogs.append(
        scope,
        buildAuditEntry({
          id: this.options.newId(),
          actor: { type: 'user', id: input.actor.userId },
          action: 'webhook_endpoint.test_sent',
          resourceType: 'webhook_endpoint',
          resourceId: input.endpointId,
        }),
      );

      return { sent: queued };
    });
  }

  /**
   * J4c's replay: re-queue what this endpoint failed to receive.
   *
   * **A replay cannot double-deliver.** The guard is in the repository's
   * `WHERE status IN ('failed','abandoned')`, not in this method: a
   * `delivered` row is not matched, so nothing that arrived can be sent
   * again, and a `pending` row is not matched either, so nothing already in
   * flight is queued twice. Calling this endpoint twice therefore replays
   * once — the second call finds the rows already `pending` and answers
   * zero. That is the guarded-update idiom CLAUDE.md section 9 asks for
   * rather than a lock.
   *
   * Bounded to `REPLAY_WINDOW_DAYS` because the deliveries table is
   * partitioned by `created_at`: an unbounded replay is a scan of every
   * partition, and re-sending a three-month-old `email.bounced` to a
   * customer's integration is not a kindness anyway.
   */
  async replay(
    scope: WorkspaceScope,
    input: { endpointId: string; actor: { userId: UserId } },
  ): Promise<{ replaying: number }> {
    const now = this.now();
    const since = new Date(now.getTime() - REPLAY_WINDOW_DAYS * 86_400_000);

    return this.options.unitOfWork(async (repos) => {
      const endpoint = await repos.webhooks.find(scope, input.endpointId);
      if (endpoint === null) throw new AppError('not_found', 'Not found', 404);

      if (endpoint.status === 'disabled') {
        // Replaying into a disabled endpoint would re-fail every row and
        // leave the customer where they started. Re-enabling is a PATCH, and
        // saying so is more useful than a silent zero.
        throw new AppError(
          'conflict',
          'This endpoint is disabled. Re-enable it first, then replay.',
          409,
        );
      }

      const replaying = await repos.webhooks.replayFailed(scope, {
        endpointId: input.endpointId,
        since,
        now,
        limit: MAX_REPLAY,
      });

      await repos.auditLogs.append(
        scope,
        buildAuditEntry({
          id: this.options.newId(),
          actor: { type: 'user', id: input.actor.userId },
          action: 'webhook_endpoint.replayed',
          resourceType: 'webhook_endpoint',
          resourceId: input.endpointId,
          after: { replaying, since: since.toISOString() },
        }),
      );

      return { replaying };
    });
  }

  /** The delivery log, for an integrator asking why an event did not arrive. */
  async deliveries(
    scope: WorkspaceScope,
    input: { endpointId: string; limit?: number },
  ): Promise<WebhookDeliveryRow[]> {
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)));

    return this.options.unitOfWork(async (repos) => {
      if ((await repos.webhooks.find(scope, input.endpointId)) === null) {
        throw new AppError('not_found', 'Not found', 404);
      }

      return repos.webhooks.listDeliveries(scope, { endpointId: input.endpointId, limit });
    });
  }
}

/** Deduplicated, and only event types we actually emit. `*` is allowed. */
export function normaliseEvents(events: readonly string[]): string[] {
  const known = new Set<string>([...WEBHOOK_EVENT_TYPES, '*']);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const event of events) {
    if (!known.has(event) || seen.has(event)) continue;
    seen.add(event);
    out.push(event);
  }

  if (out.length === 0) {
    throw new AppError('validation_failed', 'Subscribe to at least one event type', 400);
  }

  // A wildcard subsumes everything else, and storing both makes the UI show a
  // list that contradicts itself.
  return out.includes('*') ? ['*'] : out;
}

/**
 * Refuses a URL we should not fetch.
 *
 * A webhook endpoint is a URL we request from inside our network on a
 * customer's instruction, which is the definition of SSRF. Refusing at
 * subscribe time gives the customer a message they can act on; refusing at
 * delivery time gives them a support ticket.
 *
 * This is the hostname check only. The delivery worker resolves DNS and
 * re-checks the address it actually connects to, because a hostname that
 * resolves to 169.254.169.254 passes everything below.
 */
export function assertDeliverableUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('validation_failed', 'That is not a valid URL', 400);
  }

  if (url.protocol !== 'https:') {
    // Not http. A signed payload over plaintext is a signed payload anybody
    // on the path can read, and the signature proves origin rather than
    // hiding content.
    throw new AppError('validation_failed', 'A webhook URL must use https', 400);
  }

  if (isPrivateHost(url.hostname)) {
    throw new AppError(
      'validation_failed',
      'A webhook URL must point at a public host',
      400,
    );
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials in the URL end up in logs, in the delivery record, and in
    // the customer's screenshot when they ask for help.
    throw new AppError('validation_failed', 'A webhook URL must not carry credentials', 400);
  }
}

/** Hostnames that are ours, the host's, or the cloud metadata service. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;

  // IPv6 loopback and the unique-local range.
  if (host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/u.test(host)) return true;

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (octets === null) return false;

  const [a, b] = [Number(octets[1]), Number(octets[2])];

  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local, which includes the cloud metadata address every SSRF write-up
  // opens with.
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT, and the rest of the reserved space.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;

  return false;
}

function toPublic(row: WebhookEndpointRow): PublicEndpoint {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    status: row.status,
    description: row.description,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    secretRotatedAt: row.secretRotatedAt,
    createdAt: row.createdAt,
  };
}
