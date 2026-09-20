import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { workspaceSlugSchema } from '@relayd/validation';
import { Button, Field, Select } from '@relayd/ui';
import { useAuth } from '../../auth/AuthProvider.js';
import { AuthFrame, AuthHeading } from './auth-frame.js';
import { FormError, useSubmitError } from './form-error.js';

/**
 * B6a Create your workspace /workspaces/new — step 1 of 2, B6b being step 2.
 *
 * The slug is derived, shown and never typed: the frame prints
 * `app.relayd.io/<slug>` under the name field and updates it as the name is
 * typed. `workspaceSlugSchema` is the shared rule the derivation has to
 * satisfy, so the derived value is validated rather than trusted.
 *
 * The timezone is a real `<select>`. The export draws a custom popover; the
 * design system's own note on `Select` is that the frames show one nowhere
 * else and the native control brings type-ahead, the mobile wheel and the
 * platform's keyboard handling for free.
 */

/** The export's list, in its order (design/B, `const TZ`). */
export const TIMEZONES: readonly { value: string; label: string; offset: string }[] = [
  { value: 'Asia/Dubai', label: 'Asia/Dubai · GST', offset: '+04:00' },
  { value: 'Europe/London', label: 'Europe/London · BST', offset: '+01:00' },
  { value: 'Europe/Paris', label: 'Europe/Paris · CEST', offset: '+02:00' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin · CEST', offset: '+02:00' },
  { value: 'America/New_York', label: 'America/New_York · EDT', offset: '−04:00' },
  { value: 'UTC', label: 'UTC', offset: '+00:00' },
];

/** The export's `slugify`, transcribed. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/&/gu, 'and')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');

  return slug === '' ? 'your-workspace' : slug;
}

const createWorkspaceSchema = z
  .object({
    name: z.string().min(1, 'Name your workspace').max(120).trim(),
    timezone: z.string().min(1),
  })
  .strict();

type CreateWorkspaceForm = z.infer<typeof createWorkspaceSchema>;

export function CreateWorkspacePage() {
  const { createWorkspace } = useAuth();
  const navigate = useNavigate();
  const { formError, handle } = useSubmitError();
  const [name, setName] = useState('');
  const form = useForm<CreateWorkspaceForm>({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: { name: '', timezone: TIMEZONES[0]?.value ?? 'UTC' },
  });

  const slug = slugify(name);
  const slugValid = workspaceSlugSchema.safeParse(slug).success;
  const nameField = form.register('name');

  return (
    <AuthFrame
      top={80}
      after="Invited to an existing workspace? Open the link in your invitation email instead."
    >
      <AuthHeading eyebrow="Step 1 of 2" title="Create your workspace">
        A workspace holds one team&apos;s audience, campaigns, providers and billing. You&apos;ll be its
        Owner.
      </AuthHeading>

      <form
        className="flex flex-col gap-5"
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await createWorkspace({ name: values.name, slug, timezone: values.timezone });
            navigate('/get-started', { replace: true });
          } catch (error) {
            handle(error, (path, message) =>
              form.setError(path as keyof CreateWorkspaceForm, { message }),
            );
          }
        })}
      >
        <FormError message={formError} />

        <Field
          label="Workspace name"
          size="lg"
          placeholder="e.g. Northwind Voyages"
          autoComplete="organization"
          help={
            <>
              URL: <span className="font-mono text-text">app.relayd.io/{slug}</span>
            </>
          }
          {...nameField}
          onChange={(event) => {
            setName(event.currentTarget.value);
            void nameField.onChange(event);
          }}
          error={
            form.formState.errors.name?.message ??
            (name !== '' && !slugValid ? 'That name does not make a usable URL' : undefined)
          }
        />

        <Select
          label="Timezone"
          size="lg"
          help="Schedules, reports and audit times use this zone. You can change it later."
          {...form.register('timezone')}
        >
          {TIMEZONES.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </Select>

        <Button type="submit" size="lg" block pending={form.formState.isSubmitting}>
          Create workspace
        </Button>
      </form>
    </AuthFrame>
  );
}
