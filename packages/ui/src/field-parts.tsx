import type { ReactNode } from 'react';
import { Icon } from './icons.js';

/**
 * The label / help / error frame shared by the non-`<input>` form controls
 * (design/00 Design System.dc.html, "Form fields").
 *
 * `Field.tsx` owns this shape for text inputs; every specimen on the sheet
 * uses it — a 6px column of label, control, and one line below that is
 * either help in `text-2` or the error in danger with the alert icon. Select
 * and Textarea are the same field with a different box, so the frame lives
 * here rather than being written out twice.
 *
 * Internal: not exported from `index.ts`. The rules it encodes are Field's,
 * verbatim — the `<label>` is a sibling of the control so the error text
 * hangs off `aria-describedby` and never becomes part of the accessible
 * name.
 */

export interface FieldFrameRender {
  invalid: boolean;
  describedBy: string | undefined;
}

export interface FieldFrameProps {
  /** The control's id — the frame owns the label/help/error ids derived from it. */
  id: string;
  label: ReactNode;
  labelAside?: ReactNode | undefined;
  help?: ReactNode | undefined;
  error?: string | undefined;
  className?: string | undefined;
  children: (render: FieldFrameRender) => ReactNode;
}

export function FieldFrame({ id, label, labelAside, help, error, className = '', children }: FieldFrameProps) {
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const invalid = error !== undefined && error !== '';

  const ids = [help !== undefined && !invalid ? helpId : null, invalid ? errorId : null].filter(Boolean);
  const describedBy = ids.length > 0 ? ids.join(' ') : undefined;

  return (
    <div className={`flex flex-col gap-1.5 text-ui ${className}`}>
      <span className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="font-medium text-text">
          {label}
        </label>
        {labelAside}
      </span>

      {children({ invalid, describedBy })}

      {invalid ? (
        <span id={errorId} role="alert" className="flex items-center gap-1.5 text-caption text-danger-text">
          <Icon name="alert" size={13} strokeWidth={2} />
          {error}
        </span>
      ) : help !== undefined ? (
        <span id={helpId} className="text-caption text-text-2">
          {help}
        </span>
      ) : null}
    </div>
  );
}
