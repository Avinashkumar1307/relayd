import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router';
import { forgotPasswordSchema } from '@relayd/validation';
import { Button, Field } from '@relayd/ui';
import { api } from '../../api/client.js';
import { AuthFrame, AuthHeading, MailIcon, NoticeIcon, Strong } from './auth-frame.js';

/**
 * B4a Forgot password /forgot-password.
 *
 * Two states in one card, and the second one is a security control.
 *
 * The sent state is shown whatever the server answers, and its wording — "If
 * an account exists for …" — never confirms that the address is registered.
 * docs/06 makes the API answer 202 either way for exactly this reason;
 * rendering "no such account" here would rebuild the enumeration oracle the
 * endpoint was written to avoid. The request's outcome is deliberately not
 * surfaced, so a failed send and a nonexistent account look identical.
 */
export function ForgotPasswordPage() {
  const [sent, setSent] = useState<string | null>(null);
  const form = useForm<{ email: string }>({ resolver: zodResolver(forgotPasswordSchema) });

  const back = (
    <Link to="/login" className="font-medium text-brand no-underline hover:text-brand-hover">
      ← Back to sign in
    </Link>
  );

  if (sent !== null) {
    return (
      <AuthFrame after={back}>
        <NoticeIcon tone="success">
          <MailIcon />
        </NoticeIcon>

        <AuthHeading title="Check your inbox" spaced>
          If an account exists for <Strong>{sent}</Strong>, we&apos;ve sent a reset link. It works for 1
          hour.
        </AuthHeading>

        <Button
          variant="secondary"
          size="lg"
          block
          onClick={() => {
            setSent(null);
            form.reset();
          }}
        >
          Use a different email
        </Button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame after={back}>
      <AuthHeading title="Reset your password">Enter your email and we&apos;ll send a reset link.</AuthHeading>

      <form
        className="flex flex-col gap-5"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await api.post('/auth/forgot-password', values, { unscoped: true });
          } catch {
            // Deliberately swallowed, and the one place in the app where
            // that is right: surfacing *anything* the server said here —
            // "no such account", a rate limit, a 500 — tells an attacker
            // something about an address they do not own. The card below is
            // the only answer this page can give.
          } finally {
            setSent(values.email);
          }
        })}
      >
        <Field
          label="Email"
          size="lg"
          type="email"
          autoComplete="email"
          {...form.register('email')}
          error={form.formState.errors.email?.message}
        />
        <Button type="submit" size="lg" block pending={form.formState.isSubmitting}>
          Send reset link
        </Button>
      </form>
    </AuthFrame>
  );
}
