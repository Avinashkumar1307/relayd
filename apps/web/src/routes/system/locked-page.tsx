import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { WORKSPACE_ROLES, can as roleCan, type Permission, type WorkspaceRole } from '@relayd/types';
import { Avatar, Button, Icon, PageHeader } from '@relayd/ui';
import { useAuth } from '../../auth/AuthProvider.js';
import { api } from '../../api/client.js';
import { breadcrumbFor } from '../../components/app-shell.js';
import { LinkButton } from './link-button.js';

/**
 * K3 — the locked page for a role that cannot open this one. I1c is the
 * same page reached through Billing.
 *
 * docs/09's rule, and CLAUDE.md section 11: a missing *permission* hides or
 * disables the action and says why. So this is not a 404 and not a bare
 * 403 — it names the role that holds the page, names the permission in
 * mono, and points at the person who can grant it. A non-member of the
 * workspace gets A4 instead; that distinction is the whole of section 11's
 * "404, never 403" rule and it is a different page.
 *
 * Everything the copy says is derived from the permission matrix in
 * `@relayd/types`, which is the same table the server enforces, so the page
 * cannot claim a role holds something it does not.
 */

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

const PLURAL: Record<WorkspaceRole, string> = {
  owner: 'Owners',
  admin: 'Admins',
  editor: 'Editors',
  viewer: 'Viewers',
};

/** "the Owner" / "the Owner or Admin" — the frame's phrasing, generalised. */
function holdersPhrase(roles: readonly WorkspaceRole[]): string {
  const labels = roles.map((role) => ROLE_LABEL[role]);
  if (labels.length <= 1) return `the ${labels[0] ?? 'Owner'}`;
  return `the ${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1] ?? ''}`;
}

/** "Admins and Viewers" — the other roles that see this same page. */
function othersPhrase(roles: readonly WorkspaceRole[]): string {
  const labels = roles.map((role) => PLURAL[role]);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;
}

interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
}

export interface LockedPageProps {
  permission: Permission;
  /** The page's own title, when it is not the one the navigation gives. */
  title?: string | undefined;
  description?: string | undefined;
}

export function LockedPage({ permission, title, description }: LockedPageProps) {
  const { current } = useAuth();
  const { pathname } = useLocation();

  const page = title ?? breadcrumbFor(pathname);
  const role = current?.role ?? null;
  const holders = WORKSPACE_ROLES.filter((candidate) => roleCan(candidate, permission));
  const others = WORKSPACE_ROLES.filter(
    (candidate) => !roleCan(candidate, permission) && candidate !== role,
  );

  // The Owner's name and address, so "ask the Owner" names a person. Every
  // role holds workspace:read, so this is readable by exactly the people who
  // are looking at this page.
  const members = useQuery({
    queryKey: ['workspace', 'current', 'members'],
    queryFn: () => api.get<Member[]>('/workspaces/current/members'),
    staleTime: 60_000,
    retry: false,
  });
  // A mocked or partial answer must not take this page down: it is the page
  // a user reaches when something already went wrong.
  const owner = Array.isArray(members.data)
    ? members.data.find((member) => member.role === 'owner')
    : undefined;

  // The *lowest*-privilege role that holds it: "this page needs the Admin
  // role" is actionable, "needs the Owner role" when an Admin would do is
  // not. `WORKSPACE_ROLES` runs owner → viewer, so the last match is it.
  const needed = holders[holders.length - 1] ?? 'owner';

  return (
    <>
      <PageHeader
        title={page}
        description={description ?? `${page} for ${current?.workspaceName ?? 'this workspace'}.`}
      />

      <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-surface px-6 py-16 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-card bg-neutral-soft text-text-2">
          <Icon name="lock" size={22} />
        </span>

        <div className="text-card font-semibold leading-heading">
          This page needs the {ROLE_LABEL[needed]} role
        </div>

        <div className="max-w-110 text-ui text-pretty text-text-2">
          {role === null ? null : (
            <>
              You are signed in as {article(ROLE_LABEL[role])}{' '}
              <span className="font-medium text-text">{ROLE_LABEL[role]}</span>.{' '}
            </>
          )}
          {page} requires{' '}
          <code className="rounded-4 bg-neutral-soft px-1.25 py-px font-mono text-label">{permission}</code>, which
          only {holdersPhrase(holders)} holds.
          {others.length === 0 ? null : (
            <> The same page appears for {othersPhrase(others)}, and for any other page a role cannot open.</>
          )}
        </div>

        {owner === undefined ? null : (
          <div className="mt-1.5 flex items-center gap-2.5 rounded-control border border-border bg-tint px-3.5 py-2.5 text-ui">
            <Avatar name={owner.name ?? owner.email} size={28} initials={initials(owner.name ?? owner.email)} />
            <span>
              Owner: <span className="font-medium">{owner.name ?? owner.email}</span> · {owner.email}
            </span>
          </div>
        )}

        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <LinkButton to="/settings/team">See what each role can do</LinkButton>
          <Button
            disabled={owner === undefined}
            title={owner === undefined ? 'The workspace owner is not readable from here' : undefined}
            onClick={() => {
              if (owner !== undefined) window.location.assign(`mailto:${owner.email}`);
            }}
          >
            Ask the Owner
          </Button>
        </div>
      </div>
    </>
  );
}

/** "an Editor", "a Viewer" — every role label but Viewer starts with a vowel. */
function article(label: string): 'a' | 'an' {
  return /^[AEIOU]/u.test(label) ? 'an' : 'a';
}

function initials(source: string): string {
  const words = source.trim().split(/\s+/u).filter((word) => word !== '');
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : source.slice(0, 2);
  return letters.toUpperCase();
}

/** The preview route for K3, on the permission I1c is locked by. */
export function LockedPreviewPage() {
  const { current } = useAuth();
  return (
    <LockedPage
      permission="billing:write"
      title="Billing"
      description={`Plan, usage and payment for ${current?.workspaceName ?? 'this workspace'}.`}
    />
  );
}
