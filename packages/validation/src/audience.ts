import { z } from 'zod';
import { CONSENT_SOURCE_VALUES } from './campaigns.js';
import { emailSchema } from './auth.js';

/**
 * Audience request schemas, shared by api and web.
 *
 * Every object is .strict(): docs/06 requires unknown keys to be a 400 rather
 * than silently dropped, which is what turns a mass-assignment attempt into a
 * visible error instead of an invisible one.
 */

/**
 * Custom attributes.
 *
 * docs/03 caps them at 50 keys and 8 KB. Both limits are enforced here rather
 * than at the database, because the failure mode without them is not a
 * rejected row — it is a jsonb column that grows until the gin index stops
 * fitting in memory and every segment preview slows down for everyone.
 */
export const contactAttributesSchema = z
  .record(z.string().min(1).max(64), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 50, {
    message: 'At most 50 custom attributes',
  })
  .refine((value) => JSON.stringify(value).length <= 8192, {
    message: 'Custom attributes must be under 8 KB in total',
  });

export const consentSchema = z
  .object({
    status: z.enum(['unknown', 'single_optin', 'double_optin', 'imported_declared']),
    source: z.string().min(1).max(200).optional(),
    at: z.coerce.date().optional(),
  })
  .strict();

export const createContactSchema = z
  .object({
    email: emailSchema,
    firstName: z.string().max(120).trim().optional(),
    lastName: z.string().max(120).trim().optional(),
    attributes: contactAttributesSchema.optional(),
    listIds: z.array(z.string().min(1).max(64)).max(50).optional(),
    tagIds: z.array(z.string().min(1).max(64)).max(50).optional(),
    consent: consentSchema.optional(),
    /** Upsert semantics, per docs/03. Defaults on: every integration wants it. */
    updateIfExists: z.boolean().default(true),
  })
  .strict();

export const updateContactSchema = z
  .object({
    firstName: z.string().max(120).trim().optional(),
    lastName: z.string().max(120).trim().optional(),
    status: z
      .enum(['subscribed', 'unsubscribed', 'bounced', 'complained', 'cleaned'])
      .optional(),
    attributes: contactAttributesSchema.optional(),
  })
  .strict();

/**
 * A saved view's slug, and the value `?view=` carries.
 *
 * Lowercase kebab so it is safe in a URL without escaping, and so two views
 * cannot differ only by case and produce two tabs that look identical.
 */
export const savedViewKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Use lowercase letters, numbers and hyphens');

/**
 * The keys D1 draws itself, before any saved view.
 *
 * Reserved at creation: a saved view called `all` would render a second tab
 * that looks exactly like the first one and filters differently.
 */
export const BASE_VIEW_KEYS = ['all', 'subscribed'] as const;

/** D1's search box. Trimmed, because " " is not a search. */
const contactSearchSchema = z.string().trim().max(200);

export const listContactsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(512).optional(),
    status: z
      .enum(['subscribed', 'unsubscribed', 'bounced', 'complained', 'cleaned'])
      .optional(),
    /**
     * A saved view's key. Resolved server-side to the filter it stores, so a
     * view cannot be a way to send a predicate the list endpoint would not
     * otherwise accept.
     */
    view: savedViewKeySchema.optional(),
    q: contactSearchSchema.optional(),
  })
  .strict();

/**
 * The filter a saved view stores.
 *
 * Deliberately the subset of `listContactsQuerySchema` that describes *what*
 * rather than *where in the page*: a stored cursor would be a position in a
 * result set that no longer exists, and a stored limit would override the
 * reader's own choice every time they opened the tab.
 */
export const savedViewFiltersSchema = z
  .object({
    status: z
      .enum(['subscribed', 'unsubscribed', 'bounced', 'complained', 'cleaned'])
      .optional(),
    q: contactSearchSchema.optional(),
  })
  .strict();

export const createSavedViewSchema = z
  .object({
    label: z.string().min(1).max(60).trim(),
    filters: savedViewFiltersSchema.default({}),
  })
  .strict();

/** PATCH bodies. `.strict()`, so an unknown field is a 400 rather than a no-op. */
export const renameListSchema = z
  .object({
    name: z.string().min(1).max(120).trim(),
    description: z.string().max(500).trim().optional(),
  })
  .strict();

export const renameTagSchema = z
  .object({
    name: z.string().min(1).max(60).trim().optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/u, 'Use a hex colour like #3b82f6')
      .optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: 'Give a name or a colour to change',
  });

/**
 * Merging tags.
 *
 * Capped at 50 losers: the merge is one transaction over `contact_tags`, and
 * an unbounded list is how one request locks an entire audience's tag rows.
 * `keepId` may not appear in `mergeIds` — merging a tag into itself would
 * delete the survivor at step four.
 */
export const mergeTagsSchema = z
  .object({
    keepId: z.string().min(1).max(64),
    mergeIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  })
  .strict()
  .refine((value) => !value.mergeIds.includes(value.keepId), {
    path: ['mergeIds'],
    message: 'The tag being kept cannot also be merged away',
  });

/** `?ids=a,b,c` — what the merge dialog polls the preview with. */
export const mergePreviewQuerySchema = z
  .object({
    ids: z
      .string()
      .min(1)
      .max(3000)
      .transform((value) => value.split(',').map((id) => id.trim()).filter((id) => id !== ''))
      .pipe(z.array(z.string().min(1).max(64)).min(2).max(50)),
  })
  .strict();

