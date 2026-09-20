import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { resetPasswordSchema } from '@relayd/validation';
import type { ResetPasswordRequest } from '@relayd/validation';
import { Button, Field, Icon } from '@relayd/ui';
import { api } from '../../api/client.js';
import { AuthFrame, AuthHeading, ClockIcon, NoticeIcon, Strong } from './auth-frame.js';
import { FormError, useSubmitError } from './form-error.js';
import { PasswordStrength, strengthOf } from './password-strength.js';

/**
 * B4b Choose a new password /reset-password/:token.
 *
 * The frame's rule for the button: it unlocks only when the new password
 * scores 3 on the meter *and* the confirmation matches. Until then it keeps
 * its label and says which half is missing, per the design system's
 * disabled-button rule.
 *
 * The confirmation field is the one place the design colours a *valid*
 * input: a success border and "Passwords match" once the two agree, a danger
 * border and "Passwords don't match" while they do not.
 *
 * `?token=` is accepted as an alias for the path parameter because that is
 * the shape older reset emails use, and a link that 404s is a support
 * ticket.
 */
export function ResetPasswordPage() {
  const params = useParams<{ token?: string }>();
  const [query] = useSearchParams();
  const navigate = useNavigate();
  const token = params.token ?? query.get('token') ?? '';
  const email = query.get('email');

  const { formError, handle } = useSubmitError();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const form = useForm<ResetPasswordRequest>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: '' },
  });

  const strength = strengthOf(password);
  const match = confirm.length > 0 && confirm === password;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = strength.ok && match;

  if (token === '') {
    // No frame covers a link with no token; B3c's shape is the closest the
    // design gives for "this link cannot be used".
    return (
      <AuthFrame gap={16} alignStart>
        <NoticeIcon tone="warning">
          <ClockIcon />
        </NoticeIcon>
        <AuthHeading title="This link is not valid" spaced>
          The reset link is missing its token. Ask for a new one and we&apos;ll send it to your inbox.
        </AuthHeading>
        <Link
          to="/forgot-password"
          className="flex h-10 w-full items-center justify-center rounded-control bg-brand text-body font-medium text-on-brand no-underline hover:bg-brand-hover"
        >
          Send a new link
        </Link>
      </AuthFrame>
    );
  }

  const passwordField = form.register('password');

  return (
    <AuthFrame>
      <AuthHeading title="Choose a new password">
        {email === null ? (
          'This signs you out everywhere else.'
        ) : (
          <>
            For <Strong>{email}</Strong>. This signs you out everywhere else.
          </>
        )}
      </AuthHeading>

      <form
        className="flex flex-col gap-5"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await api.post('/auth/reset-password', values, { unscoped: true });
            navigate('/login', { replace: true });
          } catch (error) {
            handle(error);
          }
        })}
      >
        <FormError message={formError} />
        <input type="hidden" {...form.register('token')} />

        <Field
          label="New password"
          size="lg"
          type="password"
          autoComplete="new-password"
          placeholder="At least 12 characters"
          help={<PasswordStrength password={password} />}
          {...passwordField}
          onChange={(event) => {
            setPassword(event.currentTarget.value);
            void passwordField.onChange(event);
          }}
          error={form.formState.errors.password?.message}
        />

        <Field
          label="Confirm new password"
          size="lg"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.currentTarget.value)}
          // `Field` has no success state; the descendant selector reaches the
          // input it owns rather than forking the component.
          className={match ? '[&_input]:border-success' : ''}
          error={mismatch ? "Passwords don't match" : undefined}
          help={
            match ? (
              <span className="flex items-center gap-1.5 text-success-text">
                <Icon name="check" size={13} strokeWidth={2.5} />
                Passwords match
              </span>
            ) : undefined
          }
        />

        <Button
          type="submit"
          size="lg"
          block
          disabled={!ready}
          title={
            ready
              ? 'Reset password'
              : !strength.ok
                ? 'Choose a stronger password'
                : 'Confirm the new password'
          }
          pending={form.formState.isSubmitting}
        >
          Reset password
        </Button>
      </form>
    </AuthFrame>
  );
}
