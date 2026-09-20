import { Router, type Request, type Response } from 'express';
import type { GlobalMembershipRepository } from '@relayd/db';
import type { TemplateId, TemplateVersionId } from '@relayd/types';
import {
  createTemplateSchema,
  previewTemplateSchema,
  renameTemplateSchema,
  saveTemplateVersionSchema,
  sendTemplateTestSchema,
} from '@relayd/validation';
import { requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import type { ApiKeyAuthOptions } from '../middleware/api-key-auth.js';
import { validateBody } from '../middleware/validate.js';
import type { TemplateService } from '../services/templates.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Template routes.
 *
 * Writes take `template:write`, which docs/06 grants to owners, admins and
 * editors. Reads take `workspace:read`: the permission matrix has no
 * `template:read`, and a viewer who can see campaigns but not the content
 * those campaigns sent would be looking at half a report.
 */

export interface TemplateRouterOptions {
  templates: TemplateService;
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

export function templateRoutes(options: TemplateRouterOptions): Router {
  const router = Router();
  const { templates } = options;

  const auth = authenticate(options.tokens, options.apiKeys);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const chain = [auth, workspace] as const;

  const read = requirePermission('workspace:read');
  const write = requirePermission('template:write');

  router.get('/templates', ...chain, read, async (_req, res: Response) => {
    res.json({ data: await templates.list(requireScope()) });
  });

  router.get('/templates/:id', ...chain, read, async (req: Request, res: Response) => {
    const result = await templates.get(requireScope(), req.params['id'] as TemplateId);
    res.json({ data: result });
  });

  router.post(
    '/templates',
    ...chain,
    write,
    validateBody(createTemplateSchema),
    async (req: Request, res: Response) => {
      const result = await templates.create(
        requireScope(),
        req.body as Parameters<TemplateService['create']>[1],
      );

      res.status(201).json({
        data: result,
        // What sanitisation stripped. An author whose tracking snippet
        // vanished will otherwise assume the product is broken.
        meta: { removed: result.removed },
      });
    },
  );

  router.patch(
    '/templates/:id',
    ...chain,
    write,
    validateBody(renameTemplateSchema),
    async (req: Request, res: Response) => {
      const { name } = req.body as { name: string };
      const result = await templates.rename(requireScope(), req.params['id'] as TemplateId, name);
      res.json({ data: result });
    },
  );

  router.delete('/templates/:id', ...chain, write, async (req: Request, res: Response) => {
    await templates.remove(requireScope(), req.params['id'] as TemplateId);
    res.status(204).send();
  });

  /**
   * Archive and unarchive (F1's Active / Archived tabs).
   *
   * `template:write` rather than `workspace:delete`: archiving destroys
   * nothing. The row stays, every campaign that pinned one of its versions
   * still renders, and the author can bring it back — which is exactly why
   * it is a separate action from DELETE above.
   *
   * POST rather than PATCH on `/templates/:id`. Archiving is a transition
   * with its own guard, its own conflict ("already archived") and its own
   * audit row; folding it into the general patch would mean the rename
   * handler had to grow a branch that can refuse.
   */
  router.post('/templates/:id/archive', ...chain, write, async (req: Request, res: Response) => {
    const result = await templates.archive(requireScope(), req.params['id'] as TemplateId);
    res.json({ data: result });
  });

  router.post('/templates/:id/unarchive', ...chain, write, async (req: Request, res: Response) => {
    const result = await templates.unarchive(requireScope(), req.params['id'] as TemplateId);
    res.json({ data: result });
  });

  /**
   * Duplicate.
   *
   * 201 with the new template: the caller made a thing, and the id of the
   * thing they made is the only useful answer — F1 navigates straight to it.
   */
  router.post('/templates/:id/duplicate', ...chain, write, async (req: Request, res: Response) => {
    const result = await templates.duplicate(requireScope(), req.params['id'] as TemplateId);
    res.status(201).json({ data: result });
  });

  router.post(
    '/templates/:id/versions',
    ...chain,
    write,
    validateBody(saveTemplateVersionSchema),
    async (req: Request, res: Response) => {
      const result = await templates.saveVersion(
        requireScope(),
        req.params['id'] as TemplateId,
        req.body as Parameters<TemplateService['saveVersion']>[2],
      );

      res.status(201).json({ data: result.version, meta: { removed: result.removed } });
    },
  );

  /**
   * Publishing is one-way and makes the version immutable.
   *
   * 409 on a second attempt rather than 200: publishing twice is a sign the
   * caller believes something that is not true, and answering 200 would let
   * them keep believing it.
   */
  router.post(
    '/templates/versions/:versionId/publish',
    ...chain,
    write,
    async (req: Request, res: Response) => {
      const version = await templates.publish(
        requireScope(),
        req.params['versionId'] as TemplateVersionId,
      );
      res.json({ data: version });
    },
  );

  /**
   * "Send test" (F2a).
   *
   * `template:write` rather than `workspace:read`. This is the one endpoint
   * in this router that causes real mail to leave the building — outside
   * campaigns, outside suppression and outside metering — and a viewer who
   * can read a template should not be able to make it send.
   *
   * Capped at one recipient by the schema, and audited in the service.
   */
  router.post(
    '/templates/versions/:versionId/test',
    ...chain,
    write,
    validateBody(sendTemplateTestSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { to: string; senderId?: string };

      const result = await templates.sendTest(
        requireScope(),
        req.params['versionId'] as TemplateVersionId,
        body,
      );

      // 202: the message is queued, not delivered. A 200 here would be the
      // "provider accepted means delivered" mistake one layer earlier
      // (CLAUDE.md section 12).
      res.status(202).json({ data: result });
    },
  );

  /**
   * Preview.
   *
   * Returns rendered markup. The client must put it in a sandboxed iframe on
   * a separate origin (docs/06) — sanitisation and isolation are two halves
   * of the same control, and this endpoint returns the half that is still
   * markup.
   */
  router.post(
    '/templates/versions/:versionId/preview',
    ...chain,
    read,
    validateBody(previewTemplateSchema),
    async (req: Request, res: Response) => {
      const preview = await templates.preview(
        requireScope(),
        req.params['versionId'] as TemplateVersionId,
        req.body as Parameters<TemplateService['preview']>[2],
      );

      res.json({ data: preview });
    },
  );

  return router;
}
