import { z } from 'zod';

/**
 * Template schemas.
 *
 * The HTML bound is 512 KB. Email clients truncate above roughly 100 KB and
 * Gmail clips at 102 KB, so a template larger than this is already broken —
 * the bound exists so a paste of a 40 MB document is a 400 rather than a
 * sanitiser run that holds the event loop.
 */

const MAX_HTML_BYTES = 512 * 1024;

export const createTemplateSchema = z
  .object({
    name: z.string().min(1).max(120).trim(),
    category: z.string().min(1).max(60).trim().optional(),
    subject: z.string().min(1).max(200),
    preheader: z.string().max(200).optional(),
    html: z.string().min(1).max(MAX_HTML_BYTES),
    /** Omitted means derive it from the HTML. */
    text: z.string().max(MAX_HTML_BYTES).optional(),
  })
  .strict();

export const saveTemplateVersionSchema = z
  .object({
    subject: z.string().min(1).max(200),
    preheader: z.string().max(200).optional(),
    html: z.string().min(1).max(MAX_HTML_BYTES),
    text: z.string().max(MAX_HTML_BYTES).optional(),
  })
  .strict();

export const renameTemplateSchema = z
  .object({ name: z.string().min(1).max(120).trim() })
  .strict();

/**
 * A preview against a chosen contact's values.
 *
 * Free-form rather than a contact id: an author previewing a template wants
 * to try "what if the first name is very long", and looking up a real contact
 * to do that is both slower and a way to read contact data through a route
 * that is not the contacts route.
 */
export const previewTemplateSchema = z
  .object({
    email: z.string().email().max(320).optional(),
    firstName: z.string().max(120).optional(),
    lastName: z.string().max(120).optional(),
    attributes: z.record(z.string().max(64), z.string().max(500)).optional(),
  })
  .strict();

export type CreateTemplateRequest = z.infer<typeof createTemplateSchema>;
export type SaveTemplateVersionRequest = z.infer<typeof saveTemplateVersionSchema>;
