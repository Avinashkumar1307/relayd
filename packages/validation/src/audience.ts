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

export const listContactsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(512).optional(),
    status: z
      .enum(['subscribed', 'unsubscribed', 'bounced', 'complained', 'cleaned'])
      .optional(),
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
