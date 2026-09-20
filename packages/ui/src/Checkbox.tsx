import { forwardRef, useId, useState, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { ICON_PATHS } from './icons.js';

/**
 * A checkbox (design/00 Design System.dc.html, "Form fields", the consent
 * pair; the same box is the table's select-all and J3b's scope chips).
 *
 * The sheet's rule, verbatim: "Required compliance controls are always on
 * and say so." — which is why `description` is a first-class prop: the
 * consent box on the sheet carries "Required to continue. Recorded in the
 * audit log with your name and time." directly under its label.
 *
 * Measured geometry. Two sizes, both from the export:
 *   md 18px, radius 5, 12px tick  — the form-field specimen
 *   sm 16px, radius 4, 11px tick  — the table's select-all (`box(on, 16)`)
 * On: brand fill, brand border, white tick. Off: surface fill, field border.
 *
 * The native input is `sr-only` rather than absent — it keeps the role, the
 * space key, the form value and the label association — and the visible box
 * is its `peer`, so focus and disabled styling come from the input's own
 * state and never drift from it.
 *
 * Indeterminate is reported as `aria-checked="mixed"`. The DOM
 * `indeterminate` property only changes how the *native* box paints, and
 * this one is hidden; the value a screen reader reads is the aria state.
 */

export type CheckboxSize = 'sm' | 'md';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'children'> {
  label: ReactNode;
  /** The second line under the label — the consent box's audit-log sentence. */
  description?: ReactNode | undefined;
  size?: CheckboxSize | undefined;
  /** Some but not all of the rows below are selected. */
  indeterminate?: boolean | undefined;
}

/** The minus bar the table's select-all draws when the page is partly selected. */
const MINUS_PATH = 'M5 12h14';

const BOX: Record<CheckboxSize, string> = {
  sm: 'h-4 w-4 rounded-4',
  md: 'h-[18px] w-[18px] rounded-5',
};

const MARK: Record<CheckboxSize, number> = { sm: 11, md: 12 };

function Mark({ d, size }: { d: string; size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    label,
    description,
    size = 'md',
    indeterminate = false,
    id,
    className = '',
    disabled,
    checked,
    defaultChecked,
    onChange,
    ...rest
  },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const labelId = `${inputId}-label`;
  const descriptionId = `${inputId}-description`;

  // The box is drawn from React, so an uncontrolled checkbox has to be
  // followed: without this the native input would flip and the painted box
  // would not.
  const [uncontrolled, setUncontrolled] = useState(defaultChecked === true);
  const on = checked === undefined ? uncontrolled : checked;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (checked === undefined) setUncontrolled(event.currentTarget.checked);
    onChange?.(event);
  };

  return (
    <label
      htmlFor={inputId}
      className={[
        'flex items-start gap-2.5 text-ui',
        disabled === true ? 'cursor-not-allowed text-text-3' : 'cursor-pointer',
        className,
      ].join(' ')}
    >
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className="peer sr-only"
        disabled={disabled}
        {...(checked === undefined ? { defaultChecked: defaultChecked === true } : { checked })}
        onChange={handleChange}
        aria-checked={indeterminate ? 'mixed' : undefined}
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        {...rest}
      />

      <span
        aria-hidden="true"
        className={[
          'mt-px grid flex-none place-items-center border text-white',
          on || indeterminate ? 'border-brand bg-brand' : 'border-border bg-surface',
          'peer-focus-visible:ring-[3px] peer-focus-visible:ring-brand-soft',
          'peer-disabled:border-border peer-disabled:bg-tint peer-disabled:text-text-3',
          BOX[size],
        ].join(' ')}
      >
        {indeterminate ? (
          <Mark d={MINUS_PATH} size={MARK[size]} />
        ) : on ? (
          <Mark d={ICON_PATHS.check} size={MARK[size]} />
        ) : null}
      </span>

      <span>
        <span id={labelId}>{label}</span>
        {description === undefined ? null : (
          <span id={descriptionId} className="block text-caption text-text-2">
            {description}
          </span>
        )}
      </span>
    </label>
  );
});
