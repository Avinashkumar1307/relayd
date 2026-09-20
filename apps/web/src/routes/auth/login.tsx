import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate } from 'react-router';
import { loginSchema } from '@relayd/validation';
import type { LoginRequest } from '@relayd/validation';
import { Button, Field, PasswordField } from '@relayd/ui';
import { useAuth } from '../../auth/AuthProvider.js';
import { AuthFrame, AuthHeading } from './auth-frame.js';
import { FormError, useSubmitError } from './form-error.js';

/**
 * B1 Sign in /login.
 *
 * The frame: title "Sign in", subtitle "Use the work email you registered
 * with.", Email, Password with "Forgot password?" on the label row and the
 * reveal toggle in the box, a full-width 40px primary button, then "New to
 * Relayd? Create an account" under the card.
 *
 * B1m shortens the label to "Forgot?" because the export's 390px row was
 * tight; ours is not — the full label fits at 390 with room to spare — so
 * one label is used at both widths rather than two accessible names for one
 * link.
 */
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { formError, handle } = useSubmitError();
  const form = useForm<LoginRequest>({ resolver: zodResolver(loginSchema) });

  // RequireAuth remembers where an expired session was headed.
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  return (
    <AuthFrame
      after={
        <>
          New to Relayd?{' '}
          <Link to="/register" className="font-medium text-brand no-underline hover:text-brand-hover">
            Create an account
          </Link>
        </>
      }
    >
      <AuthHeading title="Sign in">Use the work email you registered with.</AuthHeading>

      <form
        className="flex flex-col gap-5"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await login(values.email, values.password);
            navigate(from, { replace: true });
          } catch (error) {
            handle(error);
          }
        })}
      >
        <FormError message={formError} />
        <Field
          label="Email"
          size="lg"
          type="email"
          autoComplete="email"
          {...form.register('email')}
          error={form.formState.errors.email?.message}
        />
        <PasswordField
          label="Password"
          size="lg"
          autoComplete="current-password"
          labelAside={
            <Link
              to="/forgot-password"
              className="text-ui font-medium text-brand no-underline hover:text-brand-hover"
            >
              Forgot password?
            </Link>
          }
          {...form.register('password')}
          error={form.formState.errors.password?.message}
        />
        <Button type="submit" size="lg" block pending={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}
