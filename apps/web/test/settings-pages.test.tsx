// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Permission } from '@relayd/types';
import { configureApi } from '../src/api/client.js';
import { WorkspaceSettingsPage } from '../src/routes/settings/workspace.js';
import { TeamSettingsPage, parseInviteEmails } from '../src/routes/settings/team.js';
import { TeamPermissionsPage } from '../src/routes/settings/permissions.js';
import { ProfilePage } from '../src/routes/settings/profile.js';
import { AuditLogPage } from '../src/routes/settings/audit.js';
import { formatDate, formatDateTime } from '../src/routes/settings/workspace-parts.js';

/**
 * Section J, part one — workspace, team, permissions, profile and audit.
 *
 * What is asserted here is what a redesign quietly removes, and each one is
 * a rule from CLAUDE.md or from the frames:
 *
 *   the Owner's row carries no role picker and no Remove (section 11);
 *   `owner` is never an invitable role;
 *   a missing permission disables the control and says why, and a suspended
 *   workspace does the same to everybody (docs/09, K2);
 *   deleting a workspace needs the name typed exactly (the sheet);
 *   J2c is computed from `packages/types/src/permissions.ts` and not copied,
 *   so `billing:write` is Owner-only and an Editor can only *request* a
 *   launch;
 *   the audit log's times are rendered in the workspace's zone, because a
 *   log read in the wrong zone changes what somebody concludes.
 */

const responses = new Map<string, unknown>();
const sent: { method: string; url: string; body?: unknown }[] = [];

let role: { can: Permission[] } = {
  can: [
    'workspace:read',
    'workspace:update',
    'workspace:delete',
    'member:invite',
    'member:remove',
    'audit:read',
  ],
};

vi.mock('../src/auth/AuthProvider.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    memberships: [],
    currentWorkspaceId: 'ws_1',
    user: { id: 'usr_dana', name: 'Dana Haddad', email: 'dana@northwind.travel' },
    current: {
      workspaceId: 'ws_1',
      workspaceName: 'Northwind Voyages',
      workspaceSlug: 'northwind-voyages',
      role: 'owner',
    },
    permissions: role.can,
    can: (permission: Permission) => role.can.includes(permission),
    logout: async () => undefined,
  }),
}));

const WORKSPACE = {
  id: 'ws_nv_01HZ3K8Q',
  name: 'Northwind Voyages',
  slug: 'northwind-voyages',
  timezone: 'Asia/Dubai',
  role: 'owner',
  status: 'active',
  planName: 'Growth',
  seatLimit: 10,
  createdAt: '2026-02-14T06:00:00.000Z',
  createdByName: 'Dana Haddad',
  dataRegion: 'EU (Frankfurt)',
  analyticsRetentionMonths: 13,
  defaultSenderId: 'snd_hello',
  counts: { contacts: 48_213, campaigns: 126, providerConnections: 3 },
};

const MEMBERS = [
  {
    userId: 'usr_dana',
    name: 'Dana Haddad',
    email: 'dana@northwind.travel',
    role: 'owner',
    joinedAt: '2026-02-14T06:00:00.000Z',
    lastActiveLabel: 'Active now',
  },
  {
    userId: 'usr_farah',
    name: 'Farah Al-Mansoori',
    email: 'farah@northwind.travel',
    role: 'admin',
    joinedAt: '2026-03-01T06:00:00.000Z',
    lastActiveLabel: '2 hours ago',
  },
  {
    userId: 'usr_lena',
    name: 'Lena Bauer',
    email: 'lena@northwind.travel',
    role: 'viewer',
    joinedAt: '2026-07-01T06:00:00.000Z',
    lastActiveLabel: '28 Aug 2026',
  },
];

const INVITATIONS = [
  {
    id: 'inv_priya',
    email: 'priya.n@northwind.travel',
    role: 'editor',
    invitedByName: 'Farah Al-Mansoori',
    expiresAt: '2026-09-25T06:00:00.000Z',
  },
];

const SESSIONS = [
  {
    id: 'ses_mac',
    device: 'MacBook Pro 14"',
    deviceKind: 'desktop',
    client: 'Chrome 129 · macOS 15',
    location: 'Dubai, United Arab Emirates',
    ip: '94.204.118.22',
    lastActiveLabel: 'Active now',
    current: true,
  },
  {
    id: 'ses_iphone',
    device: 'iPhone 15',
    deviceKind: 'mobile',
    client: 'Relayd for iOS 2.4',
    location: 'Dubai, United Arab Emirates',
    ip: '94.204.118.22',
    lastActiveLabel: '2 hours ago',
    current: false,
  },
];

