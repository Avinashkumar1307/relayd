import { randomBytes } from 'node:crypto';
import type {
  ProviderConnectionRepository,
  ProviderConnectionRow,
  SenderAccountRepository,
  SenderIdentityRepository,
  AuditLogRepository,
  WorkspaceScope,
} from '@relayd/db';
import type {
  EmailProviderAdapter,
  ProviderCredentials,
  ProviderType,
  SecretWriter,
} from '@relayd/email-providers';
import { AppError } from '@relayd/types';
import type {
  ProviderConnectionId,
  SenderAccountId,
  SenderIdentityId,
  UserId,
} from '@relayd/types';

import { AUDIT_ACTIONS_PROVIDERS, buildAuditEntry, type Actor } from './audit.js';
import { senderDnsView, type SenderDnsView } from './sender-dns.js';

/**
 * Provider connections and senders.
 *
 * The rule that shapes every method here: a credential arrives over TLS,
 * is validated by calling the provider, is written to Secrets Manager, and
 * only the ARN is stored. Nothing in this service returns a credential, and
 * nothing persists one (INVARIANTS R21).
 *
 * The endpoint token is the other thing handled carefully. It is a bearer
 * credential for writing events into a workspace (F4), so it is generated
 * here, returned exactly once at connect time, and never read back by any
 * route.
 */

export interface ProviderRepositories {
  connections: ProviderConnectionRepository;
  identities: SenderIdentityRepository;
  senders: SenderAccountRepository;
  auditLogs: AuditLogRepository;
}

export type ProviderUnitOfWork = <T>(fn: (repos: ProviderRepositories) => Promise<T>) => Promise<T>;

export interface ProviderServiceOptions {
  unitOfWork: ProviderUnitOfWork;
  /** Chooses the adapter. The only switch on provider type outside the registry. */
  adapterFor: (type: ProviderType) => EmailProviderAdapter | null;
  secrets: SecretWriter;
  /** Builds the Secrets Manager path. Injected so the env is not read here. */
  credentialPathFor: (input: { workspaceId: string; connectionId: string }) => string;
  /** The public base the ingest endpoint is served from. */
  ingestBaseUrl: string;
  /**
   * Where a test send goes.
   *
   * The API cannot perform one itself: docs/06 gives the API task role
   * permission to *write* secrets and not to read them, so it has no way to
   * obtain the credential. Only the worker role reads. A test send is
   * therefore a job, and this is the port that enqueues it — wired in Phase 5
   * when the queues are declared, and consumed with the send path in Phase 6.
   */
  testSends?: TestSendQueue;
  /**
   * Re-checks a sender identity's DNS out of band.
   *
   * A job for the same reason a test send is one: re-reading verification
   * state means calling the provider, calling the provider means reading the
   * credential, and docs/06 gives the API task role permission to write
   * secrets and not to read them. The request therefore asks for a check and
   * reports the state it can see; it does not perform one. Absent until the
   * queue is wired, and then the route answers 503 rather than pretending.
   */
  dnsChecks?: DnsCheckQueue;
  /**
   * Posts a signed synthetic event at this connection's own ingest URL.
   *
   * Also a job, and for a second reason on top of the credential one: the
   * point of E1d is to prove the *whole* inbound path — that the URL
   * resolves, that the signature verifies against this connection's secret,
   * and that the event lands in `provider_webhook_events`. A check that ran
   * inside the API process would prove none of that.
   */
  ingestTests?: IngestTestQueue;
  newId: () => string;
  now: () => Date;
  currentActor: () => Actor;
}

/**
 * A connection as the API returns it.
 *
 * Deliberately not `ProviderConnectionRow`: that carries a credential
 * version and a capability blob, and a separate type is what stops a future
 * field being exposed by forgetting to strip it.
 */
export interface ConnectionView {
  id: string;
  providerType: ProviderType;
  name: string;
  status: ProviderConnectionRow['status'];
  hasWebhookSecret: boolean;
  lastVerifiedAt: Date | null;
  lastError: Record<string, unknown> | null;
  quotaSnapshot: Record<string, unknown> | null;
  capabilities: Record<string, unknown>;
  createdAt: Date;
}

export interface TestSendQueue {
  enqueue(input: {
    workspaceId: string;
    senderAccountId: string;
    to: readonly string[];
    subject: string;
  }): Promise<{ jobId: string }>;
}

