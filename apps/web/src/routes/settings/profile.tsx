import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  DetailSkeleton,
  ErrorState,
  Field,
  Icon,
  PageHeader,
} from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import { accountApi, workspaceKeys, type AccountProfile, type AccountSession } from '../../api/workspace.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { DeviceIcon, SectionHeading, useSafeToast } from './workspace-parts.js';
import { initialsOf } from './team.js';

/**
 * J5 — /settings/profile.
 *
 * "Your account across all workspaces", and the description is the design
 * decision: nothing on this page is workspace-scoped, so nothing on it is
 * gated by a workspace role or by K2's read-only state. A suspended
 * workspace must not stop somebody changing their own password.
 *
 * The whole page is BACKEND PENDING — `apps/api/src/routes/auth.ts` has no
 * `/me` and no session list — so it is built against the preview backend and
 * every call site says so.
 */

export function ProfilePage() {
  const { user } = useAuth();

  const profile = useQuery({
    queryKey: workspaceKeys.profile(),
    // BACKEND PENDING: GET /me
    queryFn: () => accountApi.profile(),
  });

  const header = <PageHeader title="Profile & security" description="Your account across all workspaces." />;

  if (profile.isPending) {
    return (
      <>
        {header}
        <DetailSkeleton label="Loading your profile" />
      </>
    );
  }

  if (profile.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="We couldn't load your profile"
          description="Your account is unaffected. Send support the request ID if it keeps happening."
          requestId={profile.error instanceof ApiError ? profile.error.requestId : undefined}
          onRetry={() => void profile.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  return (
    <div className="max-w-[880px]">
      {header}
      <IdentityCard profile={profile.data} fallbackName={user?.name ?? ''} />
      <ChangePassword />
      <ActiveSessions />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Name and email                                                      */
/* ------------------------------------------------------------------ */

function IdentityCard({ profile, fallbackName }: { profile: AccountProfile; fallbackName: string }) {
  const queryClient = useQueryClient();
  const toast = useSafeToast();
  const [name, setName] = useState(profile.name);

  useEffect(() => {
    setName(profile.name);
  }, [profile.name]);

  const save = useMutation({
    // BACKEND PENDING: PATCH /me
    mutationFn: () => accountApi.updateProfile({ name: name.trim() }),
    onSuccess: async () => {
      toast.toast({ tone: 'success', title: 'Profile updated' });
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.profile() });
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not save',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const initials = initialsOf(profile.name === '' ? fallbackName : profile.name);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== '') save.mutate();
      }}
    >
      <Card flush className="grid grid-cols-1 items-start gap-5 p-6 sm:grid-cols-[72px_1fr] md:grid-cols-[72px_1fr_1fr] md:gap-x-6">
        {/* 72px is one size past `Avatar`'s largest (32) and `Monogram`'s
            largest (48); J5 is the only frame that draws it, so it is
            written out here rather than added to the shared component. */}
        <span
          role="img"
          aria-label={profile.name}
          className="grid h-18 w-18 flex-none place-items-center rounded-full bg-brand-soft text-[22px] font-semibold text-brand"
        >
          {initials}
        </span>

        <Field
          label="Full name"
          value={name}
          autoComplete="name"
          onChange={(event) => setName(event.target.value)}
        />

        <div className="flex flex-col gap-1.5 text-ui">
          <span className="font-medium text-text">Email</span>
          <span className="flex h-9 items-center justify-between gap-2 rounded-control border border-border bg-tint px-3">
            <span className="min-w-0 truncate">{profile.email}</span>
            {profile.emailVerified ? (
              <span className="inline-flex flex-none items-center gap-1.25 text-caption text-success-text">
                <Icon name="check" size={12} strokeWidth={3} />
                Verified
              </span>
            ) : (
              <Badge tone="warning">Unverified</Badge>
            )}
          </span>
          {/* BACKEND PENDING: POST /me/email-change */}
          <a href="/verify" className="text-caption font-medium text-brand no-underline">
            Change email
          </a>
        </div>

        {/* Live whenever there is a name to save, as J5 draws it. */}
        <div className="flex justify-end sm:col-start-2 md:col-start-2 md:col-span-2">
          <Button type="submit" disabled={name.trim() === ''} pending={save.isPending}>
            Save
          </Button>
        </div>
      </Card>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Password                                                            */
/* ------------------------------------------------------------------ */

function ChangePassword() {
  const toast = useSafeToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const change = useMutation({
    // BACKEND PENDING: POST /me/password
    mutationFn: () => accountApi.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.toast({ tone: 'success', title: 'Password updated' });
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(undefined);
    },
    onError: (failure: unknown) =>
      setError(failure instanceof ApiError ? failure.message : 'That did not work. Try again.'),
  });

  const submit = () => {
    if (current === '' || next === '' || confirm === '') {
      setError('Fill in all three fields.');
      return;
    }
    if (next.length < 12) {
      setError('Use at least 12 characters.');
      return;
    }
    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setError(undefined);
    change.mutate();
  };

  return (
    <div className="mt-6">
      <SectionHeading title="Change password" />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Card flush className="grid grid-cols-1 items-end gap-5 p-6 md:grid-cols-3 md:gap-x-6">
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            placeholder="At least 12 characters"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <Field
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            error={error}
            onChange={(event) => setConfirm(event.target.value)}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 text-caption text-text-2 md:col-span-3">
            <span>Changing your password signs out every other session.</span>
            {/* Live from the start, as J5 draws it: the three fields are
                checked on submit and the reason is shown on the field that
                is wrong, which says more than a dead button does. */}
            <Button type="submit" variant="secondary" pending={change.isPending}>
              Update password
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function ActiveSessions() {
  const queryClient = useQueryClient();
  const toast = useSafeToast();

  const sessions = useQuery({
    queryKey: workspaceKeys.sessions(),
    // BACKEND PENDING: GET /me/sessions
    queryFn: () => accountApi.sessions(),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: workspaceKeys.sessions() });

  const revoke = useMutation({
    // BACKEND PENDING: DELETE /me/sessions/:id
    mutationFn: (id: string) => accountApi.revokeSession(id),
    onSuccess: async () => {
      toast.toast({ tone: 'success', title: 'Session signed out' });
      await invalidate();
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not work',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const revokeOthers = useMutation({
    // BACKEND PENDING: DELETE /me/sessions
    mutationFn: () => accountApi.revokeOtherSessions(),
    onSuccess: async () => {
      toast.toast({ tone: 'success', title: 'Every other session signed out' });
      await invalidate();
    },
    onError: (error: unknown) =>
      toast.toast({
        tone: 'danger',
        title: 'That did not work',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const rows = sessions.data ?? [];
  const others = rows.filter((row) => !row.current).length;

  return (
    <div className="mt-6">
      <SectionHeading
        title="Active sessions"
        actions={
          <button
            type="button"
            disabled={others === 0 || revokeOthers.isPending}
            title={others === 0 ? 'This is your only session' : undefined}
            onClick={() => revokeOthers.mutate()}
            className="h-7.5 cursor-pointer rounded-control border border-border bg-surface px-2.5 text-caption font-medium text-danger-text hover:bg-tint disabled:cursor-not-allowed disabled:text-text-3"
          >
            Sign out all other sessions
          </button>
        }
      />

      {sessions.isError ? (
        <ErrorState
          size="table"
          title="We couldn't load your sessions"
          description="Your account is unaffected. Send support the request ID if it keeps happening."
          requestId={sessions.error instanceof ApiError ? sessions.error.requestId : undefined}
          onRetry={() => void sessions.refetch()}
          retryLabel="Retry"
        />
      ) : (
        <Card flush>
          <ul className="m-0 list-none p-0">
            {rows.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                pending={revoke.isPending}
                onRevoke={() => revoke.mutate(session.id)}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function SessionRow({
  session,
  pending,
  onRevoke,
}: {
  session: AccountSession;
  pending: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 border-b border-border px-4.5 py-3 text-ui last:border-b-0 md:grid-cols-[40px_minmax(0,1.2fr)_minmax(0,1fr)_150px_120px]">
      <span className="grid h-9 w-9 place-items-center rounded-control bg-neutral-soft text-text-2">
        <DeviceIcon kind={session.deviceKind} />
      </span>

      <div className="min-w-0">
        <div className="flex items-center gap-2 font-medium">
          <span className="truncate">{session.device}</span>
          {session.current ? <Badge tone="success">This device</Badge> : null}
        </div>
        <div className="text-caption text-text-2">{session.client}</div>
      </div>

      <div className="col-start-2 text-text-2 md:col-start-auto">
        <div>{session.location}</div>
        <div className="font-mono text-label text-text-3">{session.ip}</div>
      </div>

      <div className="col-start-2 whitespace-nowrap text-text-2 md:col-start-auto">
        {session.lastActiveLabel}
      </div>

      <div className="col-start-2 md:col-start-auto md:text-right">
        {session.current ? null : (
          <button
            type="button"
            disabled={pending}
            onClick={onRevoke}
            className="h-7 cursor-pointer rounded-badge border border-border bg-surface px-2 text-caption font-medium text-danger-text hover:bg-tint disabled:cursor-not-allowed disabled:text-text-3"
          >
            Revoke
          </button>
        )}
      </div>
    </li>
  );
}