const AUDIT = {
  events: [
    {
      id: 'aud_01',
      occurredAt: '2026-09-19T06:42:18.000Z',
      actor: { kind: 'user', name: 'Dana Haddad', initials: 'DH' },
      action: 'api_key.revealed',
      resource: 'rk_live_7f3a…',
      details: 'Revealed once by the creator; masked permanently',
    },
    {
      id: 'aud_02',
      occurredAt: '2026-09-19T05:00:02.000Z',
      actor: { kind: 'system', name: 'Relayd', initials: 'R' },
      action: 'campaign.launched',
      resource: 'cmp_8f3k2a',
      details: 'Autumn Escapes · 48,213 recipients · approved launch executed',
    },
  ],
  total: 3412,
};

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();
  sent.length = 0;
  role = {
    can: [
      'workspace:read',
      'workspace:update',
      'workspace:delete',
      'member:invite',
      'member:remove',
      'audit:read',
    ],
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      sent.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });

      // Longest matching pattern wins, so "/workspaces/current/members" is
      // not answered by the stub for "/workspaces/current".
      const match = [...responses.entries()]
        .filter(([pattern]) => {
          const [patternMethod, patternPath] = pattern.split(' ');
          return method === patternMethod && url.includes(String(patternPath));
        })
        .sort((a, b) => b[0].length - a[0].length)[0];

      if (match === undefined) {
        return new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'no stub', requestId: 'req_stub' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }

      const body = match[1];
      if (typeof body === 'object' && body !== null && '__error' in body) {
        const error = body as { __error: { status: number; body: unknown } };
        return new Response(JSON.stringify(error.__error.body), {
          status: error.__error.status,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ data: body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(children: ReactNode, path = '/settings/workspace') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/workspace" element={children} />
          <Route path="/settings/team" element={children} />
          <Route path="/settings/team/permissions" element={children} />
          <Route path="/settings/profile" element={children} />
          <Route path="/settings/audit" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function workspaceStubs(patch: Record<string, unknown> = {}) {
  responses.set('GET /workspaces/current/members', MEMBERS);
  responses.set('GET /workspaces/current/invitations', INVITATIONS);
  responses.set('GET /workspaces/current', { ...WORKSPACE, ...patch });
  responses.set('GET /senders', [
    { id: 'snd_hello', fromName: 'Northwind Voyages', fromEmail: 'hello@northwind.travel', status: 'verified' },
  ]);
}

/* ================================================================== */
/* J1 — /settings/workspace                                            */
/* ================================================================== */

describe('the workspace settings page (J1)', () => {
  it('shows the editable fields and the read-only identifiers', async () => {
    workspaceStubs();
    wrap(<WorkspaceSettingsPage />);

    expect(await screen.findByText('Name, URL, timezone and default sender for Northwind Voyages.')).toBeTruthy();
    expect((screen.getByLabelText('Workspace name') as HTMLInputElement).value).toBe('Northwind Voyages');
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('northwind-voyages');
    expect(screen.getByText('app.relayd.io/')).toBeTruthy();
    expect(screen.getByText('Changing the slug breaks bookmarked links; API IDs stay the same.')).toBeTruthy();

    // The read-only card, which is the point of the second block.
    expect(screen.getByText('Read-only identifiers for support and the API.')).toBeTruthy();
    expect(screen.getByText('14 Feb 2026 by Dana Haddad')).toBeTruthy();
    expect(
      screen.getByText('EU (Frankfurt) · analytics retained 13 months on Growth'),
    ).toBeTruthy();
  });

  /**
   * Only the two fields the server will accept.
   *
   * `updateWorkspaceSchema` is `.strict()` and takes `name` and `timezone`, so
   * a body carrying `slug` or `defaultSenderId` is a 400 that loses the
   * rename along with them. Both of those are drawn read-only until the API
   * can store them — see `workspaceApi.update`.
   */
  it('saves the two fields the API accepts, and nothing else', async () => {
    workspaceStubs();
    responses.set('PATCH /workspaces/current', WORKSPACE);
    wrap(<WorkspaceSettingsPage />);

    const name = (await screen.findByLabelText('Workspace name')) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, 'Northwind Travel');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patch = sent.find((request) => request.method === 'PATCH');
      expect(patch?.body).toEqual({ name: 'Northwind Travel', timezone: 'Asia/Dubai' });
    });
  });

  it('does not offer to edit a slug or a default sender it cannot save', async () => {
    workspaceStubs();
    wrap(<WorkspaceSettingsPage />);

    const slug = (await screen.findByLabelText('Slug')) as HTMLInputElement;
    expect(slug.disabled).toBe(true);
    expect(slug.title).toBe('Renaming the workspace URL is not available yet');

    const sender = screen.getByLabelText('Default sender') as HTMLSelectElement;
    expect(sender.disabled).toBe(true);
  });

  it('disables every write and says why when the role cannot update', async () => {
    role = { can: ['workspace:read'] };
    workspaceStubs();
    wrap(<WorkspaceSettingsPage />);

    const name = (await screen.findByLabelText('Workspace name')) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(name.title).toBe('Your role cannot change workspace settings');

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(save.getAttribute('title')).toBe('Your role cannot change workspace settings');
  });

  it('is read-only for everyone when the workspace is suspended (K2)', async () => {
    workspaceStubs({ status: 'suspended' });
    wrap(<WorkspaceSettingsPage />);

    await waitFor(() => {
      const save = screen.getByRole('button', { name: 'Save changes' });
      expect(save.getAttribute('title')).toBe('Workspace is read-only');
    });
    expect(
      (screen.getByRole('button', { name: 'Delete workspace' })).getAttribute('title'),
    ).toBe('Workspace is read-only');
  });

  it('will not delete the workspace until the name is typed exactly', async () => {
    workspaceStubs();
    wrap(<WorkspaceSettingsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete workspace' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete workspace?')).toBeTruthy();
    // The numbers, not "all your data": a number is what makes somebody stop.
    expect(
      within(dialog).getByText(/Permanently deletes 48,213 contacts, 126 campaigns, 3 provider connections/u),
    ).toBeTruthy();

    const confirm = within(dialog).getByRole('button', { name: 'Delete workspace' });
    expect(confirm.hasAttribute('disabled')).toBe(true);

    await userEvent.type(within(dialog).getByLabelText('Workspace name'), 'northwind voyages');
    expect(confirm.hasAttribute('disabled')).toBe(true);

    await userEvent.clear(within(dialog).getByLabelText('Workspace name'));
    await userEvent.type(within(dialog).getByLabelText('Workspace name'), 'Northwind Voyages');
    expect(confirm.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the danger zone shut for an admin, who is not the owner', async () => {
    role = { can: ['workspace:read', 'workspace:update', 'member:invite'] };
    workspaceStubs();
    wrap(<WorkspaceSettingsPage />);

    const remove = await screen.findByRole('button', { name: 'Delete workspace' });
    expect(remove.hasAttribute('disabled')).toBe(true);
    expect(remove.getAttribute('title')).toBe('Owner only');
  });
});