export interface DnsCheckQueue {
  enqueue(input: {
    workspaceId: string;
    providerConnectionId: string;
    senderIdentityId: string;
  }): Promise<{ jobId: string }>;
}

export interface IngestTestQueue {
  enqueue(input: {
    workspaceId: string;
    providerConnectionId: string;
  }): Promise<{ jobId: string }>;
}

export class ProviderService {
  constructor(private readonly options: ProviderServiceOptions) {}

  // ------------------------------------------------------------ connections

  async listConnections(scope: WorkspaceScope): Promise<ConnectionView[]> {
    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.connections.list(scope);
      return rows.map(toView);
    });
  }

  async getConnection(scope: WorkspaceScope, id: ProviderConnectionId): Promise<ConnectionView> {
    return this.options.unitOfWork(async (repos) => {
      const row = await repos.connections.findById(scope, id);
      if (row === null) throw new AppError('not_found', 'Connection not found', 404);
      return toView(row);
    });
  }

  /**
   * Connects a provider.
   *
   * The order matters and is the one docs/07 specifies: validate the
   * credential by calling the provider first, then write the secret, then
   * store the ARN. Storing first would leave a row pointing at a secret that
   * was never proven to work, and the customer would discover it at launch.
   *
   * The endpoint URL is returned here and only here.
   */
  async connect(
    scope: WorkspaceScope,
    input: {
      providerType: ProviderType;
      name: string;
      credentials: ProviderCredentials;
      config?: Record<string, unknown>;
    },
  ): Promise<{ connection: ConnectionView; ingestUrl: string; warnings: string[] }> {
    const adapter = this.options.adapterFor(input.providerType);
    if (adapter === null) {
      throw new AppError('validation_failed', `${input.providerType} is not supported`, 422);
    }

    if (input.credentials.type !== input.providerType) {
      throw new AppError(
        'validation_failed',
        'The credentials do not match the provider being connected',
        422,
      );
    }

    // Before anything is written. A credential that does not work is not a
    // connection, it is a typo.
    const verification = await adapter.verifyConnection(input.credentials);
    if (!verification.ok) {
      throw new AppError(
        'validation_failed',
        verification.error?.message ?? 'Those credentials were rejected by the provider',
        422,
      );
    }

    // Recorded on the row so a connection can be traced to whoever made it.
    // An API key has no user id, which the column allows.
    const actor = this.options.currentActor();
    const actorUserId = actor.type === 'user' ? (actor.id as UserId | undefined) : undefined;

    const connectionId = this.options.newId() as ProviderConnectionId;
    const endpointToken = newEndpointToken();
    const path = this.options.credentialPathFor({
      workspaceId: scope.workspaceId,
      connectionId,
    });

    await this.options.secrets.write(path, JSON.stringify(input.credentials));

    try {
      return await this.options.unitOfWork(async (repos) => {
        const { connection } = await repos.connections.createWithToken(scope, {
          id: connectionId,
          providerType: input.providerType,
          name: input.name,
          credentialRef: path,
          endpointToken,
          ...(input.config === undefined ? {} : { config: input.config }),
          ...(actorUserId === undefined ? {} : { createdBy: actorUserId }),
        });

        await repos.connections.recordVerification(scope, connectionId, {
          ok: true,
          status: 'active',
          capabilities: { ...adapter.capabilities },
        });

        await this.audit(repos, scope, {
          action: AUDIT_ACTIONS_PROVIDERS.connected,
          resourceId: connectionId,
          after: { providerType: input.providerType, name: input.name },
        });

        return {
          connection: { ...toView(connection), status: 'active' as const },
          // Shown once. After this the token is never read back by any route:
          // anyone holding it can write events into this workspace.
          ingestUrl: this.ingestUrl(input.providerType, endpointToken),
          warnings: warningsFor(verification.details ?? {}),
        };
      });
    } catch (cause) {
      // The secret was written before the row. If the row failed, the secret
      // is orphaned — destroy it rather than leaving credential material in
      // Secrets Manager that nothing references and nobody will find.
      await this.options.secrets.destroy(path).catch(() => undefined);
      throw cause;
    }
  }

  /**
   * Re-checks a connection against the provider.
   *
   * Reads the credential through the injected reader rather than holding one:
   * this service never has credential material except during `connect` and
   * `rotate`, where the customer supplied it in the request.
   */
  async verify(
    scope: WorkspaceScope,
    id: ProviderConnectionId,
    credentials: ProviderCredentials,
  ): Promise<ConnectionView> {
    return this.options.unitOfWork(async (repos) => {
      const row = await repos.connections.findById(scope, id);
      if (row === null) throw new AppError('not_found', 'Connection not found', 404);

      const adapter = this.options.adapterFor(row.providerType);
      if (adapter === null) throw new AppError('validation_failed', 'Unsupported provider', 422);

      const result = await adapter.verifyConnection(credentials);

      await repos.connections.recordVerification(
        scope,
        id,
        result.ok
          ? { ok: true, status: 'active', capabilities: { ...adapter.capabilities } }
          : {
              ok: false,
              status: 'error',
              // The typed ProviderError, which has already been scrubbed at
              // the adapter boundary. The original never reaches here.
              error: { kind: result.error?.kind, message: result.error?.message },
            },
      );

      const updated = await repos.connections.findById(scope, id);
      if (updated === null) throw new AppError('not_found', 'Connection not found', 404);
      return toView(updated);
    });
  }

  /**
   * Replaces a connection's credential.
   *
   * Validated first, as at connect. The version bump is what evicts every
   * worker's cache immediately (R21), and the old secret is destroyed after
   * the new one is in place — the other order leaves a window where the
   * connection points at nothing.
   */
  async rotate(
    scope: WorkspaceScope,
    id: ProviderConnectionId,
    credentials: ProviderCredentials,
  ): Promise<ConnectionView> {
    const existing = await this.options.unitOfWork(async (repos) => {
      const row = await repos.connections.findById(scope, id);
      if (row === null) throw new AppError('not_found', 'Connection not found', 404);
      return row;
    });

    if (credentials.type !== existing.providerType) {
      throw new AppError(
        'validation_failed',
        'The credentials do not match this connection’s provider',
        422,
      );
    }

    const adapter = this.options.adapterFor(existing.providerType);
    if (adapter === null) throw new AppError('validation_failed', 'Unsupported provider', 422);

    const result = await adapter.verifyConnection(credentials);
    if (!result.ok) {
      throw new AppError(
        'validation_failed',
        result.error?.message ?? 'Those credentials were rejected by the provider',
        422,
      );
    }

    const path = this.options.credentialPathFor({
      workspaceId: scope.workspaceId,
      connectionId: id,
    });

    await this.options.secrets.write(path, JSON.stringify(credentials));

    return this.options.unitOfWork(async (repos) => {
      await repos.connections.rotateCredential(scope, id, path);
      await repos.connections.recordVerification(scope, id, {
        ok: true,
        status: 'active',
        capabilities: { ...adapter.capabilities },
      });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_PROVIDERS.rotated,
        resourceId: id,
      });

      const updated = await repos.connections.findById(scope, id);
      if (updated === null) throw new AppError('not_found', 'Connection not found', 404);
      return toView(updated);
    });
  }

  /**
   * Disconnects a provider.
   *
   * Deletes the row, then destroys the secret. Deleting the row first is
   * deliberate: it stops the endpoint token resolving immediately, which
   * matters more than an orphaned secret if the second step fails. A secret
   * nobody references is inert; a live endpoint token for a disconnected
   * provider is not.
   */
  async disconnect(scope: WorkspaceScope, id: ProviderConnectionId): Promise<void> {
    const path = await this.options.unitOfWork(async (repos) => {
      const row = await repos.connections.findById(scope, id);
      if (row === null) throw new AppError('not_found', 'Connection not found', 404);

      const senders = await repos.senders.list(scope, { providerId: id });
      if (senders.length > 0) {
        // The FK would refuse anyway, with a message nobody can act on.
        throw new AppError(
          'conflict',
          `This connection has ${senders.length} sender${senders.length === 1 ? '' : 's'}. Remove them first.`,
          409,
        );
      }

      await repos.connections.remove(scope, id);
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_PROVIDERS.disconnected,
        resourceId: id,
        before: { providerType: row.providerType, name: row.name },
      });

      return this.options.credentialPathFor({
        workspaceId: scope.workspaceId,
        connectionId: id,
      });
    });

    await this.options.secrets.destroy(path).catch(() => undefined);
  }

  // -------------------------------------------------------------- identities

  async syncIdentities(
    scope: WorkspaceScope,
    id: ProviderConnectionId,
    credentials: ProviderCredentials,
  ): Promise<{ synced: number }> {
    return this.options.unitOfWork(async (repos) => {
      const row = await repos.connections.findById(scope, id);
      if (row === null) throw new AppError('not_found', 'Connection not found', 404);

      const adapter = this.options.adapterFor(row.providerType);
      if (adapter === null) throw new AppError('validation_failed', 'Unsupported provider', 422);

      const snapshots = await adapter.listVerifiedIdentities(credentials);

      for (const snapshot of snapshots) {
        await repos.identities.upsert(scope, {
          id: this.options.newId() as SenderIdentityId,
          providerId: id,
          kind: snapshot.kind,
          value: snapshot.value,
          verificationStatus: snapshot.status,
          ...(snapshot.dkim === undefined ? {} : { dkimStatus: snapshot.dkim }),
        });
      }

      return { synced: snapshots.length };
    });
  }

  async listIdentities(scope: WorkspaceScope, providerId?: ProviderConnectionId) {
    return this.options.unitOfWork((repos) =>
      repos.identities.list(scope, providerId === undefined ? {} : { providerId }),
    );
  }

  // ----------------------------------------------------------------- senders

  async listSenders(scope: WorkspaceScope, providerId?: ProviderConnectionId) {
    return this.options.unitOfWork((repos) =>
      repos.senders.list(scope, providerId === undefined ? {} : { providerId }),
    );
  }

  /**
   * Creates a sender.
   *
   * The identity must be verified. A sender on an unverified identity is a
   * sender every message from which the provider will reject, and letting one
   * be created means the failure surfaces at launch instead of here.
   */
  async createSender(
    scope: WorkspaceScope,
    input: {
      providerId: ProviderConnectionId;
      identityId: SenderIdentityId;
      fromEmail: string;
      fromName: string;
      replyTo?: string;
      dailyLimit?: number;
    },
  ) {
    return this.options.unitOfWork(async (repos) => {
      const connection = await repos.connections.findById(scope, input.providerId);
      if (connection === null) throw new AppError('not_found', 'Connection not found', 404);

      const identity = await repos.identities.findById(scope, input.identityId);
      if (identity === null) throw new AppError('not_found', 'Sender identity not found', 404);

      if (identity.providerId !== input.providerId) {
        throw new AppError(
          'validation_failed',
          'That identity belongs to a different connection',
          422,
        );
      }

      if (identity.verificationStatus !== 'verified') {
        throw new AppError(
          'validation_failed',
          `${identity.value} is not verified with this provider yet`,
          422,
        );
      }

      if (!addressCoveredBy(input.fromEmail, identity)) {
        throw new AppError(
          'validation_failed',
          `${input.fromEmail} is not covered by the verified identity ${identity.value}`,
          422,
        );
      }

      const sender = await repos.senders.create(scope, {
        id: this.options.newId() as SenderAccountId,
        providerId: input.providerId,
        identityId: input.identityId,
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        ...(input.dailyLimit === undefined ? {} : { dailyLimit: input.dailyLimit }),
      });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_PROVIDERS.senderCreated,
        resourceId: sender.id,
        after: { fromEmail: input.fromEmail },
      });

      return sender;
    });
  }

  async updateSender(
    scope: WorkspaceScope,
    id: SenderAccountId,
    patch: { fromName?: string; replyTo?: string | null; dailyLimit?: number | null },
  ) {
    return this.options.unitOfWork(async (repos) => {
      const updated = await repos.senders.update(scope, id, patch);
      if (updated === null) throw new AppError('not_found', 'Sender not found', 404);
      return updated;
    });
  }

  async removeSender(scope: WorkspaceScope, id: SenderAccountId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      const sender = await repos.senders.findById(scope, id);
      if (sender === null) throw new AppError('not_found', 'Sender not found', 404);

      await repos.senders.remove(scope, id);
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_PROVIDERS.senderRemoved,
        resourceId: id,
        before: { fromEmail: sender.fromEmail },
      });
    });
  }

  async rename(
    scope: WorkspaceScope,
    id: ProviderConnectionId,
    name: string,
  ): Promise<ConnectionView> {
    return this.options.unitOfWork(async (repos) => {
      const updated = await repos.connections.rename(scope, id, name);
      if (updated === null) throw new AppError('not_found', 'Connection not found', 404);
      return toView(updated);
    });
  }

  /**
   * Queues a test send.
   *
   * Checked here rather than in the worker so the customer gets a form error
   * instead of a job that fails silently: the sender must exist, its
   * connection must be usable, and its identity must still be verified.
   */
  async testSend(
    scope: WorkspaceScope,
    input: { senderId: SenderAccountId; to: readonly string[]; subject: string },
  ): Promise<{ jobId: string; queued: number }> {
    const queue = this.options.testSends;
    if (queue === undefined) {
      throw new AppError(
        'service_unavailable',
        'Test sending is not available on this deployment yet',
        503,
      );
    }

    return this.options.unitOfWork(async (repos) => {
      const sender = await repos.senders.findById(scope, input.senderId);
      if (sender === null) throw new AppError('not_found', 'Sender not found', 404);

      if (sender.status !== 'active') {
        throw new AppError('conflict', `This sender is ${sender.status}`, 409);
      }

      const connection = await repos.connections.findById(scope, sender.providerId);
      if (connection === null) throw new AppError('not_found', 'Connection not found', 404);

      if (connection.status !== 'active' && connection.status !== 'degraded') {
        throw new AppError('conflict', `This connection is ${connection.status}`, 409);
      }

      const identity = await repos.identities.findById(scope, sender.identityId);
      if (identity === null || identity.verificationStatus !== 'verified') {
        throw new AppError(
          'validation_failed',
          'This sender’s identity is no longer verified with the provider',
          422,
        );
      }

      const { jobId } = await queue.enqueue({
        workspaceId: scope.workspaceId,
        senderAccountId: input.senderId,
        to: input.to,
        subject: input.subject,
      });

      // Audited because it sends real mail outside a campaign, so it is
      // outside suppression checks and outside metering.
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_PROVIDERS.testSent,
        resourceId: input.senderId,
        after: { recipients: input.to.length },
      });

      return { jobId, queued: input.to.length };
    });
  }

  // -------------------------------------------------------------- sender DNS

  /**
   * The SPF / DKIM / DMARC drawer for one sender (E2b).
   *
   * Reports what `sender_identities` holds. The composition and every
   * judgement about what counts as verified live in `sender-dns.ts`, which
   * has no repository and no clock of its own and is therefore testable
   * against a row rather than against a database.
   */
  async senderDns(scope: WorkspaceScope, id: SenderAccountId): Promise<SenderDnsView> {
    return this.options.unitOfWork(async (repos) => {
      const { identity } = await this.senderWithIdentity(repos, scope, id);

      return senderDnsView({ senderId: id, identity, now: this.options.now() });
    });
  }

  /**
   * E2b's "Check DNS now".
   *
   * Asks for a re-check and answers with the state as it stands. It does not
   * wait for the check: the check calls the provider, which needs the
   * credential, which this process cannot read (docs/06). Returning the
   * current view rather than a bare acknowledgement is what the browser
   * expects — it writes the response straight into the drawer's cache — and
   * it is honest, because `nextCheckInMinutes` says when the answer will
   * actually move.
   */
  async checkSenderDns(scope: WorkspaceScope, id: SenderAccountId): Promise<SenderDnsView> {
    const queue = this.options.dnsChecks;
    if (queue === undefined) {
      throw new AppError(
        'service_unavailable',
        'DNS re-checks are not available on this deployment yet',
        503,
      );
    }

    const view = await this.options.unitOfWork(async (repos) => {
      const { sender, identity } = await this.senderWithIdentity(repos, scope, id);

      await queue.enqueue({
        workspaceId: scope.workspaceId,
        providerConnectionId: sender.providerId,
        senderIdentityId: identity.id,
      });

      return senderDnsView({ senderId: id, identity, now: this.options.now() });
    });

    return view;
  }

  /**
   * E1d's "Send test event": prove the inbound webhook path works.
   *
   * Refused for a provider that has no inbound webhooks at all rather than
   * queued and silently dropped — D4 makes SMTP best-effort by design, and a
   * spinner that never resolves teaches the customer the wrong thing about
   * why their bounces are missing.
   *
   * Audited, because it writes an event into the workspace's own ingest
   * inbox and an operator reading `provider_webhook_events` later needs to
   * know which row was a drill.
   */
  async sendIngestTestEvent(
    scope: WorkspaceScope,
    id: ProviderConnectionId,
  ): Promise<{ sent: boolean }> {
    const queue = this.options.ingestTests;
    if (queue === undefined) {
      throw new AppError(
        'service_unavailable',
        'Webhook tests are not available on this deployment yet',
        503,
      );
    }

    return this.options.unitOfWork(async (repos) => {
      const connection = await repos.connections.findById(scope, id);
      if (connection === null) throw new AppError('not_found', 'Connection not found', 404);

      if (connection.capabilities['supportsWebhooks'] === false) {
        throw new AppError(
          'validation_failed',
          'This provider has no inbound webhooks, so there is nothing to test. Delivery over it is best-effort.',
          422,
        );
      }

      if (connection.status === 'revoked' || connection.status === 'disabled') {
        throw new AppError('conflict', `This connection is ${connection.status}`, 409);
      }

      await queue.enqueue({ workspaceId: scope.workspaceId, providerConnectionId: id });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_PROVIDERS.ingestTested,
        resourceId: id,
      });

      return { sent: true };
    });
  }

  /**
   * A sender and the identity behind it, both scoped, both 404 on a miss.
   *
   * 404 rather than 403 for a sender in another workspace (CLAUDE.md
   * section 11), and 404 rather than 500 for a sender whose identity has
   * vanished — the FK is ON DELETE RESTRICT so it should not happen, and if
   * it does the caller still gets an answer they can read.
   */
  private async senderWithIdentity(
    repos: ProviderRepositories,
    scope: WorkspaceScope,
    id: SenderAccountId,
  ) {
    const sender = await repos.senders.findById(scope, id);
    if (sender === null) throw new AppError('not_found', 'Sender not found', 404);

    const identity = await repos.identities.findById(scope, sender.identityId);
    if (identity === null) throw new AppError('not_found', 'Sender identity not found', 404);

    return { sender, identity };
  }

  private ingestUrl(providerType: ProviderType, token: string): string {
    const base = this.options.ingestBaseUrl.replace(/\/+$/u, '');
    return `${base}/ingest/v1/${providerType}/${token}`;
  }

  private async audit(
    repos: ProviderRepositories,
    scope: WorkspaceScope,
    entry: {
      action: string;
      resourceId: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    },
  ): Promise<void> {
    await repos.auditLogs.append(
      scope,
      buildAuditEntry({
        id: this.options.newId(),
        actor: this.options.currentActor(),
        resourceType: 'provider_connection',
        ...entry,
      }),
    );
  }
}

