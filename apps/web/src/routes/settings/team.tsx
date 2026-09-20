import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  Avatar,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  PageHeader,
  RadioCard,
  RadioGroup,
  TableSkeleton,
  Tabs,
  type Column,
} from '@relayd/ui';
import { WORKSPACE_ROLES, type WorkspaceRole } from '@relayd/types';
import { ApiError } from '../../api/client.js';
import {
  workspaceApi,
  workspaceKeys,
  type WorkspaceInvitation,
  type WorkspaceMember,
} from '../../api/workspace.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  InlineSelect,
  READ_ONLY_TITLE,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  RolePill,
  SectionHeading,
  formatDate,
  useSafeToast,
} from './workspace-parts.js';

/**
 * J2a and J2b — /settings/team.
 *
 * Members and pending invitations, and the invite dialog over them. The
 * third tab, Permissions, is a page of its own (J2c) rather than a panel:
 * it is a reference table people link each other to.
 *
 * Two rules from CLAUDE.md section 11 are visible on this page and are
 * asserted in the tests rather than left to a reviewer's memory:
 *
 *   the Owner's row has no role picker and no Remove — ownership transfers
 *   from Workspace settings, and an Admin cannot demote the person who pays;
 *
 *   `owner` is not an invitable role, so the dialog offers three, and the
 *   frame says why underneath.
 */

type TeamTab = 'members' | 'invitations' | 'permissions';

