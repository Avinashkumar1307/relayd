import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  Button,
  Card,
  ConfirmDestructive,
  DetailSkeleton,
  ErrorState,
  Field,
  Modal,
  Mono,
  PageHeader,
  RadioCard,
  RadioGroup,
  Select,
  inputClass,
} from '@relayd/ui';
import type { WorkspaceRole } from '@relayd/types';
import { ApiError } from '../../api/client.js';
import { workspaceApi, workspaceKeys, type WorkspaceDetails } from '../../api/workspace.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { WORKSPACE_QUERY_KEY } from '../../auth/workspace-state.js';
import {
  DetailRow,
  READ_ONLY_TITLE,
  ROLE_LABEL,
  SectionHeading,
  formatDate,
  useSafeToast,
} from './workspace-parts.js';

/**
 * J1 — /settings/workspace.
 *
 * Three blocks, in the frame's order: what can be changed, what can only be
 * read, and what cannot be undone. The last one is a separate card with a
 * danger border because the frame draws it that way and because the two
 * actions in it are the only ones in the product that destroy a tenant.
 *
 * Read-only (K2) and permission are different answers to different
 * questions and are kept apart: a Viewer sees the settings and cannot edit
 * them (docs/09 — the control is disabled and says why), and a suspended
 * workspace disables the same controls for everyone including the Owner.
 */

/**
 * The zones the picker offers.
 *
 * A curated list, not `Intl.supportedValuesOf('timeZone')`: J1 labels the
 * zone with its abbreviation and offset ("Asia/Dubai · GST (UTC+4)") and
 * neither is derivable from the IANA name. The workspace's own zone is
 * always added below, so a workspace on a zone that is not in this list
 * never has its setting silently rewritten by opening the page.
 */
const TIMEZONES: readonly { value: string; label: string }[] = [
  { value: 'Asia/Dubai', label: 'Asia/Dubai · GST (UTC+4)' },
  { value: 'Europe/London', label: 'Europe/London · GMT (UTC+0)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin · CET (UTC+1)' },
  { value: 'Europe/Lisbon', label: 'Europe/Lisbon · WET (UTC+0)' },
  { value: 'America/New_York', label: 'America/New_York · EST (UTC-5)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles · PST (UTC-8)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore · SGT (UTC+8)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney · AEDT (UTC+11)' },
  { value: 'UTC', label: 'UTC · (UTC+0)' },
];

interface FormState {
  name: string;
  slug: string;
  timezone: string;
  defaultSenderId: string;
}

function toForm(workspace: WorkspaceDetails): FormState {
  return {
    name: workspace.name,
    slug: workspace.slug,
    timezone: workspace.timezone,
    defaultSenderId: workspace.defaultSenderId ?? '',
  };
}

