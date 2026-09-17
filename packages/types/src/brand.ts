/**
 * Nominal typing helper.
 *
 * Fifteen uuid-shaped things in one system means `findById(campaignId,
 * workspaceId)` with the arguments swapped compiles and silently does the
 * wrong thing. Branding makes that a type error.
 *
 * See docs/13-repo-and-coding-standards.md.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };
