import { z } from 'zod';

/**
 * Request schemas for /auth, shared by api and web so the browser validates
 * against exactly what the server will enforce.
 *
 * Every object is .strict(): docs/06 requires unknown keys to be a 400 rather
 * than silently dropped, which is what stops a mass-assignment bug from being
 * invisible.
 */

/**
 * Minimum length only. docs/06 specifies argon2id and rate limits; it sets no
 * composition rules, and character-class requirements are known to push users
 * toward predictable substitutions. Length is the property that matters.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password must be at most 256 characters');

/**
 * Trim and lowercase BEFORE validating.
 *
 * Order matters: Zod applies string checks and transforms in declaration
 * order, so validating first would reject "  Aisha@Example.COM " outright
 * instead of normalising it. Addresses arrive padded from autofill and copy
 * and paste constantly, and citext plus this normalisation is what keeps one
 * person from holding two accounts.
 */
export const emailSchema = z.string().trim().toLowerCase().email().max(320);

/** Lowercase, url-safe, and not confusable with a uuid path segment. */
export const workspaceSlugSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Use lowercase letters, numbers and hyphens');

/**
 * Creating an account, with or without a first workspace.
 *
 * B2 "Create your account" collects a name, an address and a password and
 * nothing else — B6a `/workspaces/new` is where a workspace is named — so the
 * workspace pair is optional. It is still accepted, because the one-shot form
 * (a seed script, a test, an integration that wants both in one call) is a
 * real caller and splitting it would cost a round trip.
 *
 * Both or neither. A `workspaceName` with no slug is a request the server
 * would have to invent half of, and a slug is the workspace's public URL —
 * not something to guess from a display name behind the caller's back.
 */
export const registerSchema = z
  .object({
    email: emailSchema,
    name: z.string().min(1).max(120).trim(),
    password: passwordSchema,
    workspaceName: z.string().min(1).max(120).trim().optional(),
    workspaceSlug: workspaceSlugSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.workspaceName === undefined) === (value.workspaceSlug === undefined)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.workspaceName === undefined ? 'workspaceName' : 'workspaceSlug'],
      message: 'Send both workspaceName and workspaceSlug, or neither',
    });
  });

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(256),
  })
  .strict();

export const verifyEmailSchema = z.object({ token: z.string().min(1).max(512) }).strict();

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1).max(512),
    password: passwordSchema,
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;