/* ================================================================== */
/* J2a / J2b — /settings/team                                          */
/* ================================================================== */

describe('the team page (J2a)', () => {
  it('summarises the team and lists every member', async () => {
    workspaceStubs();
    wrap(<TeamSettingsPage />, '/settings/team');

    expect(await screen.findByText('3 members · 1 pending · 10 seats on Growth')).toBeTruthy();

    const members = within(screen.getByRole('table', { name: 'Members' }));
    expect(members.getByText('Farah Al-Mansoori')).toBeTruthy();
    expect(members.getByText('farah@northwind.travel')).toBeTruthy();
    expect(members.getByText('28 Aug 2026')).toBeTruthy();

    // J2a draws the invitations under the members on the same tab.
    const invitations = within(screen.getByRole('table', { name: 'Pending invitations' }));
    expect(invitations.getByText('priya.n@northwind.travel')).toBeTruthy();
    expect(invitations.getByText('25 Sep 2026')).toBeTruthy();
  });

  it('marks your own row and gives the owner neither a role picker nor Remove', async () => {
    workspaceStubs();
    wrap(<TeamSettingsPage />, '/settings/team');

    expect(await screen.findByText('You')).toBeTruthy();
    expect(screen.queryByLabelText('Role for Dana Haddad')).toBe(null);
    // One Remove per non-owner member.
    expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBe(MEMBERS.length - 1);
  });

  it('changes a role through PATCH on that member', async () => {
    workspaceStubs();
    responses.set('PATCH /workspaces/current/members/usr_farah', { ...MEMBERS[1], role: 'editor' });
    wrap(<TeamSettingsPage />, '/settings/team');

    await userEvent.selectOptions(
      await screen.findByLabelText('Role for Farah Al-Mansoori'),
      'editor',
    );

    await waitFor(() => {
      const patch = sent.find((request) => request.url.includes('/members/usr_farah'));
      expect(patch?.method).toBe('PATCH');
      expect(patch?.body).toEqual({ role: 'editor' });
    });
  });

  it('never offers Owner as an invitable role, and says where ownership comes from', async () => {
    workspaceStubs();
    wrap(<TeamSettingsPage />, '/settings/team');

    await userEvent.click(await screen.findByRole('button', { name: 'Invite member' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('They get an email link that works for 7 days. 6 of 10 seats free.')).toBeTruthy();
    expect(within(dialog).getAllByRole('radio').length).toBe(3);
    expect(within(dialog).queryByText('Owner')).toBe(null);
    expect(
      within(dialog).getByText('Ownership is transferred from Workspace settings, not by invitation.'),
    ).toBeTruthy();
  });

  it('counts the addresses in the send button and posts one invitation each', async () => {
    workspaceStubs();
    responses.set('POST /workspaces/current/invitations', INVITATIONS[0]);
    wrap(<TeamSettingsPage />, '/settings/team');

    await userEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.type(
      within(dialog).getByLabelText('Email addresses'),
      'priya.n@northwind.travel, k.lindqvist@northwind.travel',
    );

    const send = await within(dialog).findByRole('button', { name: 'Send 2 invitations' });
    await userEvent.click(send);

    await waitFor(() => {
      const posts = sent.filter(
        (request) => request.method === 'POST' && request.url.includes('/invitations'),
      );
      expect(posts.length).toBe(2);
      expect(posts[0]?.body).toEqual({ email: 'priya.n@northwind.travel', role: 'editor' });
    });
  });

  it('splits an address list on commas and whitespace', () => {
    expect(parseInviteEmails('a@b.com, c@d.com')).toEqual(['a@b.com', 'c@d.com']);
    expect(parseInviteEmails('  a@b.com \n c@d.com ,')).toEqual(['a@b.com', 'c@d.com']);
    expect(parseInviteEmails('   ')).toEqual([]);
  });

  it('disables inviting, resending and revoking when the workspace is read-only', async () => {
    workspaceStubs({ status: 'suspended' });
    wrap(<TeamSettingsPage />, '/settings/team');

    await waitFor(() => {
      const invite = screen.getByRole('button', { name: 'Invite member' });
      expect(invite.getAttribute('title')).toBe('Workspace is read-only');
    });
    expect(screen.getByRole('button', { name: 'Revoke' }).getAttribute('title')).toBe(
      'Workspace is read-only',
    );
    // K2's other half: the data stays visible.
    expect(screen.getByText('priya.n@northwind.travel')).toBeTruthy();
  });
});

/* ================================================================== */
/* J2c — /settings/team/permissions                                    */
/* ================================================================== */

describe('the permission matrix (J2c)', () => {
  function cells(rowLabel: string): string[] {
    const heading = screen.getByText(rowLabel);
    const row = heading.closest('tr');
    if (row === null) throw new Error(`no row for ${rowLabel}`);
    return [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '');
  }

  it('is computed from the matrix, not copied: billing:write is the owner alone', async () => {
    workspaceStubs();
    wrap(<TeamPermissionsPage />, '/settings/team/permissions');

    await screen.findByText('What each role can do. Roles are fixed; there are no custom roles.');

    expect(cells('billing:write — change plan, payment method, cancel')).toEqual([
      'Allowed',
      'Not allowed',
      'Not allowed',
      'Not allowed',
    ]);
  });

  it('shows an editor requesting a launch rather than being refused one', async () => {
    workspaceStubs();
    wrap(<TeamPermissionsPage />, '/settings/team/permissions');

    await screen.findByText('Launch, pause, resume, cancel campaigns');
    expect(cells('Launch, pause, resume, cancel campaigns')).toEqual([
      'Allowed',
      'Allowed',
      'RequestCan request',
      'Not allowed',
    ]);
  });

  it('gives a viewer the read row and nothing else', async () => {
    workspaceStubs();
    wrap(<TeamPermissionsPage />, '/settings/team/permissions');

    await screen.findByText('View dashboard, campaigns and reports');
    expect(cells('View dashboard, campaigns and reports')[3]).toBe('Allowed');
    expect(cells('Manage audience: contacts, lists, tags, segments, imports, suppressions')[3]).toBe(
      'Not allowed',
    );
  });
});

/* ================================================================== */
/* J5 — /settings/profile                                              */
/* ================================================================== */

describe('the profile page (J5)', () => {
  function profileStubs() {
    responses.set('GET /me/sessions', SESSIONS);
    responses.set('GET /me', {
      id: 'usr_dana',
      name: 'Dana Haddad',
      email: 'dana@northwind.travel',
      emailVerified: true,
    });
  }

  it('shows the account and its sessions, and never offers to revoke this one', async () => {
    profileStubs();
    wrap(<ProfilePage />, '/settings/profile');

    expect(await screen.findByText('Your account across all workspaces.')).toBeTruthy();
    expect(((await screen.findByLabelText('Full name')) as HTMLInputElement).value).toBe('Dana Haddad');
    expect(screen.getByText('Verified')).toBeTruthy();

    expect(await screen.findByText('MacBook Pro 14"')).toBeTruthy();
    expect(screen.getByText('This device')).toBeTruthy();
    // One session is this one; only the other can be revoked.
    expect(screen.getAllByRole('button', { name: 'Revoke' }).length).toBe(1);
  });

  it('revokes one session through its own endpoint', async () => {
    profileStubs();
    responses.set('DELETE /me/sessions/ses_iphone', {});
    wrap(<ProfilePage />, '/settings/profile');

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      const call = sent.find((request) => request.method === 'DELETE');
      expect(call?.url).toContain('/me/sessions/ses_iphone');
    });
  });

  it('refuses a password change that does not confirm, and says so on the field', async () => {
    profileStubs();
    wrap(<ProfilePage />, '/settings/profile');

    await userEvent.type(await screen.findByLabelText('Current password'), 'old-password-1');
    await userEvent.type(screen.getByLabelText('New password'), 'a-long-enough-one');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a-different-one!');
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('The two new passwords do not match.')).toBeTruthy();
    expect(sent.some((request) => request.url.includes('/me/password'))).toBe(false);
  });

  it('says out loud that changing a password ends every other session', async () => {
    profileStubs();
    wrap(<ProfilePage />, '/settings/profile');

    expect(
      await screen.findByText('Changing your password signs out every other session.'),
    ).toBeTruthy();
  });
});

