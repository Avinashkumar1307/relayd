/**
 * Section B fixtures: the signed-in session and the invitation B5 opens.
 *
 * DEMO ONLY. Two memberships, so the workspace switcher in the shell has
 * something to switch between.
 */

export const WORKSPACE_ID = '0192f4a1-0000-7000-8000-000000000001';

export const session = {
  accessToken: 'demo-access-token',
  // design/sample-data.js signs the frames in as this person; the shell's
  // user row and D6c's consent line both read it.
  user: {
    id: '0192f4a1-0000-7000-8000-00000000000a',
    name: 'Dana Haddad',
    email: 'dana@northwind.travel',
  },
  memberships: [
    {
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Northwind Voyages',
      workspaceSlug: 'northwind-voyages',
      role: 'owner' as const,
    },
    {
      workspaceId: '0192f4a1-0000-7000-8000-000000000002',
      workspaceName: 'Northwind Labs',
      workspaceSlug: 'northwind-labs',
      role: 'admin' as const,
    },
  ],
};

/**
 * B5a and B5b — the invitation the token stands for.
 *
 * Every value is the one the frames print: Farah invites Omar as an Editor
 * on 18 Sep, and the link is good until 25 Sep. The same pair appears as a
 * pending invitation in J2a's team table, so the two screens agree about
 * who is waiting to join.
 */
export const invitation = {
  workspaceName: 'Northwind Voyages',
  workspaceMonogram: 'NV',
  inviterName: 'Farah Al-Mansoori',
  invitedAt: '2026-09-18T06:00:00.000Z',
  expiresAt: '2026-09-25T06:00:00.000Z',
  role: 'editor' as const,
  email: 'omar.h@northwind.travel',
};
