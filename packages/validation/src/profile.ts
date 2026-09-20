import { z } from 'zod';

/**
 * Request schemas for the signed-in person: `/me` and the account half of
 * `/auth`.
 *
 * Shared by api and web so the browser validates against exactly what the
 * server will enforce. Every object is `.strict()` for the same reason the
 * /auth schemas are: docs/06 requires an unknown key to be a 400 rather than
 * be silently dropped, which is what stops a mass-assignment bug from being
 * invisible.
 */

import { emailSchema, passwordSchema } from './auth.js';

/**
 * The only field of the profile a person may change directly.
 *
 * Email is deliberately absent: it is an identity, not an attribute, and
 * moving it takes a round trip through the new address
 * (`startEmailChangeSchema` below). A `PATCH /me { email }` that just wrote
 * the column would turn a borrowed laptop into an account takeover.
 */
export const updateProfileSchema = z
  .object({ name: z.string().min(1).max(120).trim() })
  .strict();

/**
 * Changing a password re-proves the current one.
 *
 * The access token says the browser was signed in at some point; it does not
 * say the person at the keyboard is the account holder. The current password
 * is what closes that gap, and it is why this is not simply `PATCH /me`.
 *
 * `currentPassword` is `min(1)` rather than `passwordSchema`: it is compared
 * against a stored hash, and applying today's length rule to it would reject
 * an older password before the comparison could fail honestly.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
  })
  .strict();

/** Starting an email change, which also re-proves the current password. */
export const startEmailChangeSchema = z
  .object({
    newEmail: emailSchema,
    currentPassword: z.string().min(1).max(256),
  })
  .strict();

/**
 * Asking for the verification email again.
 *
 * The address is optional because B3a is reachable both signed in (where the
 * server knows who is asking) and from a link with only `?email=` on it. The
 * server answers identically either way — see the route.
 */
export const resendVerificationSchema = z
  .object({ email: emailSchema.optional() })
  .strict();

export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;
export type StartEmailChangeRequest = z.infer<typeof startEmailChangeSchema>;