/* ================================================================== */
/* J6 — /settings/audit                                                */
/* ================================================================== */

describe('the audit log (J6)', () => {
  function auditStubs(page: unknown = AUDIT) {
    workspaceStubs();
    responses.set('GET /audit-logs/filters', {
      actors: [{ id: 'Dana Haddad', name: 'Dana Haddad' }],
      actions: ['campaign.launched'],
    });
    responses.set('GET /audit-logs', page);
  }

  it('lists the events in the workspace timezone and counts them all', async () => {
    auditStubs();
    wrap(<AuditLogPage />, '/settings/audit');

    // 06:42:18Z is 10:42:18 in Asia/Dubai. That is the whole point of the
    // "Times in Asia/Dubai" line in the description.
    expect(await screen.findByText('19 Sep 2026, 10:42:18')).toBeTruthy();

    const table = within(screen.getByRole('table', { name: 'Audit log' }));
    expect(table.getByText('campaign.launched')).toBeTruthy();
    expect(table.getByText('cmp_8f3k2a')).toBeTruthy();
    expect(table.getByText('Relayd')).toBeTruthy();
    // The count is the server's, not `rows.length`.
    expect(screen.getByText('3,412')).toBeTruthy();
    expect(
      screen.getByText(
        'Every change made by a person, an API key or Relayd itself. Retained 13 months on Growth. Times in Asia/Dubai.',
      ),
    ).toBeTruthy();
  });

  it('offers to clear the filters when they match nothing (J6e)', async () => {
    auditStubs({ events: [], total: 0 });
    wrap(<AuditLogPage />, '/settings/audit?range=all');

    expect(await screen.findByText('No events match these filters')).toBeTruthy();
    expect(
      screen.getByText(
        'Try a wider date range or clear the resource filter. Events are retained 13 months on Growth.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  it('carries the request id when it fails (J6f)', async () => {
    workspaceStubs();
    responses.set('GET /audit-logs', {
      __error: {
        status: 500,
        body: { error: { code: 'internal_error', message: 'nope', requestId: 'req_01J9J6FK3VQ7M2' } },
      },
    });
    wrap(<AuditLogPage />, '/settings/audit');

    expect(await screen.findByText("We couldn't load the audit log")).toBeTruthy();
    expect(
      screen.getByText(
        'Nothing was lost; events are written before any action completes. Send support the request ID if it keeps happening.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('req_01J9J6FK3VQ7M2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('puts a chosen filter in the query string, so a row can be linked', async () => {
    auditStubs();
    wrap(<AuditLogPage />, '/settings/audit');

    await userEvent.selectOptions(await screen.findByLabelText('Filter by date'), 'last_7');

    await waitFor(() => {
      expect(sent.some((request) => request.url.includes('range=last_7'))).toBe(true);
    });
  });
});

/* ================================================================== */
/* Formatting                                                          */
/* ================================================================== */

describe('the date helpers', () => {
  it('abbreviates September to Sep, which en-GB does not', () => {
    expect(formatDate('2026-09-25T06:00:00.000Z', 'Asia/Dubai')).toBe('25 Sep 2026');
    expect(formatDate('2026-02-14T06:00:00.000Z', 'Asia/Dubai')).toBe('14 Feb 2026');
  });

  it('renders a time in the workspace zone, not the reader own zone', () => {
    expect(formatDateTime('2026-09-19T06:42:18.000Z', 'Asia/Dubai')).toBe('19 Sep 2026, 10:42:18');
    expect(formatDateTime('2026-09-19T06:42:18.000Z', 'UTC')).toBe('19 Sep 2026, 06:42:18');
  });

  it('falls back to UTC rather than throwing on an unknown zone', () => {
    expect(formatDate('2026-09-19T06:42:18.000Z', 'Mars/Olympus')).toBe('19 Sep 2026');
  });
});

/* ================================================================== */
/* J5 — Appearance                                                     */
/* ================================================================== */

/**
 * The one section on J5 with no frame behind it: the export has dark
 * variants (C2, G3d, G4b, F2c) and draws no control for reaching them, so
 * this was added deliberately — docs/16-self-review-and-decisions.md,
 * 2026-09-20.
 *
 * What is asserted is what makes it a *device* preference rather than
 * account data: three choices with System among them, System stored as the
 * absence of the key, and the whole thing working with no shell mounted and
 * no request in flight for it.
 */
describe('appearance on the profile page (J5)', () => {
  const THEME_KEY = 'relayd.theme';

  function profileStubs() {
    responses.set('GET /me/sessions', SESSIONS);
    responses.set('GET /me', {
      id: 'usr_dana',
      name: 'Dana Haddad',
      email: 'dana@northwind.travel',
      emailVerified: true,
    });
  }

  function forget() {
    window.localStorage.removeItem(THEME_KEY);
    document.documentElement.removeAttribute('data-theme');
  }

  beforeEach(forget);
  afterEach(forget);

  /** The page on its own: no `Shell`, so no sidebar control and no session. */
  async function group() {
    profileStubs();
    wrap(<ProfilePage />, '/settings/profile');
    await screen.findByRole('heading', { name: 'Appearance' });
    return screen.getByRole('radiogroup', { name: 'Theme' });
  }

  it('offers System, Light and Dark, and marks System when nothing is stored', async () => {
    const options = within(await group()).getAllByRole('radio');

    expect(options.map((option) => option.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('says that System follows the device and that the choice stays in this browser', async () => {
    await group();

    const explanation = screen.getByText(/System follows your device/);
    expect(explanation.textContent).toContain('light or dark setting and changes with it');
    expect(explanation.textContent).toContain('Saved in this browser only');
    expect(explanation.textContent).toContain('not part of your account');
  });

  it('paints the app dark the moment Dark is chosen, and remembers it', async () => {
    const control = await group();

    await userEvent.click(within(control).getByRole('radio', { name: 'Dark' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(within(control).getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
  });

  it('stores System as no key at all, so an unset preference has one representation', async () => {
    window.localStorage.setItem(THEME_KEY, 'dark');
    const control = await group();

    expect(within(control).getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');

    await userEvent.click(within(control).getByRole('radio', { name: 'System' }));

    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    // jsdom reports no `prefers-color-scheme: dark`, so System resolves light.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('never asks the server about it', async () => {
    const control = await group();

    await userEvent.click(within(control).getByRole('radio', { name: 'Light' }));

    expect(sent.some((request) => request.method !== 'GET')).toBe(false);
  });
});
