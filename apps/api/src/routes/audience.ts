import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type {
  ContactId,
  ContactListId,
  ImportJobId,
  SegmentId,
  SuppressionId,
  TagId,
} from '@relayd/types';
import type { GlobalMembershipRepository } from '@relayd/db';
import {
  bulkTagSchema,
  createContactSchema,
  createImportSchema,
  importMappingSchema,
  createListSchema,
  createSegmentSchema,
  createSuppressionSchema,
  createTagSchema,
  listContactsQuerySchema,
  listMembershipSchema,
  updateContactSchema,
} from '@relayd/validation';
import { requirePrincipal, requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import { validateBody } from '../middleware/validate.js';
import type { AudienceService } from '../services/audience.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Audience routes: contacts, lists, tags, segments, suppressions, imports.
 *
 * Every route runs authenticate then requireWorkspace then requirePermission.
 * Reads take contact:read, writes take contact:write, and imports take
 * contact:import — which docs/06 grants to editors but not viewers.
 */

export interface AudienceRouterOptions {
  audience: AudienceService;
  tokens: TokenService;
  memberships: GlobalMembershipRepository;
}

/** Query strings arrive as strings; Zod coerces, and rejects what it cannot. */
function parseQuery<T>(schema: z.ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw Object.assign(new Error(issue?.message ?? 'Invalid query'), { status: 400 });
  }
  return result.data;
}

