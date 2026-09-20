import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '@relayd/validation';
import type { LoginRequest, RegisterRequest } from '@relayd/validation';
import { ApiError, api } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { AuthLayout, Button as UiButton, Field as UiField, PasswordField } from '@relayd/ui';
import { AuthCard, Field, FormError, SubmitButton } from '../components/form.js';

/**
 * The unauthenticated pages.
 *
 * Every form validates with the same Zod schema the server enforces
 * (@relayd/validation), so the browser cannot accept something the API will
 * reject — and the server still validates, because the browser is not a
 * trusted validator.
 */

/** Turns a server error into either field errors or a form-level message. */
function useSubmitError() {
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const handle = (error: unknown, setFieldError?: (path: string, message: string) => void) => {
    if (error instanceof ApiError) {
      const fields = error.fieldErrors();
      const paths = Object.keys(fields);

      if (paths.length > 0 && setFieldError !== undefined) {
        for (const path of paths) setFieldError(path, fields[path] ?? 'Invalid');
        return;
      }
      setFormError(error.message);
      return;
    }
    setFormError('Something went wrong. Please try again.');
  };

  return { formError, setFormError, handle };
}

/**
 * B1 Sign in /login (design/B Auth & onboarding.dc.html).
 *
 * The frame: title "Sign in", subtitle "Use the work email you registered
 * with.", Email, Password with "Forgot password?" on the label row and the
 * reveal toggle in the box, a full-width 40px primary button, then "New to
 * Relayd? Create an account" under the card.
 */
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { formError, handle } = useSubmitError();
  const form = useForm<LoginRequest>({ resolver: zodResolver(loginSchema) });

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Use the work email you registered with."
      after={
        <>
          New to Relayd?{' '}
          <Link to="/register" className="font-medium text-brand no-underline hover:text-brand-hover">
            Create an account
          </Link>
        </>
      }
    >
      {/* The B1 card is one 20px column: heading, email, password, button. */}
      <form
        className="flex flex-col gap-5"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await login(values.email, values.password);
            navigate('/dashboard', { replace: true });
          } catch (error) {
            handle(error);
          }
        })}
      >
        <FormError message={formError} />
        <UiField
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
            <Link to="/forgot-password" className="text-ui font-medium text-brand no-underline hover:text-brand-hover">
              Forgot password?
            </Link>
          }
          {...form.register('password')}
          error={form.formState.errors.password?.message}
        />
        <UiButton type="submit" size="lg" block pending={form.formState.isSubmitting}>
          Sign in
        </UiButton>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register: createAccount } = useAuth();
  const navigate = useNavigate();
  const { formError, handle } = useSubmitError();
  const form = useForm<RegisterRequest>({ resolver: zodResolver(registerSchema) });

  return (
    <AuthCard title="Create your workspace">
      <form
        className="space-y-4"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await createAccount(values);
            navigate('/settings/workspace', { replace: true });
          } catch (error) {
            handle(error, (path, message) =>
              form.setError(path as keyof RegisterRequest, { message }),
            );
          }
        })}
      >
        <FormError message={formError} />
        <Field label="Your name" autoComplete="name" {...form.register('name')} error={form.formState.errors.name?.message} />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          {...form.register('email')}
          error={form.formState.errors.email?.message}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters."
          {...form.register('password')}
          error={form.formState.errors.password?.message}
        />
        <Field
          label="Workspace name"
          {...form.register('workspaceName')}
          error={form.formState.errors.workspaceName?.message}
        />
        <Field
          label="Workspace URL"
          hint="Lowercase letters, numbers and hyphens."
          {...form.register('workspaceSlug')}
          error={form.formState.errors.workspaceSlug?.message}
        />
        <SubmitButton pending={form.formState.isSubmitting}>Create workspace</SubmitButton>
      </form>
    </AuthCard>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');

  if (token === null) {
    return <AuthCard title="Invalid link">That verification link is missing its token.</AuthCard>;
  }

  if (state === 'idle') {
    setState('working');
    void api
      .post('/auth/verify-email', { token }, { unscoped: true })
      .then(() => setState('done'))
      .catch(() => setState('failed'));
  }

  return (
    <AuthCard title={state === 'done' ? 'Email confirmed' : 'Confirming your email'}>
      {state === 'failed' ? (
        <p className="text-sm text-slate-600">
          That link is no longer valid. It may have expired or already been used. Signing in will
          send you a new one.
        </p>
      ) : state === 'done' ? (
        <p className="text-sm text-slate-600">
          Thanks — your address is confirmed.{' '}
          <Link to="/login" className="underline">
            Sign in
          </Link>
          .
        </p>
      ) : (
        <p className="text-sm text-slate-600">One moment…</p>
      )}
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const form = useForm<{ email: string }>({ resolver: zodResolver(forgotPasswordSchema) });

  /**
   * The confirmation is identical whether or not the address has an account,
   * because the server's response is too (docs/06). Saying "no such account"
   * here would rebuild the enumeration oracle the API carefully avoids.
   */
  if (sent) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-slate-600">
          If that address has an account, a reset link is on its way. It expires in an hour.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password">
      <form
        className="space-y-4"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await api.post('/auth/forgot-password', values, { unscoped: true });
          } finally {
            // Shown regardless, for the same reason.
            setSent(true);
          }
        })}
      >
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          {...form.register('email')}
          error={form.formState.errors.email?.message}
        />
        <SubmitButton pending={form.formState.isSubmitting}>Send reset link</SubmitButton>
      </form>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const { formError, handle } = useSubmitError();
  const form = useForm<{ token: string; password: string }>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token },
  });

  if (token === '') {
    return <AuthCard title="Invalid link">That reset link is missing its token.</AuthCard>;
  }

  return (
    <AuthCard title="Choose a new password">
      <form
        className="space-y-4"
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
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters. This signs out every other device."
          {...form.register('password')}
          error={form.formState.errors.password?.message}
        />
        <SubmitButton pending={form.formState.isSubmitting}>Set new password</SubmitButton>
      </form>
    </AuthCard>
  );
}
