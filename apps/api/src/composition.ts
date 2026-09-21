import { createDatabase, scoped, uuidv7 } from '@relayd/db';
import {
  AuditLogRepository,
  GlobalInvitationRepository,
  GlobalMembershipRepository,
  SessionRepository,
  UserRepository,
  UserTokenRepository,
  WorkspaceInvitationRepository,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@relayd/db';
import type { Database, DatabasePool } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import type { Logger } from '@relayd/logger';
import { LoggingMailer, Notifier } from '@relayd/notifications';
import { AuthService } from './services/auth.js';
import { ProfileService } from './services/profile.js';
import { WorkspaceService } from './services/workspaces.js';
import { TokenService } from './services/tokens.js';
import { currentActor, requireScope } from './context.js';
import type { AppDependencies } from './app.js';

/**
 * The composition root: where repositories, services and routers are actually
 * built for a running process.
 *
 * Every phase of this project built its router, its service and its
 * repositories and proved them with hand-built dependencies in tests. Nothing
 * ever assembled them, so `createApp` — which mounts each router only when its
 * dependency is present — mounted none of them, and the API served its health
 * probes and nothing else. This file is that missing assembly.
 *
 * ## The unit of work is where tenancy is enforced
 *
 * Every service takes a `unitOfWork(fn)` that hands it repositories. In tests
 * that is a function over in-memory fakes. Here it opens a transaction with
 * `app.workspace_id` set for the current request, so every row-level security
 * policy inside resolves to this workspace, and the transaction ends before
 * the connection goes back to the pool (CLAUDE.md section 8, INVARIANTS R36).
 * The scope comes from the request context rather than an argument, because a
 * scope that is passed can be passed wrongly; `requireScope()` throws if the
 * middleware that resolves membership has not run.
 *
 * ## What is deliberately not here yet
 *
 * A domain is mounted only when every collaborator it needs can be built
 * honestly. Domains needing infrastructure this deployment has no credentials
 * for — object storage for imports, a secret store for provider credentials,
 * Stripe for billing, the send path's queues for campaigns — are absent
 * rather than stubbed, because a route that exists and lies is worse than one
 * that is not there: the client's 404 is at least true.
 */

export interface CompositionOptions {
  pool: DatabasePool;
  redis: RedisConnection;
  logger: Logger;
  /** RS256 PEM, newlines already unescaped by packages/config. */
  jwtPrivateKey: string;
  jwtPublicKey: string;
  jwtKeyId: string;
  accessTokenTtlSeconds: number;
  refreshTtlDays: number;
  /** Public origin for links in verification and invitation email. */
  appBaseUrl: string;
  /** Cookies are Secure everywhere but plain-http local development. */
  secureCookies: boolean;
  /**
   * Log the body of every development email, link included.
   *
   * There is no inbox on a laptop and the token is stored hashed, so without
   * this a flow that ends in an emailed link cannot be completed locally at
   * all. False in production, where it would put a redeemable token in a log.
   */
  revealEmailBodies: boolean;
}

/**
 * Opens a scoped transaction and builds the repositories the caller asks for.
 *
 * The generic is what lets one helper serve every service: each passes the
 * builder for the repository set its own `UnitOfWork` type names, and gets
 * back exactly that, inside a transaction it did not have to remember to
 * open.
 */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function unitOfWorkFor<R>(db: Database, build: (tx: Tx) => R) {
  return async <T>(fn: (repos: R) => Promise<T>): Promise<T> =>
    scoped(db, requireScope(), async (tx) => fn(build(tx)));
}

/**
 * A transaction with no workspace scope set.
 *
 * Registration, sign-in and the whole of `/me` happen either before a
 * workspace exists or across all of a person's workspaces, so demanding a
 * scope is not merely unnecessary, it is wrong: `requireScope()` throws
 * outside a workspace-resolving route, which is what made registration
 * answer "Route requires a workspace but no workspace middleware ran".
 *
 * Nothing is weakened by this. `users`, `sessions` and `user_tokens` carry no
 * row-level security by design — a token belongs to a person, not a tenant —
 * and every tenant table these flows touch still has its policy: the writes
 * that create a workspace adopt its scope inside `WorkspaceRepository`, and
 * anything else reading a tenant table with no scope set matches nothing,
 * which is the safe direction to fail.
 */
function unscopedUnitOfWorkFor<R>(db: Database, build: (tx: Tx) => R) {
  return async <T>(fn: (repos: R) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => fn(build(tx)));
}

/**
 * The actor for an audit row.
 *
 * `currentActor()` is undefined only outside a request, which for a service
 * call means a bug rather than an anonymous action, so this fails loudly
 * instead of writing `system` and losing who did it.
 */
function actor(): { type: 'user' | 'api_key'; id: string } {
  const found = currentActor();
  if (found === undefined) {
    throw new Error('no actor in context: a service was called outside a request');
  }
  return found;
}

export function composeDependencies(options: CompositionOptions): AppDependencies {
  const { pool, redis, logger } = options;
  const db = createDatabase(pool);

  // Cross-tenant by design and therefore not inside a scoped transaction:
  // resolving which workspaces a user belongs to is the question asked
  // *before* a workspace is known (packages/db/repositories/global).
  const memberships = new GlobalMembershipRepository(db);

  const tokens = new TokenService({
    privateKeyPem: options.jwtPrivateKey,
    publicKeyPem: options.jwtPublicKey,
    keyId: options.jwtKeyId,
    accessTokenTtlSeconds: options.accessTokenTtlSeconds,
  });

  // No SMTP locally. LoggingMailer writes the message, and with it the
  // verification and invitation links, to the log — which is what makes
  // signing up possible on a laptop with no mail server.
  const notifier = new Notifier({
    mailer: new LoggingMailer(logger.child({ name: 'mailer' }), {
      revealBody: options.revealEmailBodies,
    }),
    appBaseUrl: options.appBaseUrl,
  });

  // auth, profile and workspaces share one repository set (services/auth.ts
  // exports it and the other two alias it), so they share one builder rather
  // than three that could drift apart. They do NOT share a scoping rule:
  // see the two wrappers below.
  const identityRepos = (tx: Tx) => ({
    users: new UserRepository(tx),
    sessions: new SessionRepository(tx),
    userTokens: new UserTokenRepository(tx),
    memberships: new GlobalMembershipRepository(tx),
    workspaces: new WorkspaceRepository(tx),
    members: new WorkspaceMemberRepository(tx),
    invitations: new WorkspaceInvitationRepository(tx),
    globalInvitations: new GlobalInvitationRepository(tx),
    auditLogs: new AuditLogRepository(tx),
  });

  // Before a workspace exists, or across every workspace a person has.
  const identityUnscoped = unscopedUnitOfWorkFor(db, identityRepos);
  // Inside the workspace the request resolved.
  const identityScoped = unitOfWorkFor(db, identityRepos);

  const auth = new AuthService({
    unitOfWork: identityUnscoped,
    tokens,
    notifier,
    newId: uuidv7,
    now: () => new Date(),
    refreshTtlDays: options.refreshTtlDays,
  });

  const profile = new ProfileService({
    unitOfWork: identityUnscoped,
    newId: uuidv7,
    now: () => new Date(),
    notifier,
  });

  const workspaces = new WorkspaceService({
    unitOfWork: identityScoped,
    notifier,
    newId: uuidv7,
    now: () => new Date(),
    currentActor: actor,
  });

  return {
    pool,
    redis,
    logger,
    auth: { auth, secureCookies: options.secureCookies, refreshTtlDays: options.refreshTtlDays },
    me: { profile, tokens },
    workspaces: {
      workspaces,
      tokens,
      memberships,
      lookupUserEmail: async () => null,
    },
  };
}
