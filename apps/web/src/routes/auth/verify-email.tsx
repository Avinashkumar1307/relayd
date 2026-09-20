import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Icon } from '@relayd/ui';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { AuthFrame, AuthHeading, ClockIcon, MailIcon, NoticeIcon, Strong } from './auth-frame.js';
import { FormError, useSubmitError } from './form-error.js';

/**
 * B3 Verify email /verify — three states on one route.
 *
 *   no token   B3a, "Check your inbox": the state after registering, with a
 *              resend on a 30-second cooldown
 *   verified   B3b, "Email verified", pointing at B6a
 *   rejected   B3c, "This link has expired", offering a new link
 *
 * The token arrives in the query because that is what the emailed link
 * carries; `?email=` rides along so every state can name the address, which
 * all three frames do.
 */

/** Counts a cooldown down once a second and cleans up after itself. */
export function useCooldown(seconds: number): { left: number; start: () => void } {
  const [left, setLeft] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    setLeft(seconds);
    stop();
    timer.current = setInterval(() => {
      setLeft((value) => {
        if (value <= 1) {
          stop();
          return 0;
        }
        return value - 1;
      });
    }, 1000);
  }, [seconds, stop]);

  return { left, start };
}

type VerifyState = 'pending' | 'checking' | 'verified' | 'expired';

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const emailParam = params.get('email');
  const { status } = useAuth();
  const [state, setState] = useState<VerifyState>(token === null ? 'pending' : 'checking');
  const [email, setEmail] = useState<string | null>(emailParam);

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const result = await api.post<{ verified: boolean; email?: string }>(
          '/auth/verify-email',
          { token },
          { unscoped: true },
        );
        if (cancelled) return;
        if (result.email !== undefined) setEmail(result.email);
        // A 4xx is how the API rejects a stale link, and the catch below is
        // what turns that into B3c. `verified: false` on a 200 means the
        // same thing and is read the same way rather than being ignored.
        setState(result.verified === false ? 'expired' : 'verified');
      } catch {
        if (!cancelled) setState('expired');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state === 'verified') return <VerifiedCard email={email} />;
  if (state === 'expired') return <ExpiredCard email={email} />;
  return <PendingCard email={email} checking={state === 'checking'} signedIn={status === 'authenticated'} />;
}

/** B3a — waiting for the link to be opened. */
function PendingCard({
  email,
  checking,
  signedIn,
}: {
  email: string | null;
  checking: boolean;
  signedIn: boolean;
}) {
  const { resendVerification } = useAuth();
  const cooldown = useCooldown(30);
  const { formError, handle } = useSubmitError();
  const [sending, setSending] = useState(false);

  const resend = async () => {
    setSending(true);
    try {
      // BACKEND PENDING: POST /auth/resend-verification
      await resendVerification(email ?? undefined);
      cooldown.start();
    } catch (error) {
      handle(error);
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthFrame
      gap={16}
      alignStart
      after={
        <>
          Can&apos;t find it? Check spam, or ask IT to allow{' '}
          <span className="font-mono text-caption">mail.relayd.io</span>.
        </>
      }
    >
      <NoticeIcon tone="info">
        <MailIcon />
      </NoticeIcon>

      <AuthHeading title={checking ? 'Confirming your email' : 'Check your inbox'} spaced>
        {checking ? (
          'One moment — we are checking that link.'
        ) : (
          <>
            We sent a verification link to <Strong>{email ?? 'your inbox'}</Strong>. It works for 24 hours.
          </>
        )}
      </AuthHeading>

      <FormError message={formError} />

      <div
        role="status"
        className="flex w-full items-center gap-2 rounded-control bg-tint px-3 py-2.5 text-ui text-text-2"
      >
        <span className="h-1.5 w-1.5 flex-none animate-pulse-dot rounded-full bg-info" />
        Waiting for verification · this page updates automatically
      </div>

      <div className="flex w-full items-center gap-2">
        <Button
          variant="secondary"
          size="lg"
          className="min-w-[150px]"
          disabled={cooldown.left > 0}
          title={cooldown.left > 0 ? `Wait ${cooldown.left}s before resending` : 'Resend email'}
          pending={sending}
          onClick={() => void resend()}
        >
          {cooldown.left > 0 ? `Resend in ${cooldown.left}s` : 'Resend email'}
        </Button>
        <Link
          to={signedIn ? '/settings/workspace' : '/register'}
          className="inline-flex h-10 items-center px-3 text-ui font-medium text-brand no-underline hover:text-brand-hover"
        >
          Change email
        </Link>
      </div>
    </AuthFrame>
  );
}

/** B3b — confirmed, pointing at the workspace step. */
function VerifiedCard({ email }: { email: string | null }) {
  return (
    <AuthFrame gap={16} alignStart>
      <NoticeIcon tone="success">
        <Icon name="check" size={22} strokeWidth={2} />
      </NoticeIcon>

      <AuthHeading title="Email verified" spaced>
        {email === null ? (
          'Your address is confirmed. Next, create a workspace for your team.'
        ) : (
          <>
            <Strong>{email}</Strong> is confirmed. Next, create a workspace for your team.
          </>
        )}
      </AuthHeading>

      <Link
        to="/workspaces/new"
        className="flex h-10 w-full items-center justify-center rounded-control bg-brand text-body font-medium text-on-brand no-underline hover:bg-brand-hover"
      >
        Create your first workspace
      </Link>
    </AuthFrame>
  );
}

/** B3c — the link is past its 24 hours. */
function ExpiredCard({ email }: { email: string | null }) {
  const { resendVerification } = useAuth();
  const { formError, handle } = useSubmitError();
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);

  const resend = async () => {
    setSending(true);
    try {
      // BACKEND PENDING: POST /auth/resend-verification
      await resendVerification(email ?? undefined);
      setSent(true);
    } catch (error) {
      handle(error);
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthFrame gap={16} alignStart>
      <NoticeIcon tone="warning">
        <ClockIcon />
      </NoticeIcon>

      <AuthHeading title="This link has expired" spaced>
        {email === null ? (
          "Verification links work for 24 hours. Request a new one and we'll send it to your address."
        ) : (
          <>
            Verification links work for 24 hours. Request a new one and we&apos;ll send it to{' '}
            <Strong>{email}</Strong>.
          </>
        )}
      </AuthHeading>

      <FormError message={formError} />

      <Button
        size="lg"
        block
        disabled={sent}
        title={sent ? 'A new link is on its way' : 'Send a new link'}
        pending={sending}
        onClick={() => void resend()}
      >
        {sent ? 'Link sent' : 'Send a new link'}
      </Button>

      <Link to="/login" className="text-ui font-medium text-brand no-underline hover:text-brand-hover">
        Use a different account
      </Link>
    </AuthFrame>
  );
}