export function audienceRoutes(options: AudienceRouterOptions): Router {
  const router = Router();
  const { audience } = options;

  const auth = authenticate(options.tokens);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const chain = [auth, workspace] as const;

  const read = requirePermission('contact:read');
  const write = requirePermission('contact:write');
  const runImport = requirePermission('contact:import');

  // ---------------------------------------------------------------- contacts

  router.get('/contacts', ...chain, read, async (req: Request, res: Response) => {
    const query = parseQuery(listContactsQuerySchema, req);
    const page = await audience.listContacts(requireScope(), query);

    res.json({
      data: page.contacts,
      meta: {
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    });
  });

  router.post(
    '/contacts',
    ...chain,
    write,
    validateBody(createContactSchema),
    async (req: Request, res: Response) => {
      const result = await audience.createContact(
        requireScope(),
        req.body as Parameters<AudienceService['createContact']>[1],
      );

      // 201 even for a suppressed address, per docs/03 — the contact exists,
      // and its status says it will not be sent to.
      res.status(result.created ? 201 : 200).json({
        data: {
          ...result.contact,
          wasCreated: result.created,
          suppressed: result.suppressed,
        },
      });
    },
  );

  router.get('/contacts/:id', ...chain, read, async (req: Request, res: Response) => {
    const contact = await audience.getContact(requireScope(), req.params['id'] as ContactId);
    res.json({ data: contact });
  });

  router.patch(
    '/contacts/:id',
    ...chain,
    write,
    validateBody(updateContactSchema),
    async (req: Request, res: Response) => {
      const contact = await audience.updateContact(
        requireScope(),
        req.params['id'] as ContactId,
        req.body as never,
      );
      res.json({ data: contact });
    },
  );

  router.delete('/contacts/:id', ...chain, write, async (req: Request, res: Response) => {
    await audience.deleteContact(requireScope(), req.params['id'] as ContactId);
    res.status(204).send();
  });

  router.post(
    '/contacts/tags',
    ...chain,
    write,
    validateBody(bulkTagSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { contactIds: string[]; tagId: string };
      const result = await audience.bulkTag(requireScope(), body.contactIds, body.tagId, 'add');
      res.json({ data: result });
    },
  );

  router.delete(
    '/contacts/tags',
    ...chain,
    write,
    validateBody(bulkTagSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { contactIds: string[]; tagId: string };
      const result = await audience.bulkTag(requireScope(), body.contactIds, body.tagId, 'remove');
      res.json({ data: result });
    },
  );

  // ------------------------------------------------------------------- lists

  router.get('/lists', ...chain, read, async (_req, res) => {
    res.json({ data: await audience.listLists(requireScope()) });
  });

  router.post(
    '/lists',
    ...chain,
    write,
    validateBody(createListSchema),
    async (req: Request, res: Response) => {
      const principal = requirePrincipal();
      const body = req.body as { name: string; description?: string };
      const list = await audience.createList(requireScope(), {
        ...body,
        createdBy: principal.userId,
      });
      res.status(201).json({ data: list });
    },
  );

  router.delete('/lists/:id', ...chain, write, async (req: Request, res: Response) => {
    await audience.deleteList(requireScope(), req.params['id'] as ContactListId);
    res.status(204).send();
  });

  router.post(
    '/lists/:id/contacts',
    ...chain,
    write,
    validateBody(listMembershipSchema),
    async (req: Request, res: Response) => {
      const result = await audience.changeListMembership(
        requireScope(),
        req.params['id'] as ContactListId,
        (req.body as { contactIds: string[] }).contactIds,
        'add',
      );
      res.json({ data: result });
    },
  );

  router.delete(
    '/lists/:id/contacts',
    ...chain,
    write,
    validateBody(listMembershipSchema),
    async (req: Request, res: Response) => {
      const result = await audience.changeListMembership(
        requireScope(),
        req.params['id'] as ContactListId,
        (req.body as { contactIds: string[] }).contactIds,
        'remove',
      );
      res.json({ data: result });
    },
  );

  // -------------------------------------------------------------------- tags

  router.get('/tags', ...chain, read, async (_req, res) => {
    res.json({ data: await audience.listTags(requireScope()) });
  });

  router.post(
    '/tags',
    ...chain,
    write,
    validateBody(createTagSchema),
    async (req: Request, res: Response) => {
      const tag = await audience.createTag(requireScope(), req.body as { name: string });
      res.status(201).json({ data: tag });
    },
  );

  router.delete('/tags/:id', ...chain, write, async (req: Request, res: Response) => {
    await audience.deleteTag(requireScope(), req.params['id'] as TagId);
    res.status(204).send();
  });

  // ---------------------------------------------------------------- segments

  router.get('/segments', ...chain, read, async (_req, res) => {
    res.json({ data: await audience.listSegments(requireScope()) });
  });

  router.post(
    '/segments',
    ...chain,
    write,
    validateBody(createSegmentSchema),
    async (req: Request, res: Response) => {
      const segment = await audience.createSegment(
        requireScope(),
        req.body as { name: string; definition: unknown },
      );
      res.status(201).json({ data: segment });
    },
  );

  router.delete('/segments/:id', ...chain, write, async (req: Request, res: Response) => {
    await audience.deleteSegment(requireScope(), req.params['id'] as SegmentId);
    res.status(204).send();
  });

  /**
   * Preview for a saved segment, or for an unsaved definition the editor is
   * still being written — so a user sees the count before committing to it.
   */
  router.post('/segments/preview', ...chain, read, async (req: Request, res: Response) => {
    const body = req.body as { definition?: unknown };
    const result = await audience.previewSegment(requireScope(), {
      ...(body.definition === undefined ? {} : { definition: body.definition }),
    });
    res.json({ data: result });
  });

  router.post('/segments/:id/preview', ...chain, read, async (req: Request, res: Response) => {
    const result = await audience.previewSegment(requireScope(), {
      segmentId: req.params['id'] as SegmentId,
    });
    res.json({ data: result });
  });

  // ------------------------------------------------------------ suppressions

  router.get('/suppressions', ...chain, read, async (_req, res) => {
    res.json({ data: await audience.listSuppressions(requireScope()) });
  });

  router.post(
    '/suppressions',
    ...chain,
    write,
    validateBody(createSuppressionSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { email: string; reason: string; notes?: string };
      const row = await audience.addSuppression(requireScope(), body);
      // Null means already suppressed, which is the desired state, not a
      // conflict — a bounce handler must never fail because it ran twice.
      res.status(row === null ? 200 : 201).json({ data: row ?? { email: body.email, alreadySuppressed: true } });
    },
  );

  router.delete('/suppressions/:id', ...chain, write, async (req: Request, res: Response) => {
    await audience.removeSuppression(requireScope(), req.params['id'] as SuppressionId);
    res.status(204).send();
  });

  // ----------------------------------------------------------------- imports

  router.get('/imports', ...chain, read, async (_req, res) => {
    res.json({ data: await audience.listImports(requireScope()) });
  });

  router.post(
    '/imports',
    ...chain,
    runImport,
    validateBody(createImportSchema),
    async (req: Request, res: Response) => {
      const principal = requirePrincipal();
      const body = req.body as {
        filename: string;
        byteSize: number;
        fileType: 'csv' | 'tsv' | 'xlsx';
      };

      const { job, upload } = await audience.createImport(requireScope(), {
        ...body,
        createdBy: principal.userId,
      });

      res.status(201).json({
        data: {
          id: job.id,
          status: job.status,
          upload: {
            url: upload.uploadUrl,
            expiresInSeconds: upload.expiresInSeconds,
          },
        },
      });
    },
  );

  router.get('/imports/:id', ...chain, read, async (req: Request, res: Response) => {
    const job = await audience.getImport(requireScope(), req.params['id'] as ImportJobId);
    res.json({ data: job });
  });

  router.get('/imports/:id/errors', ...chain, read, async (req: Request, res: Response) => {
    const errors = await audience.listImportErrors(
      requireScope(),
      req.params['id'] as ImportJobId,
    );
    res.json({ data: errors });
  });

  router.post(
    '/imports/:id/mapping',
    ...chain,
    runImport,
    validateBody(importMappingSchema),
    async (req: Request, res: Response) => {
      const job = await audience.setImportMapping(
        requireScope(),
        req.params['id'] as ImportJobId,
        req.body as Parameters<AudienceService['setImportMapping']>[2],
      );

      res.json({ data: job });
    },
  );

  router.post('/imports/:id/cancel', ...chain, runImport, async (req: Request, res: Response) => {
    await audience.cancelImport(requireScope(), req.params['id'] as ImportJobId);
    res.status(204).send();
  });

  return router;
}
