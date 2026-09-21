import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import { emailSchema, passwordSchema } from '@relayd/validation';
import { Button, Checkbox, Field, PasswordField } from '@relayd/ui';
import { api } from '../../api/client.js';
import { AuthFrame, AuthHeading } from './auth-frame.js';
import { FormError, useSubmitError } from './form-error.js';
import { PasswordStrength, strengthOf } from './password-strength.js';

/**
 * B2 Create your account /register.
 *
 * Three things in the frame are rules, not decoration:
 *
 *   The button is disabled until the password scores 3 and the consent box
 *   is ticked, and it says which of the two is missing in its tooltip —
 *   "Choose a stronger password" or "Accept the terms to continue".
 *
 *   The consent sentence is a compliance control, not a nicety: "I will only
 *   email people who have consented" is the first of the two attestations
 *   CLAUDE.md section 11 requires (the second is at import and launch).
 *
 *   Registering does not sign anyone in. It sends them to B3a to wait for
 *   the verification link, and the workspace is created afterwards on B6a.
 */

/**
 * `registerSchema` in @relayd/validation cannot be used here: it requires
 * `workspaceName` and `workspaceSlug`, and the design splits those onto B6a,
 * two screens later. Validated locally against the same field schemas until
 * the shared package gains an account-only variant.
 */
const registerAccountSchema = z
  .object({
    name: z.string().min(1, 'Enter your name').max(120).trim(),
    email: emailSchema,
    password: passwordSchema,
    terms: z.literal(true),
  })
  .strict();

type RegisterAccountInput = z.infer<typeof registerAccountSchema>;

export function RegisterPage() {
  const navigate = useNavigate();
  const { formError, handle } = useSubmitError();
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const form = useForm<RegisterAccountInput>({ resolver: zodResolver(registerAccountSchema) });

  const strength = strengthOf(password);
  const ready = strength.ok && terms;
  const title = ready
    ? 'Create account'
    : !strength.ok
      ? 'Choose a stronger password'
      : 'Accept the terms to continue';

  const passwordField = form.register('password');
  const termsField = form.register('terms');

  return (
    <AuthFrame
      top={56}
      after={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand no-underline hover:text-brand-hover">
            Sign in
          </Link>
        </>
      }
    >
      <AuthHeading title="Create your account">Free to start. No card needed.</AuthHeading>

      <form
        className="flex flex-col gap-5"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            // No workspace: `registerSchema` takes the pair as both-or-
            // neither, and B6a `/workspaces/new` is where one is named. The
            // account comes back with an empty `memberships` list.
            await api.post(
              '/auth/register',
              { name: values.name, email: values.email, password: values.password },
              { unscoped: true },
            );
            navigate(`/verify?email=${encodeURIComponent(values.email)}`, { replace: true });
          } catch (error) {
            handle(error, (path, message) =>
              form.setError(path as keyof RegisterAccountInput, { message }),
            );
          }
        })}
      >
        <FormError message={formError} />

        <Field
          label="Full name"
          size="lg"
          autoComplete="name"
          {...form.register('name')}
          error={form.formState.errors.name?.message}
        />

        <Field
          label="Work email"
          size="lg"
          type="email"
          autoComplete="email"
          help="We'll send a verification link here."
          {...form.register('email')}
          error={form.formState.errors.email?.message}
        />

        <PasswordField
          label="Password"
          size="lg"
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

        <Checkbox
          label={
            <>
              I agree to the{' '}
              <Link to="/terms" className="font-medium text-brand no-underline hover:text-brand-hover">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link to="/privacy" className="font-medium text-brand no-underline hover:text-brand-hover">
                Privacy Policy
              </Link>
              , and I will only email people who have consented.
            </>
          }
          {...termsField}
          onChange={(event) => {
            setTerms(event.currentTarget.checked);
            void termsField.onChange(event);
          }}
        />

        <Button
          type="submit"
          size="lg"
          block
          disabled={!ready}
          title={title}
          pending={form.formState.isSubmitting}
        >
          Create account
        </Button>
      </form>
    </AuthFrame>
  );
}
