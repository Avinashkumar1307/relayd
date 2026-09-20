import { z } from 'zod';
import { passwordSchema, workspaceSlugSchema } from './auth.js';

/**
 * Request schemas for creating a workspace, transferring it, and joining one
 * by invitation.
 *
 * Shared by api and web so the browser validates against exactly what the
 * server enforces. Every object is `.strict()` for the reason the /auth
 * schemas are: docs/06 wants an unknown key to be a 400 rather than silently
 * dropped, which is what keeps a mass-assignment bug visible.
 */

/**
 * B6a sends a name, the slug it derived from that name, and a timezone.
 *
 * The slug is validated rather than trusted, with the same rule registration
 * uses (`workspaceSlugSchema`), so the two ways a workspace can be created
 * cannot drift into accepting different URLs.
 */
export const createWorkspaceSchema = z
  .object({
    name: z.string().min(1, 'Name your workspace').max(120).trim(),
    slug: workspaceSlugSchema,
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * Joining by invitation, signed out (B5b).
 *
 * No email field: the address is fixed by the token, and accepting one with a
 * different address is not the same offer. Letting the client send an address
 * here would be a way to register under someone else's invitation.
 */
export const registerViaInvitationSchema = z
  .object({
    name: z.string().min(1, 'Enter your name').max(120).trim(),
    password: passwordSchema,
  })
  .strict();

/** Ownership moves to exactly one named member (J2). */
export const transferOwnershipSchema = z
  .object({ userId: z.string().uuid() })
  .strict();

export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceSchema>;
export type RegisterViaInvitationRequest = z.infer<typeof registerViaInvitationSchema>;
export type TransferOwnershipRequest = z.infer<typeof transferOwnershipSchema>;
