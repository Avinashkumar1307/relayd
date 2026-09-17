/**
 * The static permission matrix from docs/06 section 15.
 *
 * Transcribed as a table rather than as scattered conditionals so it can be
 * read against the document row by row. docs/06 calls for "a static permission
 * matrix, checked by a decorator on every route" — this is the matrix; the
 * check is the authorization middleware.
 *
 * Lives in packages/types because both the API and the web app need it: the
 * server to enforce, the browser to hide controls a role cannot use. The
 * browser copy is presentation only. Every decision is re-made server-side
 * (CLAUDE.md section 10: "Entitlement checks are server-side only").
 */

export const WORKSPACE_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const PERMISSIONS = [
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'member:invite',
  'member:remove',
  'contact:read',
  'contact:write',
  'contact:import',
  'contact:export',
  'template:write',
  'campaign:write',
  'campaign:launch',
  'provider:read',
  'provider:write',
  'billing:read',
  'billing:write',
  'apikey:write',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * One row per permission, in the order docs/06 lists them.
 *
 * Two rows are load-bearing and called out in CLAUDE.md section 11:
 *
 *   campaign:launch is separate from campaign:write. An editor may build a
 *   campaign and may not send it to fifty thousand people.
 *
 *   billing:write is owner-only. Not admin. Money is the owner's alone.
 */
const MATRIX: Readonly<Record<Permission, readonly WorkspaceRole[]>> = {
  'workspace:read': ['owner', 'admin', 'editor', 'viewer'],
  'workspace:update': ['owner', 'admin'],
  'workspace:delete': ['owner'],
  'member:invite': ['owner', 'admin'],
  'member:remove': ['owner', 'admin'],
  'contact:read': ['owner', 'admin', 'editor', 'viewer'],
  'contact:write': ['owner', 'admin', 'editor'],
  'contact:import': ['owner', 'admin', 'editor'],
  'contact:export': ['owner', 'admin'],
  'template:write': ['owner', 'admin', 'editor'],
  'campaign:write': ['owner', 'admin', 'editor'],
  'campaign:launch': ['owner', 'admin'],
  'provider:read': ['owner', 'admin', 'editor', 'viewer'],
  'provider:write': ['owner', 'admin'],
  'billing:read': ['owner', 'admin'],
  'billing:write': ['owner'],
  'apikey:write': ['owner', 'admin'],
  'audit:read': ['owner', 'admin'],
};

function permissionsOf(role: WorkspaceRole): ReadonlySet<Permission> {
  return new Set(PERMISSIONS.filter((permission) => MATRIX[permission].includes(role)));
}

/** The matrix inverted, so a lookup is a set membership test rather than a scan. */
const BY_ROLE: Readonly<Record<WorkspaceRole, ReadonlySet<Permission>>> = {
  owner: permissionsOf('owner'),
  admin: permissionsOf('admin'),
  editor: permissionsOf('editor'),
  viewer: permissionsOf('viewer'),
};

/** Whether a role holds a permission. The whole authorization decision. */
export function can(role: WorkspaceRole, permission: Permission): boolean {
  return BY_ROLE[role].has(permission);
}

/** Every permission a role holds. Sent to the browser for UI gating. */
export function permissionsFor(role: WorkspaceRole): Permission[] {
  return [...BY_ROLE[role]];
}

/**
 * Permissions an API key may never carry, whatever the role of whoever minted
 * it (CLAUDE.md section 11: "billing:write is owner-only and can never be
 * attached to an API key").
 *
 * A leaked key must not be able to change a plan or a payment method. The
 * blast radius of a key is bounded at "can spend the plan you already have",
 * never "can change what you are paying".
 */
const API_KEY_FORBIDDEN: ReadonlySet<Permission> = new Set<Permission>(['billing:write']);

export function canApiKeyHold(permission: Permission): boolean {
  return !API_KEY_FORBIDDEN.has(permission);
}

/**
 * Filters a requested scope list down to what a key may actually hold, and
 * reports what was stripped so the caller can refuse rather than silently
 * issue a weaker key than was asked for.
 */
export function partitionApiKeyScopes(requested: readonly Permission[]): {
  allowed: Permission[];
  refused: Permission[];
} {
  const allowed: Permission[] = [];
  const refused: Permission[] = [];
  for (const permission of requested) {
    (canApiKeyHold(permission) ? allowed : refused).push(permission);
  }
  return { allowed, refused };
}
