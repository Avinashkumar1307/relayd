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
  createExportSchema,
  createImportSchema,
  createSavedViewSchema,
  importMappingSchema,
  createListSchema,
  createSegmentSchema,
  createSuppressionSchema,
  createTagSchema,
  listContactsQuerySchema,
  listMembershipSchema,
  listSuppressionsQuerySchema,
  mergePreviewQuerySchema,
  mergeTagsSchema,
  renameListSchema,
  renameTagSchema,
  updateContactSchema,
  updateSegmentSchema,
} from '@relayd/validation';
import { requirePrincipal, requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import type { ApiKeyAuthOptions } from '../middleware/api-key-auth.js';
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

/**
 * Query strings arrive as strings; Zod coerces, and rejects what it cannot.
 *
 * Generic over the schema rather than over its output type, so a schema whose
 * input and output differ — `?ids=a,b,c` parsed into an array — type-checks.
 * `z.ZodType<T>` defaults its input to its output and refuses one.
 */
function parseQuery<S extends z.ZodTypeAny>(schema: S, req: Request): z.TypeOf<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw Object.assign(new Error(issue?.message ?? 'Invalid query'), { status: 400 });
  }
  return result.data as z.TypeOf<S>;
}

export function audienceRoutes(options: AudienceRouterOptions): Router {
  const router = Router();
  const { audience } = options;

  const auth = authenticate(options.tokens, options.apiKeys);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const chain = [auth, workspace] as const;

  const read = requirePermission('contact:read');
  const write = requirePermission('contact:write');
  const runImport = requirePermission('contact:import');
  // Owners and admins only, per the matrix in packages/types/src/permissions.
  // An export is the whole audience leaving the product in one file, which
  // is a different act from editing a contact.
  const runExport = requirePermission('contact:export');

  // ------------------------------------------------------- audience overview

  /**
   * D1's header line: "48,213 contacts · 45,102 subscribed · 2,318
   * suppressed", plus the count its footer pages through.
   *
   * Takes the same query the contacts list takes, including `view` and `q`,
   * because `matching` has to be the size of the set the rows came from.
   * `limit` and `cursor` are accepted and ignored — the page sends one
   * filter object to both endpoints, and rejecting the two fields that only
   * mean something to the list would make the caller build a second one.
   */
  router.get('/stats', ...chain, read, async (req: Request, res: Response) => {
    const query = parseQuery(listContactsQuerySchema, req);
    res.json({ data: await audience.stats(requireScope(), query) });
  });

  // ------------------------------------------------------------- saved views

  router.get('/saved-views', ...chain, read, async (_req: Request, res: Response) => {
    res.json({ data: await audience.listSavedViews(requireScope()) });
  });

  router.post(
    '/saved-views',
    ...chain,
    write,
    validateBody(createSavedViewSchema),
    async (req: Request, res: Response) => {
      const principal = requirePrincipal();
      const body = req.body as Parameters<AudienceService['createSavedView']>[1];
      const view = await audience.createSavedView(requireScope(), {
        ...body,
        createdBy: principal.userId,
      });
      res.status(201).json({ data: view });
    },
  );

  // ----------------------------------------------------------------- exports

  /**
   * "Export" and "Export selected".
   *
   * 202, not 200: the row records the intent and a worker turns it into a
   * file, so nothing is ready when this returns. docs/03: "Long operations —
   * 202 Accepted with a resource whose status you poll."
   */
  router.post(
    '/exports',
    ...chain,
    runExport,
    validateBody(createExportSchema),
    async (req: Request, res: Response) => {
      const principal = requirePrincipal();
      const body = req.body as Parameters<AudienceService['startExport']>[1];
      const job = await audience.startExport(requireScope(), {
        ...body,
        requestedBy: principal.userId,
      });
      res.status(202).json({ data: job });
    },
  );

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

  /**
   * Bulk tag and untag, registered before every `/contacts/:id` route.
   *
   * Express matches in registration order, so `DELETE /contacts/:id` sitting
   * first swallowed `DELETE /contacts/tags` as a contact whose id is the
   * word "tags" — and answered 404 to every untag the browser ever sent.
   * These two must stay above the parameterised paths.
   */
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

  router.patch(
    '/lists/:id',
    ...chain,
    write,
    validateBody(renameListSchema),
    async (req: Request, res: Response) => {
      const list = await audience.renameList(
        requireScope(),
        req.params['id'] as ContactListId,
        req.body as { name: string; description?: string },
      );
      res.json({ data: list });
    },
  );

  /**
   * Archive, which is not delete.
   *
   * A campaign that sent to this list still names it, and a past campaign
   * whose audience has vanished cannot be audited. The card stays on D3,
   * greyed and read-only.
   */
  router.post('/lists/:id/archive', ...chain, write, async (req: Request, res: Response) => {
    const list = await audience.archiveList(requireScope(), req.params['id'] as ContactListId);
    res.json({ data: list });
  });

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

  /**
   * The merge routes come before `/tags/:id`.
   *
   * Express matches in registration order, so a `:id` parameter registered
   * first would swallow `merge` and `merge-preview` as tag ids. Neither
   * collides today — there is no GET or POST on `/tags/:id` — but the
   * ordering is the thing that keeps that true when one is added.
   */
  router.get('/tags/merge-preview', ...chain, read, async (req: Request, res: Response) => {
    const { ids } = parseQuery(mergePreviewQuerySchema, req);
    res.json({ data: await audience.mergePreview(requireScope(), ids) });
  });

  router.post(
    '/tags/merge',
    ...chain,
    write,
    validateBody(mergeTagsSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { keepId: string; mergeIds: string[] };
      res.json({ data: await audience.mergeTags(requireScope(), body) });
    },
  );

  router.patch(
    '/tags/:id',
    ...chain,
    write,
    validateBody(renameTagSchema),
    async (req: Request, res: Response) => {
      const tag = await audience.renameTag(
        requireScope(),
        req.params['id'] as TagId,
        req.body as { name?: string; color?: string },
      );
      res.json({ data: tag });
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

  /**
   * D5b's "Save changes".
   *
   * Registered before `/segments/:id/preview` is irrelevant — they differ
   * by method and by depth — but it sits beside DELETE so the two writes
   * that name one segment read together.
   */
  router.patch(
    '/segments/:id',
    ...chain,
    write,
    validateBody(updateSegmentSchema),
    async (req: Request, res: Response) => {
      const segment = await audience.updateSegment(
        requireScope(),
        req.params['id'] as SegmentId,
        req.body as { name?: string; definition?: unknown },
      );
      res.json({ data: segment });
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

  // Registered before `/suppressions` so the two literal paths are matched
  // as themselves, and so a reader looking for D7's summary finds it first.
  router.get('/suppressions/summary', ...chain, read, async (_req, res) => {
    res.json({ data: await audience.suppressionSummary(requireScope()) });
  });

  router.get('/suppressions/sources', ...chain, read, async (_req, res) => {
    res.json({ data: await audience.suppressionSources(requireScope()) });
  });

  /**
   * D7's table.
   *
   * The query is parsed and passed on: the chips used to be read, validated
   * and then dropped, so picking a reason changed the URL and returned the
   * same rows.
   */
  router.get('/suppressions', ...chain, read, async (req: Request, res: Response) => {
    const query = parseQuery(listSuppressionsQuerySchema, req);
    res.json({ data: await audience.listSuppressions(requireScope(), query) });
  });

  router.post(
    '/suppressions',
    ...chain,
    write,
    validateBody(createSuppressionSchema),
    async (req: Request, res: Response) => {
      const body = req.body as { email: string; reason: string; notes?: string };
      const { row, created } = await audience.addSuppression(requireScope(), body);
      // Already suppressed is the desired state, not a conflict — a bounce
      // handler must never fail because it ran twice. It answers 200 rather
      // than 201, with the suppression that already exists: a second body
      // shape here is a branch every caller would have to write.
      res.status(created ? 201 : 200).json({ data: row });
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