/** Two letters for the avatar. Never guessed from an email local part. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter((word) => word !== '');
  const first = words[0]?.[0] ?? '';
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : (words[0]?.[1] ?? '');
  return `${first}${second}`.toUpperCase();
}

function displayName(member: WorkspaceMember): string {
  return member.name ?? member.email ?? member.userId;
}

export function TeamSettingsPage({ tab = 'members' }: { tab?: TeamTab }) {
  const navigate = useNavigate();
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';

  const [active, setActive] = useState<TeamTab>(tab);
  const [inviteOpen, setInviteOpen] = useState(false);

  const workspace = useQuery({
    queryKey: workspaceKeys.details(workspaceId),
    queryFn: () => workspaceApi.details(),
  });
  const members = useQuery({
    queryKey: workspaceKeys.members(workspaceId),
    queryFn: () => workspaceApi.members(),
  });
  const invitations = useQuery({
    queryKey: workspaceKeys.invitations(workspaceId),
    queryFn: () => workspaceApi.invitations(),
  });

  const memberRows = members.data ?? [];
  const inviteRows = invitations.data ?? [];
  const seatLimit = workspace.data?.seatLimit;
  const planName = workspace.data?.planName;

  const summary = [
    `${memberRows.length} member${memberRows.length === 1 ? '' : 's'}`,
    `${inviteRows.length} pending`,
    seatLimit === undefined
      ? null
      : `${seatLimit} seats${planName === undefined ? '' : ` on ${planName}`}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const header = (
    <PageHeader
      title="Team"
      description={summary}
      actions={<InviteButton onOpen={() => setInviteOpen(true)} />}
      tabs={
        <Tabs
          label="Team"
          variant="page"
          value={active}
          onChange={(key) => {
            if (key === 'permissions') {
              void navigate('/settings/team/permissions');
              return;
            }
            setActive(key as TeamTab);
          }}
          items={[
            { key: 'members', label: 'Members', count: memberRows.length },
            { key: 'invitations', label: 'Invitations', count: inviteRows.length },
            { key: 'permissions', label: 'Permissions' },
          ]}
        />
      }
    />
  );

  if (members.isPending) {
    return (
      <>
        {header}
        <TableSkeleton rows={6} tabs={false} label="Loading team" />
      </>
    );
  }

  if (members.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="We couldn't load the team"
          description="Nobody's access changed. Send support the request ID if it keeps happening."
          requestId={members.error instanceof ApiError ? members.error.requestId : undefined}
          onRetry={() => void members.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  return (
    <>
      {header}

      {active === 'members' ? (
        <>
          <MembersTable members={memberRows} workspaceId={workspaceId} />
          <div className="mt-7">
            <SectionHeading
              title="Pending invitations"
              actions={<span className="text-caption text-text-2">Invitations expire after 7 days</span>}
            />
            <InvitationsTable
              invitations={inviteRows}
              workspaceId={workspaceId}
              timezone={workspace.data?.timezone ?? 'UTC'}
              onInvite={() => setInviteOpen(true)}
            />
          </div>
        </>
      ) : (
        <InvitationsTable
          invitations={inviteRows}
          workspaceId={workspaceId}
          timezone={workspace.data?.timezone ?? 'UTC'}
          onInvite={() => setInviteOpen(true)}
        />
      )}

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        workspaceId={workspaceId}
        seatsFree={seatLimit === undefined ? null : seatLimit - memberRows.length - inviteRows.length}
        seatLimit={seatLimit ?? null}
      />
    </>
  );
}

function InviteButton({ onOpen }: { onOpen: () => void }) {
  const { can } = useAuth();
  const readOnly = useReadOnly();

  const mayInvite = can('member:invite');
  const disabled = !mayInvite || readOnly;
  const reason = readOnly ? READ_ONLY_TITLE : mayInvite ? undefined : 'Your role cannot invite people';

  return (
    <Button disabled={disabled} {...(reason === undefined ? {} : { title: reason })} onClick={onOpen}>
      <Icon name="plus" size={15} strokeWidth={2.25} />
      Invite member
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

function MembersTable({ members, workspaceId }: { members: readonly WorkspaceMember[]; workspaceId: string }) {
  const queryClient = useQueryClient();
  const toast = useSafeToast();
  const { can, user } = useAuth();
  const readOnly = useReadOnly();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: workspaceKeys.members(workspaceId) });

  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: WorkspaceRole }) =>
      workspaceApi.changeRole(input.userId, input.role),
    onSuccess: async () => {
      toast.toast({ tone: 'success', title: 'Role updated' });
      await invalidate();
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not work',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => workspaceApi.removeMember(userId),
    onSuccess: async () => {
      toast.toast({ tone: 'success', title: 'Member removed' });
      await invalidate();
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not work',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const mayManage = can('member:invite');
  const mayRemove = can('member:remove');

  const reasonFor = (may: boolean, missing: string): string | undefined =>
    readOnly ? READ_ONLY_TITLE : may ? undefined : missing;

  const columns: readonly Column<WorkspaceMember>[] = [
    {
      key: 'member',
      header: 'Member',
      width: '34%',
      cell: (member) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar initials={initialsOf(displayName(member))} name={displayName(member)} size={30} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{displayName(member)}</span>
            {member.userId === user?.id ? (
              <span className="block text-caption text-text-2">You</span>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      width: '31%',
      cell: (member) => <span className="block truncate text-text-2">{member.email ?? '—'}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      width: '180px',
      cell: (member) =>
        member.role === 'owner' ? (
          <span className="inline-flex h-7 items-center rounded-control border border-border bg-surface px-2.5 text-ui">
            Owner
          </span>
        ) : (
          <InlineSelect
            label={`Role for ${displayName(member)}`}
            value={member.role}
            disabled={!mayManage || readOnly || changeRole.isPending}
            {...(reasonFor(mayManage, 'Your role cannot change roles') === undefined
              ? {}
              : { title: reasonFor(mayManage, 'Your role cannot change roles') })}
            onChange={(event) =>
              changeRole.mutate({ userId: member.userId, role: event.target.value as WorkspaceRole })
            }
          >
            {WORKSPACE_ROLES.filter((role) => role !== 'owner').map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </InlineSelect>
        ),
    },
    {
      key: 'lastActive',
      header: 'Last active',
      width: '150px',
      cell: (member) => <span className="whitespace-nowrap text-text-2">{member.lastActiveLabel ?? '—'}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: '120px',
      align: 'right',
      cell: (member) =>
        member.role === 'owner' ? (
          <span className="text-caption text-text-3">Owner</span>
        ) : (
          <button
            type="button"
            disabled={!mayRemove || readOnly || removeMember.isPending}
            title={reasonFor(mayRemove, 'Your role cannot remove people')}
            onClick={() => removeMember.mutate(member.userId)}
            className="h-7 cursor-pointer rounded-badge border border-border bg-surface px-2 text-caption font-medium text-text-2 hover:bg-tint disabled:cursor-not-allowed disabled:text-text-3"
          >
            Remove
          </button>
        ),
    },
  ];

  return (
    <DataTable
      label="Members"
      columns={columns}
      rows={members}
      rowKey={(member) => member.userId}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Invitations                                                         */
/* ------------------------------------------------------------------ */

