import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

/**
 * The shared form primitives.
 *
 * Every field is labelled and every error is wired with aria-describedby and
 * aria-invalid. A validation message a screen reader never announces is a
 * message the user did not receive.
 */

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, id, ...props },
  ref,
) {
  const fieldId = id ?? props.name ?? label.toLowerCase().replaceAll(' ', '-');
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const describedBy = [error !== undefined ? errorId : null, hint !== undefined ? hintId : null]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        {...props}
        id={fieldId}
        ref={ref}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 aria-[invalid=true]:border-red-500"
      />
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
});

export function SubmitButton({
  children,
  pending,
  ...props
}: { children: ReactNode; pending?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      disabled={pending === true}
      {...props}
      className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending === true ? 'Working…' : children}
    </button>
  );
}

/**
 * A form-level error.
 *
 * role="alert" so it is announced when it appears — a message that only
 * appears visually is invisible to anyone not looking at that part of the
 * screen.
 */
export function FormError({ message }: { message?: string | undefined }) {
  if (message === undefined) return null;
  return (
    <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </div>
  );
}

export function AuthCard({ title, subtitle, children }: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle !== undefined && <p className="text-sm text-slate-600">{subtitle}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}