/**
 * Starting an export.
 *
 * `ids` is the "Export selected" case and is capped at the same 1,000 as
 * every other bulk operation. Beyond that the user wants a filtered export,
 * which is what `filters` is for.
 */
export const createExportSchema = z
  .object({
    resource: z.enum(['contacts', 'suppressions', 'lists', 'tags', 'segments']),
    ids: z.array(z.string().min(1).max(64)).max(1000).optional(),
    filters: z.record(z.string().max(40), z.string().max(200)).optional(),
  })
  .strict();

export const listSuppressionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    reason: z
      .enum(['unsubscribe', 'hard_bounce', 'complaint', 'manual', 'global_block', 'invalid'])
      .optional(),
    source: z.string().min(1).max(64).optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * Bulk tag and untag.
 *
 * Capped at 1,000 ids per request. Unbounded bulk endpoints are how a single
 * request becomes a minutes-long transaction holding locks across an entire
 * audience; anything larger belongs in an import.
 */
export const bulkTagSchema = z
  .object({
    contactIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
    tagId: z.string().min(1).max(64),
  })
  .strict();

export const listMembershipSchema = z
  .object({
    contactIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
  })
  .strict();

export const createListSchema = z
  .object({
    name: z.string().min(1).max(120).trim(),
    description: z.string().max(500).trim().optional(),
  })
  .strict();

export const createTagSchema = z
  .object({
    name: z.string().min(1).max(60).trim(),
    /** Hex colour, so the UI cannot be handed arbitrary CSS. */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/u, 'Use a hex colour like #3b82f6')
      .optional(),
  })
  .strict();

/**
 * A segment definition is validated structurally here and semantically by
 * @relayd/audience, which owns the operator set and the depth and node caps.
 * Keeping the deep validation in one place means the API and the compiler
 * cannot disagree about what is legal.
 */
export const createSegmentSchema = z
  .object({
    name: z.string().min(1).max(120).trim(),
    definition: z.unknown(),
  })
  .strict();

export const createSuppressionSchema = z
  .object({
    email: emailSchema,
    reason: z.enum(['unsubscribe', 'hard_bounce', 'complaint', 'manual', 'invalid']).default('manual'),
    notes: z.string().max(500).optional(),
  })
  .strict();

export const bulkSuppressionSchema = z
  .object({
    emails: z.array(emailSchema).min(1).max(1000),
    reason: z.enum(['unsubscribe', 'hard_bounce', 'complaint', 'manual', 'invalid']).default('manual'),
  })
  .strict();

/** 100 MB, matching the streaming importer's design point. */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

export const createImportSchema = z
  .object({
    filename: z.string().min(1).max(255),
    byteSize: z.number().int().positive().max(MAX_IMPORT_BYTES),
    fileType: z.enum(['csv', 'tsv', 'xlsx']),
  })
  .strict();

export const importMappingSchema = z
  .object({
    /** Source column name to contact field. */
    mapping: z.record(z.string().min(1).max(200), z.string().min(1).max(64)),
    options: z
      .object({
        updateExisting: z.boolean().default(true),
        addToListIds: z.array(z.string().min(1).max(64)).max(20).default([]),
        tagIds: z.array(z.string().min(1).max(64)).max(20).default([]),
        /**
         * Mandatory, and recorded on every contact the import creates.
         *
         * docs/02: "the importer must assert where consent came from. This is
         * what lets you defend a workspace when a provider or a regulator
         * asks, and it is what lets you suspend a workspace that lied."
         */
        consentDeclaration: z.string().min(10).max(500),
        /**
         * The declared source, from the same vocabulary a launch uses.
         *
         * docs/06 asks for "a declared consent source" at import and the
         * same thing again at launch. `consentDeclaration` above is the
         * sender's own words, copied onto every contact; this is the value
         * that makes "how many workspaces claim to be importing from a
         * previous provider" a GROUP BY rather than a reading exercise.
         */
        consentSource: z.enum(CONSENT_SOURCE_VALUES, {
          errorMap: () => ({ message: 'Choose where these contacts gave consent' }),
        }),
      })
      .strict(),
  })
  .strict();

export type CreateContactRequest = z.infer<typeof createContactSchema>;
export type UpdateContactRequest = z.infer<typeof updateContactSchema>;
export type CreateImportRequest = z.infer<typeof createImportSchema>;
export type ImportMappingRequest = z.infer<typeof importMappingSchema>;
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
export type SavedViewFilters = z.infer<typeof savedViewFiltersSchema>;
export type CreateSavedViewRequest = z.infer<typeof createSavedViewSchema>;
export type MergeTagsRequest = z.infer<typeof mergeTagsSchema>;
export type CreateExportRequest = z.infer<typeof createExportSchema>;
export type ListSuppressionsQuery = z.infer<typeof listSuppressionsQuerySchema>;

/**
 * Turns a label into a view key: "Recently bounced" → "recently-bounced".
 *
 * Shared rather than done in the browser, so a view created through the API
 * and one created from the "+ Save view" button get the same key for the
 * same words. The trailing counter is the caller's job: this function is
 * pure and has no idea what is already taken.
 */
export function savedViewKeyFor(label: string): string {
  const key = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '');

  // A label of nothing but punctuation still needs a key, and "view" is
  // better than an empty string that would fail the pattern.
  return key === '' ? 'view' : key;
}
