import { z } from 'zod';

/**
 * Campaign request schemas.
 *
 * Zod at every boundary (CLAUDE.md §6.1). These run in both `apps/api` and
 * `apps/web`, which is why they live here: a form that validates differently
 * from the endpoint it posts to produces errors the user cannot act on,
 * because the message they see was written for a different rule.
 */

const uuid = z.string().uuid();

/** Subject lines: long enough for anything real, short enough to reject paste accidents. */
const subject = z.string().trim().min(1).max(500);

export const audienceSchema = z
  .object({
    listIds: z.array(uuid).max(50).default([]),
    segmentIds: z.array(uuid).max(50).default([]),
    /** Contacts to exclude regardless of the lists above. */
    excludeListIds: z.array(uuid).max(50).default([]),
  })
  .refine(
    (value) => value.listIds.length > 0 || value.segmentIds.length > 0,
    // A campaign with only exclusions is empty by construction, and the
    // launch pre-flight would refuse it several steps later with a message
    // about the snapshot rather than about the audience.
    { message: 'Choose at least one list or segment' },
  );

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  subject: subject.optional(),
  preheader: z.string().trim().max(500).optional(),
  fromName: z.string().trim().max(200).optional(),
  fromEmail: z.string().trim().email().optional(),
  replyTo: z.string().trim().email().optional(),
  templateId: uuid.optional(),
  senderAccountId: uuid.optional(),
  sendingPoolId: uuid.optional(),
  audience: audienceSchema.optional(),
});

export const updateCampaignSchema = createCampaignSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Nothing to update' },
);

export const scheduleCampaignSchema = z.object({
  /**
   * Stored as timestamptz, computed at schedule time from the user's
   * wall-clock input plus the campaign's timezone. "Send at 9am in the
   * recipient's timezone" is a different feature and is out of MVP.
   */
  scheduledAt: z.coerce.date(),
  timezone: z.string().trim().min(1).max(64),
});

export const launchCampaignSchema = z.object({
  /**
   * The consent attestation docs/06 requires at launch, not only at import.
   * A customer who imported a list six months ago is attesting about the list
   * they are mailing today.
   */
  consentAttested: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you have consent to email this audience' }),
  }),
});

export const testSendSchema = z.object({
  to: z.array(z.string().trim().email()).min(1).max(5),
});

export const cloneCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
});

export const listCampaignsSchema = z.object({
  state: z.string().trim().max(40).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().max(500).optional(),
});

export const listRecipientsSchema = z.object({
  state: z.string().trim().max(40).optional(),
  deliveryState: z.string().trim().max(40).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().max(500).optional(),
});

export const createPoolSchema = z.object({
  name: z.string().trim().min(1).max(200),
  strategy: z.enum(['round_robin', 'weighted', 'failover', 'least_loaded']).default('round_robin'),
});

export const updatePoolSchema = createPoolSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Nothing to update' },
);

export const addPoolMemberSchema = z.object({
  senderAccountId: uuid,
  /** Failover order. Lower goes first. */
  priority: z.number().int().min(0).max(1000).default(0),
  weight: z.number().int().min(1).max(1000).default(1),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type ScheduleCampaignInput = z.infer<typeof scheduleCampaignSchema>;
export type ListCampaignsInput = z.infer<typeof listCampaignsSchema>;
export type ListRecipientsInput = z.infer<typeof listRecipientsSchema>;
export type CreatePoolInput = z.infer<typeof createPoolSchema>;
export type AddPoolMemberInput = z.infer<typeof addPoolMemberSchema>;
