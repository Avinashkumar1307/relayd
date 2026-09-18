import { Router, type Request, type Response } from 'express';
import type { GlobalMembershipRepository } from '@relayd/db';
import type { TemplateId, TemplateVersionId } from '@relayd/types';
import {
  createTemplateSchema,
  previewTemplateSchema,
  renameTemplateSchema,
  saveTemplateVersionSchema,
} from '@relayd/validation';
import { requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
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
  memberships: GlobalMembershipRepository;
}

export function templateRoutes(options: TemplateRouterOptions): Router {
  const router = Router();
  const { templates } = options;

  const auth = authenticate(options.tokens);
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