/** 48 bytes of randomness, base64url. Unguessable, and a legal path segment. */
export function newEndpointToken(): string {
  return randomBytes(48).toString('base64url');
}

/**
 * Whether a From address is covered by a verified identity.
 *
 * A domain identity covers every address at that domain; an email identity
 * covers only itself. Providers enforce this at send time, and checking here
 * turns a launch-time rejection into a form error.
 */
export function addressCoveredBy(
  fromEmail: string,
  identity: { kind: 'domain' | 'email'; value: string },
): boolean {
  const address = fromEmail.trim().toLowerCase();
  const value = identity.value.trim().toLowerCase();

  if (identity.kind === 'email') return address === value;

  const at = address.lastIndexOf('@');
  if (at === -1) return false;

  const domain = address.slice(at + 1);
  // A subdomain is covered; a domain that merely ends with the same letters
  // is not — "notexample.com" must not match "example.com".
  return domain === value || domain.endsWith(`.${value}`);
}

function toView(row: ProviderConnectionRow): ConnectionView {
  return {
    id: row.id,
    providerType: row.providerType,
    name: row.name,
    status: row.status,
    hasWebhookSecret: row.hasWebhookSecret,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    quotaSnapshot: row.quotaSnapshot,
    capabilities: row.capabilities,
    createdAt: row.createdAt,
  };
}

/**
 * Things worth telling the customer at connect time.
 *
 * A sandboxed SES account delivers only to verified addresses; a SendGrid key
 * without mail.send passes verification and fails every send. Both are
 * invisible failures otherwise.
 */
function warningsFor(details: Readonly<Record<string, string | number | boolean>>): string[] {
  const warnings: string[] = [];

  if (details['sandbox'] === true) {
    warnings.push(
      'This SES account is in the sandbox, so it will only deliver to addresses you have verified with AWS. Request production access before launching a campaign.',
    );
  }
  if (details['sendingEnabled'] === false) {
    warnings.push('Sending is currently disabled on this provider account.');
  }
  if (details['canSend'] === false) {
    warnings.push('This API key cannot send mail. Give it the mail.send permission and reconnect.');
  }
  if (details['deliveryFeedback'] === false) {
    warnings.push(
      'SMTP gives no delivery feedback, so bounces and complaints will not be recorded automatically. Sending over SMTP is best-effort.',
    );
  }

  return warnings;
}
