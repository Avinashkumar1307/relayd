import { Router, type Request, type Response } from 'express';
import type { GlobalMembershipRepository } from '@relayd/db';
import type { SendingPoolId } from '@relayd/types';
import { addPoolMemberSchema, createPoolSchema, updatePoolSchema } from '@relayd/validation';
import { requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import type { ApiKeyAuthOptions } from '../middleware/api-key-auth.js';
import { validateBody } from '../middleware/validate.js';
import type { PoolService } from '../services/pools.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Sending pool routes.
 *
 * Pools take `provider:write` rather than `campaign:write`: a pool is a piece
 * of sending infrastructure, and the person who may build a campaign is not
 * necessarily the person who may decide which of the company's provider
 * accounts it goes out through.
 *
 * `GET /pools/:id/health` exists because the routing rules are invisible
 * otherwise. A customer whose campaign will not launch for `no_healthy_sender`
 * needs to see which member is cooling down, which is below the health floor,
 * and which two members share a provider account and therefore share a quota.
 */

export interface PoolRouterOptions {
  pools: PoolService;
  tokens: TokenService;
  /**
   * Accepts API keys as well as session tokens when wired.
   *
   * Absent in a deployment or a test that has no key store, and then a
   * key-shaped credential falls through to JWT verification and is refused
   * there — never accepted slowly.
   */
  apiKeys?: ApiKeyAuthOptions;
  memberships: GlobalMembershipRepository;
}

export function poolRoutes(options: PoolRouterOptions): Router {
  const router = Router();
  const { pools } = options;

  const auth = authenticate(options.tokens, options.apiKeys);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const chain = [auth, workspace] as const;

  const read = requirePermission('workspace:read');
  const write = requirePermission('provider:write');

  const id = (req: Request): SendingPoolId => req.params['id'] as SendingPoolId;

  router.get('/pools', ...chain, read, async (_req, res: Response) => {
    res.json({ data: await pools.list(requireScope()) });
  });

  /**
   * The senders a pool may contain, with their connection's headroom (H1b).
   *
   * Declared before `/pools/:id`, or Express 5 matches `senders` as an id
   * and the drawer gets a 404 from `pools.get`.
   */
  router.get('/pools/senders', ...chain, read, async (_req, res: Response) => {
    res.json({ data: await pools.eligibleSenders(requireScope()) });
  });

  router.get('/pools/:id', ...chain, read, async (req: Request, res: Response) => {
    res.json({ data: await pools.get(requireScope(), id(req)) });
  });

  /** Why the router would or would not choose each member right now. */
  router.get('/pools/:id/health', ...chain, read, async (req: Request, res: Response) => {
    res.json({ data: await pools.health(requireScope(), id(req)) });
  });

  router.post(
    '/pools',
    ...chain,
    write,
    validateBody(createPoolSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { name: string; strategy: 'round_robin' };
      res.status(201).json({ data: await pools.create(requireScope(), body) });
    },
  );

  router.patch(
    '/pools/:id',
    ...chain,
    write,
    validateBody(updatePoolSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { name?: string; strategy?: 'round_robin' };
      res.json({ data: await pools.update(requireScope(), id(req), body) });
    },
  );

  router.delete('/pools/:id', ...chain, write, async (req: Request, res: Response) => {
    await pools.remove(requireScope(), id(req));
    res.status(204).end();
  });

  router.post(
    '/pools/:id/members',
    ...chain,
    write,
    validateBody(addPoolMemberSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { senderAccountId: string; weight: number; priority: number };
      res.status(201).json({ data: await pools.addMember(requireScope(), id(req), body) });
    },
  );

  router.delete(
    '/pools/:id/members/:senderId',
    ...chain,
    write,
    async (req: Request, res: Response) => {
      await pools.removeMember(requireScope(), id(req), String(req.params['senderId']));
      res.status(204).end();
    },
  );

  return router;
}
