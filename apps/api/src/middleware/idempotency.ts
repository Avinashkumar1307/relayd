import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@relayd/types';
import type { IdempotencyRecord, WorkspaceScope } from '@relayd/db';
import { requireScope } from '../context.js';

/**
 * Idempotency keys (docs/03 "Idempotency implementation").
 *
 * A caller that does not know whether their POST arrived retries it. Without
 * this they get a second campaign, a second import, a second charge. With it
 * they get the first response again.
 *
 * The shape is docs/03's, and three details in it are the whole safety:
 *
 *   **The row is claimed before the work starts.** `ON CONFLICT DO NOTHING`
 *   in one statement, so two concurrent requests with the same key cannot
 *   both proceed. A read followed by an insert is a race in which both see
 *   nothing and both run.
 *
 *   **The request hash is stored and compared.** A key reused with a
 *   *different* body is an error, not a replay — otherwise "retry my contact
 *   import" answers with the campaign somebody launched yesterday under the
 *   same key.
 *
 *   **A failure releases the claim.** Storing a 502 and replaying it would
 *   make a transient provider outage permanent for twenty-four hours, which
 *   is worse than the duplicate the key was protecting against.
 *
 * ## What it is not
 *
 * It is not a lock on the underlying resource. Two requests with *different*
 * keys can still both launch the same campaign; that is what the guarded
 * state transition in Postgres is for (R29). This makes a retry safe, not a
 * race.
 */

const HEADER = 'idempotency-key';

/** Bounded, because it is stored and indexed. */
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 255;

export interface IdempotencyPort {
  claim(
    scope: WorkspaceScope,
    input: { key: string; endpoint: string; requestHash: Buffer; now: Date },
  ): Promise<{ claimed: boolean; existing: IdempotencyRecord | null }>;

  reclaim(
    scope: WorkspaceScope,
    input: { key: string; endpoint: string; requestHash: Buffer; now: Date },
  ): Promise<boolean>;

  complete(
    scope: WorkspaceScope,
    input: { key: string; endpoint: string; responseCode: number; responseBody: unknown },
  ): Promise<boolean>;

  release(scope: WorkspaceScope, input: { key: string; endpoint: string }): Promise<void>;
}

export interface IdempotencyOptions {
  store: IdempotencyPort;
  now?: () => Date;
  /** How long a claim may sit in progress before another request may take it. */
  lockMs?: number;
  /** Required by default. docs/03: mandatory on every POST that creates or charges. */
  required?: boolean;
}

const DEFAULT_LOCK_MS = 30_000;

/**
 * A canonical hash of the request body.
 *
 * Key order is normalised, so `{a:1,b:2}` and `{b:2,a:1}` are the same
 * request — two clients serialising the same intent must not disagree about
 * whether it is the same intent. Arrays keep their order, because `[1,2]` and
 * `[2,1]` are genuinely different bodies.
 */
