import { z } from 'zod';
import { emailSchema } from './auth.js';

/**
 * Provider connection and sender schemas.
 *
 * Every object is .strict(): docs/06 requires unknown keys to be a 400 rather
 * than silently dropped. That matters more here than anywhere else in the API,
 * because these requests carry credentials and a silently-dropped field is a
 * credential the customer thinks they supplied.
 */

export const providerTypeSchema = z.enum(['ses', 'sendgrid', 'mailgun', 'brevo', 'smtp', 'google']);

/**
 * Credentials, per provider.
 *
 * A discriminated union so the API cannot be handed an SES key labelled as
 * SMTP. Each branch is .strict(), so a field the customer meant to send but
 * misspelled is a 400 rather than a connection that fails at launch.
 */
export const providerCredentialsSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ses'),
      accessKeyId: z.string().min(16).max(128),
      secretAccessKey: z.string().min(16).max(256),
      region: z
        .string()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u, 'Use an AWS region such as eu-west-1')
        .max(32),
    })
    .strict(),

  z
    .object({
      type: z.literal('sendgrid'),
      apiKey: z.string().min(16).max(256),
    })
    .strict(),

  z
    .object({
      type: z.literal('brevo'),
      apiKey: z.string().min(16).max(256),
    })
    .strict(),

  z
    .object({
      type: z.literal('mailgun'),
      apiKey: z.string().min(16).max(256),
      domain: z.string().min(3).max(253),
      // EU versus US is the misconfiguration docs/07 names for Mailgun, so
      // it is required rather than defaulted.
      region: z.enum(['us', 'eu']),
    })
    .strict(),

  z
    .object({
      type: z.literal('smtp'),
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
      user: z.string().min(1).max(320),
      pass: z.string().min(1).max(512),
    })
    .strict(),

  z
    .object({
      type: z.literal('google'),
      refreshToken: z.string().min(16).max(512),
      clientId: z.string().min(8).max(256),
      clientSecret: z.string().min(8).max(256),
    })
    .strict(),
]);

export const connectProviderSchema = z
  .object({
    providerType: providerTypeSchema,
    name: z.string().min(1).max(120).trim(),
    credentials: providerCredentialsSchema,
    /** Non-secret configuration only. The credential travels in `credentials`. */
    config: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
      .optional(),
  })
  .strict();

export const rotateCredentialsSchema = z
  .object({ credentials: providerCredentialsSchema })
  .strict();

export const renameConnectionSchema = z
  .object({ name: z.string().min(1).max(120).trim() })
  .strict();

export const createSenderSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    identityId: z.string().min(1).max(64),
    fromEmail: emailSchema,
    fromName: z.string().min(1).max(120).trim(),
    replyTo: emailSchema.optional(),
    /**
     * An operator ceiling, not a provider one. The send path still respects
     * whatever the provider permits — this can only ever lower it.
     */
    dailyLimit: z.number().int().positive().max(10_000_000).optional(),
    hourlyLimit: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export const updateSenderSchema = z
  .object({
    fromName: z.string().min(1).max(120).trim().optional(),
    replyTo: emailSchema.nullable().optional(),
    dailyLimit: z.number().int().positive().max(10_000_000).nullable().optional(),
    hourlyLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  })
  .strict();

/**
 * A test send.
 *
 * Capped at five recipients and to addresses the sender can reach: this
 * endpoint exists to prove a connection works, and an uncapped one is a way
 * to send mail that bypasses campaigns, suppression and metering.
 */
export const testSendSchema = z
  .object({
    senderId: z.string().min(1).max(64),
    to: z.array(emailSchema).min(1).max(5),
    subject: z.string().min(1).max(200).default('Relayd test message'),
  })
  .strict();

export type ConnectProviderRequest = z.infer<typeof connectProviderSchema>;
export type CreateSenderRequest = z.infer<typeof createSenderSchema>;
export type TestSendRequest = z.infer<typeof testSendSchema>;
