import type { ReactNode } from 'react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { passwordSchema } from '@relayd/validation';
import type { WorkspaceRole } from '@relayd/types';
import { Button, Field, Icon, Monogram, Skeleton } from '@relayd/ui';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { AuthFrame, AuthHeading, ClockIcon, NoticeIcon, Strong } from './auth-frame.js';
import { FormError, useSubmitError } from './form-error.js';

/**
 * B5 Accept invitation /invite/:token — two frames, chosen by whether
 * anyone is signed in.
 *
 *   B5a  signed in: the workspace, who invited you, what the role can do,
 *        one Accept button, and a way out if it is the wrong account
 *   B5b  signed out: the same header, then create the account the
 *        invitation is addressed to — the email is fixed and shown locked,
 *        because accepting with a different address is not the same offer
 *
 * The preview is fetched unauthenticated: the whole point of B5b is that
 * the page renders before anyone has an account.
 */

export interface InvitationPreview {
  workspaceName: string;
  workspaceMonogram: string;
  inviterName: string;
  invitedAt: string;
  expiresAt: string;
  role: WorkspaceRole;
  email: string;
}

/**
 * What each role may do, for the box on B5a.
 *
 * Editor's sentence is the frame's, verbatim. The other three are written
 * from the same permission model (`permissionsFor` in @relayd/types) in the
 * same voice; the design only drew the Editor case.
 */
const ROLE_COPY: Record<WorkspaceRole, { label: string; blurb: string }> = {
  owner: {
    label: 'Owner',
    blurb:
      'Owners do everything an Admin can, and are the only role that can see and change billing. Every workspace has exactly one.',
  },
  admin: {
    label: 'Admin',
    blurb:
      'Admins run the workspace: campaigns, providers, senders, the team and the audience. They cannot see or change billing.',
  },
  editor: {
    label: 'Editor',
    blurb:
      "Editors build campaigns, templates and segments. They can't launch campaigns or change billing; an Owner or Admin approves launches.",
  },
  viewer: {
    label: 'Viewer',
    blurb:
      'Viewers read campaigns, reports and the audience. They cannot change anything, send anything or see billing.',
  },
};