export function canonicalHash(body: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined members are absent from JSON, so they must be absent here too
    // or a client that sends `{a:1}` and one that sends `{a:1,b:undefined}`
    // would hash differently for the same request.
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/**
 * Wraps one route in an idempotency claim.
 *
 * `endpoint` is part of the key, so the same idempotency key used against two
 * different endpoints is two different requests — collapsing them would
 * replay a campaign launch as a contact import.
 */
export function idempotent(endpoint: string, options: IdempotencyOptions): RequestHandler {
  const now = options.now ?? (() => new Date());
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;
  const required = options.required ?? true;

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.get(HEADER);

    if (key === undefined || key.length === 0) {
      if (required) {
        next(
          new AppError(
            'validation_failed',
            'Idempotency-Key header is required on this endpoint',
            400,
          ),
        );
        return;
      }

      next();
      return;
    }

    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      next(
        new AppError(
          'validation_failed',
          `Idempotency-Key must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters`,
          400,
        ),
      );
      return;
    }

    const scope = requireScope();
    const requestHash = canonicalHash(req.body);
    const at = now();

    const { claimed, existing } = await options.store.claim(scope, {
      key,
      endpoint,
      requestHash,
      now: at,
    });

    if (!claimed) {
      const decision = replayDecision(existing, { requestHash, now: at, lockMs });

      if (decision.kind === 'reuse') {
        throw new AppError(
          'idempotency_key_reuse',
          'This Idempotency-Key was used with a different request body',
          409,
        );
      }

      if (decision.kind === 'in_progress') {
        throw new AppError(
          'conflict',
          'A request with this Idempotency-Key is still in progress',
          409,
        );
      }

      if (decision.kind === 'replay') {
        res.set('Idempotent-Replay', 'true');
        res.status(decision.responseCode).json(decision.responseBody);
        return;
      }

      // Stale. Take it over, or lose the race to whoever else is trying and
      // be told the request is in progress — which by then it is.
      const took = await options.store.reclaim(scope, { key, endpoint, requestHash, now: at });

      if (!took) {
        throw new AppError(
          'conflict',
          'A request with this Idempotency-Key is still in progress',
          409,
        );
      }
    }

    captureResponse(req, res, {
      store: options.store,
      scope,
      key,
      endpoint,
    });

    next();
  };
}

export type ReplayDecision =
  | { kind: 'reuse' }
  | { kind: 'in_progress' }
  | { kind: 'stale' }
  | { kind: 'replay'; responseCode: number; responseBody: unknown };

/**
 * What to do about a key somebody else already holds.
 *
 * The body check comes first and applies to every state. A caller reusing a
 * key with a different body has made a mistake whether the first request
 * finished or not, and telling them "still in progress" would send them back
 * to retry the same wrong thing.
 */
export function replayDecision(
  existing: IdempotencyRecord | null,
  input: { requestHash: Buffer; now: Date; lockMs: number },
): ReplayDecision {
  // The row vanished between the failed insert and the read — expired, or
  // released by a failure. Treated as stale so the caller takes it over
  // rather than being told a request is in progress that is not.
  if (existing === null) return { kind: 'stale' };

  if (!existing.requestHash.equals(input.requestHash)) return { kind: 'reuse' };

  if (existing.status === 'completed') {
    return {
      kind: 'replay',
      // A completed row with no code is a bug upstream, not a reason to fail
      // the caller: 200 with the stored body is what the first request most
      // likely returned.
      responseCode: existing.responseCode ?? 200,
      responseBody: existing.responseBody,
    };
  }

  if (existing.lockedAt === null) return { kind: 'stale' };

  const heldFor = input.now.getTime() - existing.lockedAt.getTime();
  return heldFor >= input.lockMs ? { kind: 'stale' } : { kind: 'in_progress' };
}

/**
 * Records the response as it goes out, and releases the claim if it failed.
 *
 * Wrapping `res.json` rather than listening for `finish`: the body is what
 * has to be stored, and by `finish` it is gone. The write is fire and forget
 * — a failure to record an idempotency response must not fail the response
 * itself, which has already succeeded.
 */
function captureResponse(
  req: Request,
  res: Response,
  context: {
    store: IdempotencyPort;
    scope: WorkspaceScope;
    key: string;
    endpoint: string;
  },
): void {
  const original = res.json.bind(res);

  res.json = (body: unknown): Response => {
    const code = res.statusCode;

    if (code >= 200 && code < 300) {
      void context.store
        .complete(context.scope, {
          key: context.key,
          endpoint: context.endpoint,
          responseCode: code,
          responseBody: body,
        })
        .catch(() => undefined);
    } else {
      // Released rather than stored. A 502 replayed for twenty-four hours is
      // worse than the duplicate this was protecting against.
      void context.store
        .release(context.scope, { key: context.key, endpoint: context.endpoint })
        .catch(() => undefined);
    }

    void req;
    return original(body);
  };
}
