import { Router, type NextFunction, type Request, type Response } from 'express';
import { replayDeadLetter, QUEUE_NAMES, type QueueName } from '@relayd/queue';
import type { GlobalDeadLetterRepository, GlobalScheduledJobRepository } from '@relayd/db';
import { AppError } from '@relayd/types';
import { requirePrincipal } from '../context.js';
import { authenticate } from '../middleware/authorize.js';
import type { TokenService } from '../services/tokens.js';

/**
 * The internal operator console (BUILD-PLAN Phase 5 item 7).
 *
 * Deliberately unstyled and deliberately outside the workspace routes. Every
 * endpoint here reads across tenants: queue depths are global, and the
 * dead-letter queue contains rows belonging to no workspace at all. A
 * workspace permission cannot express "may see every tenant's failures", so
 * these are gated by an operator check instead.
 *
 * The check is injected and denies by default. No document defines what an
 * operator *is* — there is no `is_operator` column and no staff role in the
 * docs/06 matrix — so rather than invent one, `isOperator` is a port the
 * deployment supplies. Wired to a deny-all default, the console answers 404
 * to everyone until somebody deliberately configures it — 404 rather than 403,
 * for the reason at the gate below. Recorded in docs/16 and flagged to the
 * owner.
 */

export interface OperatorRouterOptions {
  tokens: TokenService;
  deadLetters: GlobalDeadLetterRepository;
  schedules: GlobalScheduledJobRepository;
  queues: QueueDepthSource;
  replayTarget: { enqueue(input: { queue: string; jobId: string; payload: unknown }): Promise<void> };
  /**
   * Whether this principal may operate the deployment.
   *
   * Defaults to denying everyone. An operator console that is open by default
   * is a cross-tenant read for every user who finds the URL.
   */
  isOperator?: (principal: { userId: string }) => boolean | Promise<boolean>;
}

export interface QueueDepthSource {
  /** Waiting, active, delayed and failed counts for one queue. */
  depth(queue: QueueName): Promise<{
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
  }>;
}

export function operatorRoutes(options: OperatorRouterOptions): Router {
  const router = Router();
  const auth = authenticate(options.tokens);

  const isOperator = options.isOperator ?? ((): boolean => false);

  /**
   * The operator gate.
   *
   * 404, not 403. A 403 confirms the console exists to anyone who probes for
   * it; the same reasoning as answering 404 for another workspace's resources
   * (CLAUDE.md §11).
   */
  const operator = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const principal = requirePrincipal();

    if (!(await isOperator({ userId: principal.userId }))) {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }

    next();
  };

  const gate = [auth, operator] as const;

  // ------------------------------------------------------------ queue depth

  router.get('/operator/queues', ...gate, async (_req, res: Response) => {
    const depths = await Promise.all(
      QUEUE_NAMES.map(async (queue) => ({
        queue,
        ...(await options.queues.depth(queue).catch(() => ({
          // A queue whose depth cannot be read is itself worth seeing, and
          // failing the whole page for one of fourteen helps nobody.
          waiting: -1,
          active: -1,
          delayed: -1,
          failed: -1,
        }))),
      })),
    );

    res.json({ data: depths });
  });

  // ------------------------------------------------------------ dead letters

  router.get('/operator/dead-letters', ...gate, async (req: Request, res: Response) => {
    const queue = req.query['queue'];
    const status = req.query['status'];

    const rows = await options.deadLetters.list({
      ...(typeof queue === 'string' ? { queue } : {}),
      ...(typeof status === 'string' ? { status: status as never } : {}),
      limit: 200,
    });

    res.json({ data: rows });
  });

  router.get('/operator/dead-letters/summary', ...gate, async (_req, res: Response) => {
    res.json({ data: await options.deadLetters.summary() });
  });

  router.get('/operator/dead-letters/:id', ...gate, async (req: Request, res: Response) => {
    const row = await options.deadLetters.findById(String(req.params['id']));
    if (row === null) throw new AppError('not_found', 'Dead letter not found', 404);

    res.json({ data: row });
  });

  /**
   * Replay.
   *
   * Re-enqueues with the original job id, which makes replaying a job that
   * actually succeeded a no-op. The claim is a guarded update, so two
   * operators pressing the button at once produce one replay.
   */
  router.post('/operator/dead-letters/:id/replay', ...gate, async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const principal = requirePrincipal();

    const row = await options.deadLetters.findById(id);
    if (row === null) throw new AppError('not_found', 'Dead letter not found', 404);

    const result = await replayDeadLetter(
      { id: row.id, queue: row.queue, jobId: row.jobId, payload: row.payload, status: row.status },
      options.replayTarget,
      () => options.deadLetters.claimForReplay(id, principal.userId as never),
    );

    if (!result.replayed) {
      throw new AppError('conflict', `Not replayed: ${result.reason ?? 'unknown'}`, 409);
    }

    res.json({ data: { replayed: true, queue: row.queue, jobId: row.jobId } });
  });

  router.post('/operator/dead-letters/:id/status', ...gate, async (req: Request, res: Response) => {
    const { status, notes } = req.body as { status?: string; notes?: string };

    if (status !== 'investigating' && status !== 'discarded') {
      throw new AppError(
        'validation_failed',
        'Status must be investigating or discarded; replaying is done by replaying',
        422,
      );
    }

    const updated = await options.deadLetters.setStatus(
      String(req.params['id']),
      status,
      notes === undefined ? undefined : notes.slice(0, 2000),
    );

    if (!updated) throw new AppError('conflict', 'That row is already replayed', 409);
    res.status(204).send();
  });

  // --------------------------------------------------------------- schedules

  router.get('/operator/schedules', ...gate, async (_req, res: Response) => {
    res.json({ data: await options.schedules.list() });
  });

  router.post('/operator/schedules/:name/enable', ...gate, async (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled?: boolean };
    const found = await options.schedules.setEnabled(String(req.params['name']), enabled !== false);

    if (!found) throw new AppError('not_found', 'Schedule not found', 404);
    res.status(204).send();
  });

  /**
   * Run a schedule now.
   *
   * Sets `next_run_at` rather than enqueueing directly, so the run still goes
   * through the leader-elected tick — pressing this during a scheduled run
   * cannot produce two copies.
   */
  router.post('/operator/schedules/:name/run', ...gate, async (req: Request, res: Response) => {
    const found = await options.schedules.runNow(String(req.params['name']));
    if (!found) throw new AppError('not_found', 'Schedule not found', 404);

    res.json({ data: { queued: true } });
  });

  return router;
}