export function WorkspaceSettingsPage() {
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';

  const workspace = useQuery({
    queryKey: workspaceKeys.details(workspaceId),
    queryFn: () => workspaceApi.details(),
  });

  const header = (
    <PageHeader
      title="Workspace"
      description={`Name, URL, timezone and default sender for ${workspace.data?.name ?? 'this workspace'}.`}
    />
  );

  if (workspace.isPending) {
    return (
      <>
        {header}
        <DetailSkeleton label="Loading workspace settings" />
      </>
    );
  }

  if (workspace.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="We couldn't load workspace settings"
          description="Nothing was changed. Send support the request ID if it keeps happening."
          requestId={workspace.error instanceof ApiError ? workspace.error.requestId : undefined}
          onRetry={() => void workspace.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  return (
    <div className="max-w-[880px]">
      {header}
      <DetailsForm workspace={workspace.data} workspaceId={workspaceId} />
      <ReadOnlyDetails workspace={workspace.data} />
      <DangerZone workspace={workspace.data} workspaceId={workspaceId} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The editable card                                                   */
/* ------------------------------------------------------------------ */

function DetailsForm({ workspace, workspaceId }: { workspace: WorkspaceDetails; workspaceId: string }) {
  const queryClient = useQueryClient();
  const toast = useSafeToast();
  const { can } = useAuth();
  const readOnly = useReadOnly();

  const [form, setForm] = useState<FormState>(() => toForm(workspace));

  // The server's copy wins whenever it changes under us — another tab, or
  // the mutation below. Without this the form would keep showing what was
  // typed before a failed save.
  useEffect(() => {
    setForm(toForm(workspace));
  }, [workspace]);

  const senders = useQuery({
    queryKey: workspaceKeys.senders(workspaceId),
    queryFn: () => workspaceApi.senders(),
  });

  const save = useMutation({
    // Name and timezone only. The slug and the default sender are drawn
    // because J1 draws them, and are read-only until the server can accept
    // them — see `workspaceApi.update`. Sending them anyway would 400 the
    // whole request on a strict schema and lose the rename too.
    mutationFn: () => workspaceApi.update({ name: form.name.trim(), timezone: form.timezone }),
    onSuccess: async () => {
      toast.toast({ tone: 'success', title: 'Workspace updated' });
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.details(workspaceId) });
      await queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not save',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const mayEdit = can('workspace:update');
  const disabled = !mayEdit || readOnly;
  const reason = readOnly
    ? READ_ONLY_TITLE
    : mayEdit
      ? undefined
      : 'Your role cannot change workspace settings';

  // Only the two fields Save can actually send. Counting the read-only ones
  // would light the button up for an edit that is silently discarded, which
  // is worse than the field being obviously not editable.
  const dirty = form.name !== workspace.name || form.timezone !== workspace.timezone;

  const zones = TIMEZONES.some((zone) => zone.value === workspace.timezone)
    ? TIMEZONES
    : [...TIMEZONES, { value: workspace.timezone, label: workspace.timezone }];

  // The frame says "Only verified senders are listed", and which senders
  // are verified is the server's answer, not a string this page matches on:
  // section H owns the status vocabulary and it is still moving.
  // BACKEND PENDING — field: `GET /senders` exists but takes no `verified`
  // filter, so this lists every sender the workspace has.
  const verified = senders.data ?? [];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && dirty) save.mutate();
      }}
    >
      <Card flush className="grid grid-cols-1 gap-5 p-6 md:grid-cols-2 md:gap-x-6">
        <Field
          label="Workspace name"
          value={form.name}
          disabled={disabled}
          title={reason}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />

        <div className="flex flex-col gap-1.5 text-ui">
          <label htmlFor="workspace-slug" className="font-medium text-text">
            Slug
          </label>
          <span className="flex h-9 items-center overflow-hidden rounded-control border border-border">
            <span className="flex h-full items-center border-r border-border bg-tint px-2.5 font-mono text-caption text-text-2">
              app.relayd.io/
            </span>
            {/* Read-only until the server can answer "is this slug taken"
                across tenants — see `workspaceApi.update`. Shown, because J1
                shows it and the value is the workspace's public URL. */}
            <input
              id="workspace-slug"
              value={form.slug}
              disabled
              readOnly
              title="Renaming the workspace URL is not available yet"
              aria-describedby="workspace-slug-help"
              onChange={(event) => setForm({ ...form, slug: event.target.value })}
              className="h-full min-w-0 flex-1 border-0 bg-surface px-3 font-mono text-caption text-text outline-none disabled:cursor-not-allowed disabled:bg-tint disabled:text-text-3"
            />
          </span>
          <span id="workspace-slug-help" className="text-caption text-text-2">
            Changing the slug breaks bookmarked links; API IDs stay the same.
          </span>
        </div>

        <Select
          label="Timezone"
          value={form.timezone}
          disabled={disabled}
          title={reason}
          help="Schedules, reports and audit times use this zone."
          onChange={(event) => setForm({ ...form, timezone: event.target.value })}
        >
          {zones.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </Select>

        {/* Read-only for now: `workspaces` has no default-sender column, so
            a choice made here has nowhere to be written. */}
        <Select
          label="Default sender"
          value={form.defaultSenderId}
          disabled
          title="Choosing a workspace default sender is not available yet"
          help="Pre-selected in new campaigns. Only verified senders are listed."
          onChange={(event) => setForm({ ...form, defaultSenderId: event.target.value })}
        >
          <option value="">No default sender</option>
          {verified.map((sender) => (
            <option key={sender.id} value={sender.id}>
              {sender.fromName} &lt;{sender.fromEmail}&gt;
            </option>
          ))}
        </Select>

        {/* Both buttons stay live while the form is editable, as J1 draws
            them; a Save with nothing changed is a no-op, and a button that
            greys itself out the moment a field is put back is noise. */}
        <div className="flex justify-end gap-2 border-t border-border pt-4 md:col-span-2">
          <Button
            variant="secondary"
            disabled={disabled}
            {...(reason === undefined ? {} : { title: reason })}
            onClick={() => setForm(toForm(workspace))}
          >
            Discard
          </Button>
          <Button
            type="submit"
            disabled={disabled}
            pending={save.isPending}
            {...(reason === undefined ? {} : { title: reason })}
          >
            Save changes
          </Button>
        </div>
      </Card>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* The read-only card                                                  */
/* ------------------------------------------------------------------ */

function ReadOnlyDetails({ workspace }: { workspace: WorkspaceDetails }) {
  const retention = workspace.analyticsRetentionMonths;
  const region =
    workspace.dataRegion === undefined
      ? null
      : retention === undefined || workspace.planName === undefined
        ? workspace.dataRegion
        : `${workspace.dataRegion} · analytics retained ${retention} months on ${workspace.planName}`;

  return (
    <div className="mt-6">
      <SectionHeading title="Workspace details" description="Read-only identifiers for support and the API." />

      <Card flush className="px-6 py-1.5 text-ui">
        <DetailRow label="Workspace ID">
          <Mono value={workspace.id} copy copyLabel="Copy workspace ID" />
        </DetailRow>

        {workspace.planName === undefined ? null : (
          <DetailRow label="Plan">
            {/* J1's plan chip is not a state badge: 10px, uppercase, no dot. */}
            <span className="rounded-badge bg-brand-soft px-1.5 py-0.5 text-pill font-semibold tracking-pill text-brand uppercase">
              {workspace.planName}
            </span>
            <Link to="/billing" className="text-ui font-medium text-brand no-underline">
              Manage in Billing →
            </Link>
          </DetailRow>
        )}

        {workspace.createdAt === undefined ? null : (
          <DetailRow label="Created">
            {formatDate(workspace.createdAt, workspace.timezone)}
            {workspace.createdByName === undefined ? '' : ` by ${workspace.createdByName}`}
          </DetailRow>
        )}

        {region === null ? null : <DetailRow label="Data region">{region}</DetailRow>}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The danger zone                                                     */
/* ------------------------------------------------------------------ */

function deleteWarning(workspace: WorkspaceDetails): string {
  const counts = workspace.counts;
  const what =
    counts === undefined
      ? 'Permanently deletes every contact, campaign and provider connection in this workspace, and all analytics.'
      : `Permanently deletes ${counts.contacts.toLocaleString('en-US')} contacts, ${counts.campaigns.toLocaleString('en-US')} campaigns, ${counts.providerConnections} provider connections and all analytics.`;

  return `${what} Exports stay downloadable for 30 days. Active subscription is cancelled at period end; nothing is charged.`;
}

function DangerZone({ workspace, workspaceId }: { workspace: WorkspaceDetails; workspaceId: string }) {
  const { can, logout } = useAuth();
  const readOnly = useReadOnly();
  const toast = useSafeToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [transferOpen, setTransferOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const members = useQuery({
    queryKey: workspaceKeys.members(workspaceId),
    queryFn: () => workspaceApi.members(),
    enabled: transferOpen,
  });

  const transfer = useMutation({
    mutationFn: (userId: string) => workspaceApi.transferOwnership(userId),
    onSuccess: async () => {
      setTransferOpen(false);
      toast.toast({ tone: 'success', title: 'Ownership transfer sent' });
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all(workspaceId) });
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not work',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const remove = useMutation({
    mutationFn: () => workspaceApi.remove(),
    onSuccess: async () => {
      setDeleteOpen(false);
      await logout();
      void navigate('/login', { replace: true });
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not work',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const mayDelete = can('workspace:delete');
  const disabled = !mayDelete || readOnly;
  const reason = readOnly ? READ_ONLY_TITLE : mayDelete ? undefined : 'Owner only';

  return (
    <div className="mt-6">
      <SectionHeading
        title="Danger zone"
        description="Owner only. Both actions are logged and confirmed by typing the workspace name."
        tone="danger"
      />

      <Card flush className="border-danger px-6 py-1.5 text-ui">
        <div className="flex flex-wrap items-center justify-between gap-6 border-b border-border py-4">
          <div className="min-w-60 flex-1">
            <div className="font-medium">Transfer ownership</div>
            <div className="mt-0.5 text-pretty text-text-2">
              Hand the Owner role to another member. You become an Admin and lose billing access. The new
              owner must accept within 7 days.
            </div>
          </div>
          <Button
            variant="secondary"
            disabled={disabled}
            {...(reason === undefined ? {} : { title: reason })}
            onClick={() => setTransferOpen(true)}
          >
            Transfer ownership
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-6 py-4">
          <div className="min-w-60 flex-1">
            <div className="font-medium">Delete workspace</div>
            <div className="mt-0.5 text-pretty text-text-2">{deleteWarning(workspace)}</div>
          </div>
          <Button
            variant="danger"
            disabled={disabled}
            {...(reason === undefined ? {} : { title: reason })}
            onClick={() => setDeleteOpen(true)}
          >
            Delete workspace
          </Button>
        </div>
      </Card>

      <TransferOwnershipModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        workspaceName={workspace.name}
        members={(members.data ?? []).filter((member) => member.role !== 'owner')}
        pending={transfer.isPending}
        onConfirm={(userId) => transfer.mutate(userId)}
      />

      <ConfirmDestructive
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => remove.mutate()}
        title="Delete workspace?"
        confirmLabel="Delete workspace"
        confirmPhrase={workspace.name}
        inputLabel="Workspace name"
        pending={remove.isPending}
      >
        {deleteWarning(workspace)}
      </ConfirmDestructive>
    </div>
  );
}

interface TransferMember {
  userId: string;
  role: WorkspaceRole;
  name?: string | undefined;
  email?: string | undefined;
}

function TransferOwnershipModal({
  open,
  onClose,
  workspaceName,
  members,
  pending,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  workspaceName: string;
  members: readonly TransferMember[];
  pending: boolean;
  onConfirm: (userId: string) => void;
}) {
  const [chosen, setChosen] = useState('');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) {
      setChosen('');
      setTyped('');
    }
  }, [open]);

  const armed = chosen !== '' && typed === workspaceName;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Transfer ownership"
      description="Hand the Owner role to another member. You become an Admin and lose billing access. The new owner must accept within 7 days."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!armed}
            pending={pending}
            {...(armed ? {} : { title: `Choose a member and type ${workspaceName} to confirm` })}
            onClick={() => onConfirm(chosen)}
          >
            Transfer ownership
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup label="New owner" value={chosen} onChange={setChosen}>
          {members.map((member) => (
            <RadioCard
              key={member.userId}
              value={member.userId}
              density="compact"
              label={member.name ?? member.email ?? member.userId}
              description={`${member.email ?? member.userId} · ${ROLE_LABEL[member.role]}`}
            />
          ))}
        </RadioGroup>

        <label className="flex flex-col gap-1.5">
          <span>
            Type{' '}
            <span className="rounded-4 bg-neutral-soft px-1.5 py-px font-mono text-caption">
              {workspaceName}
            </span>{' '}
            to confirm
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-label="Workspace name"
            autoComplete="off"
            className={inputClass('md', false)}
          />
        </label>
      </div>
    </Modal>
  );
}
