import { Router, type NextFunction, type Request, type Response } from 'express';
import type { GlobalMembershipRepository } from '@relayd/db';
import { AppError } from '@relayd/types';
import type { CampaignId } from '@relayd/types';
import {
  audienceSchema,
  cloneCampaignSchema,
  createCampaignSchema,
  launchCampaignSchema,
  listCampaignsSchema,
  listRecipientsSchema,
  scheduleCampaignSchema,
  testSendSchema,
  updateCampaignSchema,
} from '@relayd/validation';
import { requireScope } from '../context.js';
import { idempotent, type IdempotencyPort } from '../middleware/idempotency.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import type { ApiKeyAuthOptions } from '../middleware/api-key-auth.js';
import { refuseApiKey } from '../middleware/api-key-auth.js';
import { validateBody } from '../middleware/validate.js';
import type { CampaignService } from '../services/campaigns.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Campaign routes.
 *
 * Two things here differ from the other resource routers, and both are
 * deliberate.
 *
 * **`campaign:launch` is not `campaign:write`.** An editor may build a
 * campaign and may not send it (docs/06). This is the one permission split in
 * the product that maps to an irreversible action, and collapsing the two is
 * the obvious simplification to make and the expensive one to undo.
 *
 * **Launch accepts an `Idempotency-Key`.** F29's trace is a double-clicked
 * launch button creating two snapshots. The guarded transition in the engine
 * already makes the second one a no-op, but a no-op that returns 409 to a
 * retried HTTP request looks like a failure to the browser. With the key, the
 * loser gets the winner's result.
 *
 * Progress reads `campaign_counters` and never counts recipients (R13). The
 * route has no way to express the `COUNT(*)` it forbids, because the service
 * exposes no method that would do one.
 */

export interface CampaignRouterOptions {
  campaigns: CampaignService;
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
  /**
   * Honours `Idempotency-Key` on create and launch (docs/17 amendment G).
   *
   * Accepted rather than required. The dashboard shares these routes, and the
   * thing that actually prevents a duplicate launch is the guarded state
   * transition in Postgres (R29) — the key is what makes a *retry* safe,
   * which is what an integrator on an unreliable connection needs.
   *
   * Absent in tests that do not exercise it, and then the header is ignored.
   */
  idempotency?: IdempotencyPort;
}