function InvitationsTable({
  invitations,
  workspaceId,
  timezone,
  onInvite,
}: {
  invitations: readonly WorkspaceInvitation[];
  workspaceId: string;
  timezone: string;
  onInvite: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useSafeToast();
  const { can } = useAuth();
  const readOnly = useReadOnly();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: workspaceKeys.invitations(workspaceId) });

  const resend = useMutation({
    mutationFn: (id: string) => workspaceApi.resendInvitation(id),
    onSuccess: () => toast.toast({ tone: 'success', title: 'Invitation resent' }),
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not work',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => workspaceApi.revokeInvitation(id),
    onSuccess: async () => {
      toast.toast({ tone: 'success', title: 'Invitation revoked' });
      await invalidate();
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not work',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const mayManage = can('member:invite');
  const disabled = !mayManage || readOnly;
  const reason = readOnly ? READ_ONLY_TITLE : mayManage ? undefined : 'Your role cannot manage invitations';

  if (invitations.length === 0) {
    return (
      <EmptyState
        icon="team"
        size="table"
        title="No pending invitations"
        description="Everyone you have invited has joined. Invitations expire after 7 days."
        action={
          <Button disabled={disabled} {...(reason === undefined ? {} : { title: reason })} onClick={onInvite}>
            Invite member
          </Button>
        }
      />
    );
  }

  const columns: readonly Column<WorkspaceInvitation>[] = [
    {
      key: 'email',
      header: 'Email',
      width: '32%',
      cell: (invitation) => <span className="block truncate font-medium">{invitation.email}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      width: '140px',
      cell: (invitation) => <RolePill role={invitation.role} />,
    },
    {
      key: 'invitedBy',
      header: 'Invited by',
      width: '23%',
      cell: (invitation) => <span className="text-text-2">{invitation.invitedByName ?? '—'}</span>,
    },
    {
      key: 'expires',
      header: 'Expires',
      width: '160px',
      cell: (invitation) => (
        <span className="text-text-2">{formatDate(invitation.expiresAt, timezone)}</span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      width: '170px',
      align: 'right',
      cell: (invitation) => (
        <span className="flex justify-end gap-1.5">
          <button
            type="button"
            disabled={disabled || resend.isPending}
            title={reason}
            onClick={() => resend.mutate(invitation.id)}
            className="h-7 cursor-pointer rounded-badge border border-border bg-surface px-2 text-caption font-medium text-text hover:bg-tint disabled:cursor-not-allowed disabled:text-text-3"
          >
            Resend
          </button>
          <button
            type="button"
            disabled={disabled || revoke.isPending}
            title={reason}
            onClick={() => revoke.mutate(invitation.id)}
            className="h-7 cursor-pointer rounded-badge border border-border bg-surface px-2 text-caption font-medium text-danger-text hover:bg-tint disabled:cursor-not-allowed disabled:text-text-3"
          >
            Revoke
          </button>
        </span>
      ),
    },
  ];

  return (
    <DataTable
      label="Pending invitations"
      columns={columns}
      rows={invitations}
      rowKey={(invitation) => invitation.id}
    />
  );
}

/* ------------------------------------------------------------------ */
/* J2b — the invite dialog                                             */
/* ------------------------------------------------------------------ */

const INVITABLE_ROLES = WORKSPACE_ROLES.filter(
  (role): role is Exclude<WorkspaceRole, 'owner'> => role !== 'owner',
);

/** J2b takes a comma-separated list and gives everyone the same role. */
export function parseInviteEmails(value: string): string[] {
  return value
    .split(/[,\s]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function InviteModal({
  open,
  onClose,
  workspaceId,
  seatsFree,
  seatLimit,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  seatsFree: number | null;
  seatLimit: number | null;
}) {
  const queryClient = useQueryClient();
  const toast = useSafeToast();

  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<Exclude<WorkspaceRole, 'owner'>>('editor');
  const [error, setError] = useState<string | undefined>(undefined);

  const parsed = parseInviteEmails(emails);

  const invite = useMutation({
    mutationFn: async () => {
      for (const email of parsed) await workspaceApi.invite({ email, role });
    },
    onSuccess: async () => {
      toast.toast({
        tone: 'success',
        title: parsed.length === 1 ? 'Invitation sent' : `${parsed.length} invitations sent`,
      });
      setEmails('');
      setError(undefined);
      onClose();
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.invitations(workspaceId) });
    },
    onError: (failure: unknown) =>
      setError(failure instanceof ApiError ? failure.message : 'That did not send. Try again.'),
  });

  const seats =
    seatsFree === null || seatLimit === null ? '' : ` ${seatsFree} of ${seatLimit} seats free.`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a member"
      description={`They get an email link that works for 7 days.${seats}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={parsed.length === 0}
            pending={invite.isPending}
            {...(parsed.length === 0 ? { title: 'Add at least one email address' } : {})}
            onClick={() => invite.mutate()}
          >
            {parsed.length > 1 ? `Send ${parsed.length} invitations` : 'Send invitation'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Email addresses"
          value={emails}
          error={error}
          help="Separate several with commas. Everyone gets the same role."
          placeholder="colleague@example.com"
          onChange={(event) => setEmails(event.target.value)}
        />

        <div className="flex flex-col gap-1.5">
          <RadioGroup
            label="Role"
            value={role}
            onChange={(next) => setRole(next as Exclude<WorkspaceRole, 'owner'>)}
          >
            {INVITABLE_ROLES.map((option) => (
              <RadioCard
                key={option}
                value={option}
                density="compact"
                label={ROLE_LABEL[option]}
                description={ROLE_DESCRIPTION[option]}
              />
            ))}
          </RadioGroup>
          <span className="text-caption text-text-2">
            Ownership is transferred from Workspace settings, not by invitation.
          </span>
        </div>
      </div>
    </Modal>
  );
}
