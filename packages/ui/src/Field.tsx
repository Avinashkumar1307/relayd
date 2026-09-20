import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './icons.js';

/**
 * Form fields (design/00 Design System.dc.html, "Form fields").
 *
 * The sheet's rule, verbatim: "Labels above, help text below, errors inline in
 * danger with an icon. Focus is a 3px brand-soft ring. Required compliance
 * controls are always on and say so."
 *
 * Two sizes, as with buttons: 36px / 13px in the app, 40px / 14px on the auth
 * pages (B1–B6). The error state is a `#DC2626` border in both themes — the
 * hue, not the themed text colour, matching the sheet's third input.
 *
 * The <label> is a sibling of the input, not a wrapper. Wrapping is the
 * shorter markup and it makes the error text part of the field's accessible
 * name — a screen reader would announce "Email, Required" as the label. The
 * error is what the field is *described by*, so it hangs off
 * `aria-describedby` and the name stays the label.
 */

export type FieldSize = 'md' | 'lg';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: ReactNode;
  /** Shown to the right of the label — the "Forgot password?" link on B1. */
  labelAside?: ReactNode | undefined;
  help?: ReactNode | undefined;
  error?: string | undefined;
  size?: FieldSize | undefined;
}

const SIZE: Record<FieldSize, string> = {
  md: 'h-9 text-ui',
  lg: 'h-10 text-body',
};

/** The input box on its own, for composing (password toggle, prefix chips). */
export const inputClass = (size: FieldSize, invalid: boolean, extra = ''): string =>
  [
    'w-full rounded-control border bg-surface px-3 text-text outline-none',
    'placeholder:text-text-3',
    'focus:border-brand focus:ring-[3px] focus:ring-brand-soft',
    'disabled:cursor-not-allowed disabled:bg-tint disabled:text-text-3',
    invalid ? 'border-danger' : 'border-border',
    SIZE[size],
    extra,
  ].join(' ');

function LabelRow({ htmlFor, label, aside }: { htmlFor: string; label: ReactNode; aside?: ReactNode }) {
  return (
    <span className="flex items-center justify-between gap-3">
      <label htmlFor={htmlFor} className="font-medium text-text">
        {label}
      </label>
      {aside}
    </span>
  );
}

function Below({ help, error, helpId, errorId }: { help?: ReactNode; error?: string | undefined; helpId: string; errorId: string }) {
  if (error !== undefined && error !== '') {
    return (
      <span id={errorId} role="alert" className="flex items-center gap-1.5 text-caption text-danger-text">
        <Icon name="alert" size={13} strokeWidth={2} />
        {error}
      </span>
    );
  }
  if (help !== undefined) {
    return (
      <span id={helpId} className="text-caption text-text-2">
        {help}
      </span>
    );
  }
  return null;
}

function describedBy(help: ReactNode, invalid: boolean, helpId: string, errorId: string): string | undefined {
  const ids = [help !== undefined && !invalid ? helpId : null, invalid ? errorId : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, labelAside, help, error, size = 'md', id, className = '', ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const invalid = error !== undefined && error !== '';

  return (
    <div className={`flex flex-col gap-1.5 text-ui ${className}`}>
      <LabelRow htmlFor={inputId} label={label} aside={labelAside} />
      <input
        ref={ref}
        id={inputId}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy(help, invalid, helpId, errorId)}
        className={inputClass(size, invalid)}
        {...rest}
      />
      <Below help={help} error={error} helpId={helpId} errorId={errorId} />
    </div>
  );
});

/**
 * A password field with the B1 reveal toggle: a 28px ghost button inside the
 * box, right 6 / top 6, that swaps the input between password and text.
 */
export const PasswordField = forwardRef<HTMLInputElement, Omit<FieldProps, 'type'>>(
  function PasswordField({ label, labelAside, help, error, size = 'lg', id, className = '', ...rest }, ref) {
    const [shown, setShown] = useState(false);
    const generated = useId();
    const inputId = id ?? generated;
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;
    const invalid = error !== undefined && error !== '';

    return (
      <div className={`flex flex-col gap-1.5 text-ui ${className}`}>
        <LabelRow htmlFor={inputId} label={label} aside={labelAside} />
        <span className="relative block">
          <input
            ref={ref}
            id={inputId}
            type={shown ? 'text' : 'password'}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy(help, invalid, helpId, errorId)}
            className={inputClass(size, invalid, size === 'lg' ? 'pr-11' : 'pr-10')}
            {...rest}
          />
          <button
            type="button"
            onClick={() => setShown((value) => !value)}
            aria-label={shown ? 'Hide password' : 'Show password'}
            aria-pressed={shown}
            className={[
              'absolute grid h-7 w-7 place-items-center rounded-badge text-text-2 hover:bg-tint',
              size === 'lg' ? 'right-1.5 top-1.5' : 'right-1 top-1',
            ].join(' ')}
          >
            <Icon name={shown ? 'eyeOff' : 'eye'} size={16} />
          </button>
        </span>
        <Below help={help} error={error} helpId={helpId} errorId={errorId} />
      </div>
    );
  },
);