export function campaignRoutes(options: CampaignRouterOptions): Router {
  const router = Router();
  const { campaigns } = options;

  const auth = authenticate(options.tokens, options.apiKeys);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const chain = [auth, workspace] as const;

  const read = requirePermission('workspace:read');
  const write = requirePermission('campaign:write');
  const launch = requirePermission('campaign:launch');

  const id = (req: Request): CampaignId => req.params['id'] as CampaignId;

  router.get('/campaigns', ...chain, read, async (req: Request, res: Response) => {
    const query = listCampaignsSchema.parse(req.query);
    res.json({ data: await campaigns.list(requireScope(), query) });
  });

  router.get('/campaigns/:id', ...chain, read, async (req: Request, res: Response) => {
    res.json({ data: await campaigns.get(requireScope(), id(req)) });
  });

  /**
   * Progress, from counters only (R13, F13).
   *
   * Three team members watching a 500k campaign poll this every five seconds.
   * As a `GROUP BY` over `campaign_recipients` that is a sequential scan every
   * 1.7 seconds, competing with the dispatcher's own writes on the same table.
   */
  router.get('/campaigns/:id/progress', ...chain, read, async (req: Request, res: Response) => {
    res.json({ data: await campaigns.progress(requireScope(), id(req)) });
  });

  /**
   * G3's event timeline.
   *
   * `workspace:read`, like the rest of the campaign's report: a viewer who
   * can see that a campaign was paused should be able to see who paused it.
   * The audit log, which is the owner-and-admin record of everything anybody
   * did across the whole workspace, is a different thing behind a different
   * permission.
   */
  router.get('/campaigns/:id/timeline', ...chain, read, async (req: Request, res: Response) => {
    res.json({ data: await campaigns.timeline(requireScope(), id(req)) });
  });

  router.get('/campaigns/:id/recipients', ...chain, read, async (req: Request, res: Response) => {
    const query = listRecipientsSchema.parse(req.query);
    res.json({ data: await campaigns.listRecipients(requireScope(), id(req), query) });
  });

  /**
   * The audience step's count, before a campaign exists.
   *
   * A POST rather than a GET because the selection is a body — a list of list
   * ids and segment ids — and putting it in a query string caps the wizard at
   * whatever the proxy's URL limit happens to be.
   */
  /**
   * Honours the header when a store is wired, and is a no-op otherwise.
   *
   * Mounted *after* `validateBody`, so the request hash is taken over the
   * validated body rather than the raw one. Two requests that differ only in
   * fields this endpoint does not read are the same request, and hashing the
   * raw body would answer `idempotency_key_reuse` to a client that added a
   * field we ignore.
   */
  const replayable = (endpoint: string) =>
    options.idempotency === undefined
      ? (_req: Request, _res: Response, next: NextFunction) => next()
      : idempotent(endpoint, { store: options.idempotency, required: false });

  router.post(
    '/campaigns/audience-preview',
    ...chain,
    write,
    validateBody(audienceSchema),
    async (req: Request, res: Response) => {
      const { listIds } = req.body as { listIds: string[] };
      res.json({ data: await campaigns.previewAudience(requireScope(), { listIds }) });
    },
  );

  router.post(
    '/campaigns',
    ...chain,
    write,
    validateBody(createCampaignSchema),
    replayable('POST /campaigns'),
    async (req: Request, res: Response) => {
      const result = await campaigns.create(
        requireScope(),
        req.body as Parameters<CampaignService['create']>[1],
      );

      res.status(201).json({ data: result });
    },
  );

  router.patch(
    '/campaigns/:id',
    ...chain,
    write,
    validateBody(updateCampaignSchema),
    async (req: Request, res: Response) => {
      const result = await campaigns.update(
        requireScope(),
        id(req),
        req.body as Parameters<CampaignService['update']>[2],
      );

      res.json({ data: result });
    },
  );

  router.delete('/campaigns/:id', ...chain, write, async (req: Request, res: Response) => {
    await campaigns.remove(requireScope(), id(req));
    res.status(204).end();
  });

  router.post(
    '/campaigns/:id/schedule',
    ...chain,
    // Scheduling is not launching: it can be undone, and the launch
    // permission is checked again when the scheduler picks it up.
    write,
    validateBody(scheduleCampaignSchema),
    async (req: Request, res: Response) => {
      const { scheduledAt, timezone } = req.body as { scheduledAt: Date; timezone: string };
      res.json({ data: await campaigns.schedule(requireScope(), id(req), { scheduledAt, timezone }) });
    },
  );

  // A launch carries a consent declaration, and docs/06 says that is
  // "attributed to a user". `context.ts` already takes the position that a
  // key action is the key's, "rather than whoever happened to mint it two
  // months ago" — so a key has nobody to attribute an assertion to, and an
  // assertion attributed to somebody who was not there is worth nothing in
  // the dispute the record exists for.
  //
  // Refused here rather than in the service so the rule is visible next to
  // the route, the same way `billing:write` is (CLAUDE.md section 11).
  const noKeys = refuseApiKey();

  router.post(
    '/campaigns/:id/launch',
    ...chain,
    launch,
    noKeys,
    validateBody(launchCampaignSchema),
    replayable('POST /campaigns/:id/launch'),
    async (req: Request, res: Response) => {
      const key = idempotencyKey(req);

      const body = req.body as { consent: { source: string; detail?: string } };

      const result = await campaigns.launch(requireScope(), id(req), {
        ...(key === undefined ? {} : { idempotencyKey: key }),
        consent: {
          source: body.consent.source,
          detail: body.consent.detail ?? null,
          // For a dispute months later about who asserted this and from
          // where. Not the raw header: `req.ip` is what Express resolved
          // through the configured proxy trust, so a client-supplied
          // X-Forwarded-For cannot write a false address into the record.
          ip: req.ip ?? null,
        },
      });

      // 202, not 200. The snapshot is taken but nothing has been sent, and a
      // client that treats launch as "done" will show a completed campaign
      // with a zero send count for the next several seconds.
      res.status(202).json({ data: result });
    },
  );

  // Pause, resume and cancel take `campaign:launch` rather than
  // `campaign:write`. Whoever is trusted to start a send is the person who
  // should be able to stop it — and an editor who could pause but not launch
  // could halt someone else's campaign.
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    router.post(`/campaigns/:id/${action}`, ...chain, launch, async (req: Request, res: Response) => {
      res.json({ data: await campaigns.lifecycle(requireScope(), id(req), action) });
    });
  }

  router.post(
    '/campaigns/:id/retry-failed',
    ...chain,
    launch,
    async (req: Request, res: Response) => {
      res.json({ data: await campaigns.retryFailed(requireScope(), id(req)) });
    },
  );

  router.post(
    '/campaigns/:id/clone',
    ...chain,
    write,
    validateBody(cloneCampaignSchema),
    async (req: Request, res: Response) => {
      const { name } = req.body as { name?: string };
      const result = await campaigns.clone(requireScope(), id(req), name);
      res.status(201).json({ data: result });
    },
  );

  /**
   * Archive and unarchive (G1's row menu).
   *
   * `campaign:write`, not `campaign:launch`. Archiving a finished campaign
   * changes nothing about sending, and an editor tidying the list is not
   * making a sending decision. The repository's status guard is what stops
   * a live campaign being hidden mid-send.
   *
   * Unarchive is not in the design's menu — there is no frame that lists
   * archived campaigns yet — but archiving is otherwise a one-way door
   * reached from a menu two items below "Duplicate". `GET /campaigns` takes
   * `?archived=archived` to find them again.
   */
  router.post('/campaigns/:id/archive', ...chain, write, async (req: Request, res: Response) => {
    res.json({ data: await campaigns.archive(requireScope(), id(req)) });
  });

  router.post('/campaigns/:id/unarchive', ...chain, write, async (req: Request, res: Response) => {
    res.json({ data: await campaigns.unarchive(requireScope(), id(req)) });
  });

  /**
   * The pre-flight (G2 step 7).
   *
   * Runs the launch checks and launches nothing: no claim, no snapshot, no
   * event. It is the same `runLaunchPreflight` the launch path calls, so the
   * two cannot disagree — a pre-flight that says "7 pass" and is then
   * refused by the launch it was meant to predict teaches the customer that
   * the page is wrong and the error is noise.
   *
   * `campaign:write`, not `campaign:launch`: an editor who may build a
   * campaign but not send it still has to be told why it will not send, or
   * they cannot fix it and the person who can launch gets handed a broken
   * draft.
   *
   * POST rather than GET despite reading nothing, because it is not free:
   * it renders the message and calls a reputation feed. A GET invites
   * caching and prefetching, and a link-reputation lookup fired by a
   * browser's preconnect is a lookup nobody asked for.
   */
  router.post('/campaigns/:id/preflight', ...chain, write, async (req: Request, res: Response) => {
    res.json({ data: await campaigns.preflight(requireScope(), id(req)) });
  });

  router.post(
    '/campaigns/:id/test-send',
    ...chain,
    write,
    validateBody(testSendSchema),
    async (req: Request, res: Response) => {
      const { to } = req.body as { to: string[] };
      res.json({ data: await campaigns.testSend(requireScope(), id(req), to) });
    },
  );

  return router;
}

/**
 * The Idempotency-Key header, validated.
 *
 * Bounded and character-restricted because it becomes a unique index key. An
 * unbounded header is a way to write arbitrarily large rows, and a key with a
 * newline in it is a way to make two different requests look like one in a
 * log.
 */
function idempotencyKey(req: Request): string | undefined {
  const raw = req.get('idempotency-key');
  if (raw === undefined || raw === '') return undefined;

  if (raw.length > 255 || !/^[A-Za-z0-9_:.-]+$/u.test(raw)) {
    throw new AppError('validation_failed', 'Idempotency-Key must be 1-255 safe characters', 400);
  }

  return raw;
}
