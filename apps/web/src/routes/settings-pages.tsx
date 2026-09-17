import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceRole } from '@relayd/types';
import { WORKSPACE_ROLES } from '@relayd/types';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { IfPermitted } from '../auth/guards.js';

/**
 * Settings pages.
 *
 * TanStack Query is the only server-state mechanism (CLAUDE.md section 2), so
 * there is no local mirror of anything the server owns — the cache is the
 * single copy, invalidated on mutation.
 */

interface WorkspaceDetails {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

interface Member {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

export function WorkspaceSettingsPage() {
  const queryClient = useQueryClient();
  const { can } = useAuth();

  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api.get<WorkspaceDetails>('/workspaces/current'),
  });

  const rename = useMutation({
    mutationFn: (name: string) => api.patch<WorkspaceDetails>('/workspaces/current', { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace'] }),
  });

  if (workspace.isPending) return <Loading />;
  if (workspace.isError) return <LoadError />;

  return (
    <Page title="Workspace">
      <dl className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        <Row label="Name" value={workspace.data.name} />
        <Row label="URL" value={workspace.data.slug} />
        <Row label="Time zone" value={workspace.data.timezone} />
      </dl>

      <IfPermitted
        permission="workspace:update"
        fallback={
          <p className="text-sm text-slate-500">
            Your role can view these settings but not change them.
          </p>
        }
      >
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const input = new FormData(event.currentTarget).get('name');
            if (typeof input === 'string' && input.trim() !== '') rename.mutate(input.trim());
          }}
        >
          <label className="sr-only" htmlFor="workspace-name">
            Workspace name
          </label>
          <input
            id="workspace-name"
            name="name"
            defaultValue={workspace.data.name}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={rename.isPending || !can('workspace:update')}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Save
          </button>
        </form>
      </IfPermitted>
    </Page>
  );
}

export function TeamSettingsPage() {
  const queryClient = useQueryClient();
  const { current } = useAuth();

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<Member[]>('/workspaces/current/members'),
  });

  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api.get<Invitation[]>('/workspaces/current/invitations'),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      api.patch(`/workspaces/current/members/${userId}`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members'] }),
  });

  const invite = useMutation({
    mutationFn: (input: { email: string; role: string }) =>
      api.post('/workspaces/current/invitations', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invitations'] }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/workspaces/current/invitations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invitations'] }),
  });

  if (members.isPending) return <Loading />;
  if (members.isError) return <LoadError />;

  return (
    <Page title="Team">
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-slate-800">Members</h2>
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {members.data.map((member) => (
            <li key={member.userId} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-slate-800">{member.userId}</span>
              <IfPermitted
                permission="member:invite"
                fallback={<span className="text-sm text-slate-500">{member.role}</span>}
              >
                <label className="sr-only" htmlFor={`role-${member.userId}`}>
                  Role for {member.userId}
                </label>
                <select
                  id={`role-${member.userId}`}
                  defaultValue={member.role}
                  disabled={changeRole.isPending || member.userId === current?.workspaceId}
                  onChange={(event) =>
                    changeRole.mutate({
                      userId: member.userId,
                      role: event.target.value as WorkspaceRole,
                    })
                  }
                  className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  {WORKSPACE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </IfPermitted>
            </li>
          ))}
        </ul>
      </section>

      <IfPermitted permission="member:invite">
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-slate-800">Invite someone</h2>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const email = data.get('email');
              const role = data.get('role');
              if (typeof email === 'string' && typeof role === 'string') {
                invite.mutate({ email, role });
                event.currentTarget.reset();
              }
            }}
          >
            <label className="sr-only" htmlFor="invite-email">
              Email to invite
            </label>
            <input
              id="invite-email"
              name="email"
              type="email"
              required
              placeholder="colleague@example.com"
              className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <label className="sr-only" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              name="role"
              defaultValue="editor"
              className="rounded-md border border-slate-300 px-2 py-2 text-sm"
            >
              {/* Owner is not invitable: ownership transfers, it is not emailed. */}
              <option value="admin">admin</option>
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
            </select>
            <button
              type="submit"
              disabled={invite.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              Invite
            </button>
          </form>

          {invitations.data !== undefined && invitations.data.length > 0 && (
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {invitations.data.map((invitation) => (
                <li key={invitation.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-slate-800">
                    {invitation.email}{' '}
                    <span className="text-slate-500">({invitation.role})</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => revoke.mutate(invitation.id)}
                    className="text-sm text-red-600 underline"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </IfPermitted>
    </Page>
  );
}

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between px-4 py-3">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900">{value}</dd>
    </div>
  );
}

function Loading() {
  return (
    <p role="status" className="px-6 py-10 text-sm text-slate-500">
      Loading…
    </p>
  );
}

function LoadError() {
  return (
    <p role="alert" className="px-6 py-10 text-sm text-red-600">
      That did not load. Refresh to try again.
    </p>
  );
}