/**
 * "18 Sep 2026", the format every date in the frames uses.
 *
 * The month names are a list rather than `toLocaleDateString`, which in a
 * current ICU writes September as "Sept" — three letters everywhere except
 * the one month, which is exactly the kind of drift a frame comparison
 * catches and a unit test does not.
 */
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getUTCDate()} ${MONTH[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

export function AcceptInvitationPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { status } = useAuth();

  const preview = useQuery({
    queryKey: ['invitations', token],
    queryFn: () => api.get<InvitationPreview>(`/invitations/${token}`, undefined, { unscoped: true }),
    retry: false,
  });

  if (preview.isPending) {
    return (
      <AuthFrame>
        <Skeleton height={48} radius={12} />
        <Skeleton height={76} radius={8} />
        <Skeleton height={40} radius={8} />
      </AuthFrame>
    );
  }

  if (preview.isError || preview.data === undefined) {
    return (
      <AuthFrame gap={16} alignStart>
        <NoticeIcon tone="warning">
          <ClockIcon />
        </NoticeIcon>
        <AuthHeading title="This invitation is no longer valid" spaced>
          It may have expired, been revoked, or already been used. Ask whoever invited you to send a new
          one.
        </AuthHeading>
        <Link to="/login" className="text-ui font-medium text-brand no-underline hover:text-brand-hover">
          Back to sign in
        </Link>
      </AuthFrame>
    );
  }

  return status === 'authenticated' ? (
    <SignedIn token={token} invitation={preview.data} />
  ) : (
    <SignedOut token={token} invitation={preview.data} />
  );
}

/** The monogram + title row both B5 frames open with. */
function InviteHeader({ invitation, children }: { invitation: InvitationPreview; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5">
      <Monogram size={48} name={invitation.workspaceName}>
        {invitation.workspaceMonogram}
      </Monogram>
      <div className="min-w-0">
        <h1 className="m-0 text-section font-semibold leading-heading tracking-heading">
          Join {invitation.workspaceName}
        </h1>
        <p className="mb-0 mt-1 text-ui text-text-2">{children}</p>
      </div>
    </div>
  );
}

/** B5a. */
function SignedIn({ token, invitation }: { token: string; invitation: InvitationPreview }) {
  const { acceptInvitation, logout, user } = useAuth();
  const navigate = useNavigate();
  const { formError, handle } = useSubmitError();
  const [joining, setJoining] = useState(false);
  const role = ROLE_COPY[invitation.role];

  const accept = async () => {
    setJoining(true);
    try {
      await acceptInvitation(token);
      navigate('/get-started', { replace: true });
    } catch (error) {
      handle(error);
      setJoining(false);
    }
  };

  return (
    <AuthFrame after={<>This invitation expires {shortDate(invitation.expiresAt)}.</>}>
      <InviteHeader invitation={invitation}>
        Invited by {invitation.inviterName} · {shortDate(invitation.invitedAt)}
      </InviteHeader>

      <FormError message={formError} />

      <div className="flex flex-col gap-1.5 rounded-control border border-border px-3.5 py-3 text-ui">
        <div className="flex items-center justify-between">
          <span className="text-text-2">Your role</span>
          <span className="inline-flex h-[22px] items-center rounded-badge bg-brand-soft px-2 text-caption font-medium text-brand">
            {role.label}
          </span>
        </div>
        <div className="text-text-2 text-pretty">{role.blurb}</div>
      </div>

      <Button size="lg" block pending={joining} onClick={() => void accept()}>
        Accept invitation
      </Button>

      <div className="flex items-center justify-between gap-3 text-caption text-text-2">
        {/* The session's address, not the invitation's. They are the same
            in the frame and different in the case "Not you?" exists for,
            and printing the invited address here would hide exactly that. */}
        <span>
          Signed in as <Strong>{user?.email ?? invitation.email}</Strong>
        </span>
        <button
          type="button"
          onClick={() => void logout()}
          className="whitespace-nowrap font-medium text-brand hover:text-brand-hover"
        >
          Not you? Switch account
        </button>
      </div>
    </AuthFrame>
  );
}

const joinSchema = z
  .object({
    name: z.string().min(1, 'Enter your name').max(120).trim(),
    password: passwordSchema,
  })
  .strict();

type JoinInput = z.infer<typeof joinSchema>;

/** B5b. */
function SignedOut({ token, invitation }: { token: string; invitation: InvitationPreview }) {
  const navigate = useNavigate();
  const { formError, handle } = useSubmitError();
  const form = useForm<JoinInput>({ resolver: zodResolver(joinSchema) });

  return (
    <AuthFrame
      top={64}
      after={
        <>
          Already have an account?{' '}
          <Link
            to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
            className="font-medium text-brand no-underline hover:text-brand-hover"
          >
            Sign in to accept
          </Link>
        </>
      }
    >
      <InviteHeader invitation={invitation}>
        {invitation.inviterName} invited you as <Strong>{ROLE_COPY[invitation.role].label}</Strong>
      </InviteHeader>

      <div className="rounded-control bg-info-soft px-3 py-2.5 text-ui text-info-text">
        Create an account with the invited email to accept.
      </div>

      <form
        className="flex flex-col gap-5"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            // Registers against the invitation, with the address fixed by
            // the token. The server answers with the same session envelope
            // and refresh cookie POST /auth/register writes.
            await api.post(`/invitations/${token}/register`, values, { unscoped: true });
            navigate('/get-started', { replace: true });
          } catch (error) {
            handle(error, (path, message) => form.setError(path as keyof JoinInput, { message }));
          }
        })}
      >
        <FormError message={formError} />

        <Field
          label="Full name"
          size="lg"
          placeholder="Your name"
          autoComplete="name"
          {...form.register('name')}
          error={form.formState.errors.name?.message}
        />

        {/* The address is not an input: it is what the token is for. */}
        <div className="flex flex-col gap-1.5 text-ui">
          <span className="font-medium text-text">Email</span>
          <span className="flex h-10 items-center justify-between rounded-control border border-border bg-tint px-3 text-body text-text-2">
            {invitation.email}
            <Icon name="lock" size={14} strokeWidth={2} className="text-text-3" />
          </span>
          <span className="text-caption text-text-2">Fixed by the invitation.</span>
        </div>

        <Field
          label="Password"
          size="lg"
          type="password"
          placeholder="At least 12 characters"
          autoComplete="new-password"
          {...form.register('password')}
          error={form.formState.errors.password?.message}
        />

        <Button type="submit" size="lg" block pending={form.formState.isSubmitting}>
          Create account and join
        </Button>
      </form>
    </AuthFrame>
  );
}
