import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { FieldFrame } from './field-parts.js';
import { inputClass, type FieldSize } from './Field.js';
import { Icon } from './icons.js';

/**
 * A select (design/00 Design System.dc.html, "Form fields", the Timezone
 * specimen; the same control is the Environment and Expires field on J3b).
 *
 * The sheet draws it as a 36px box with the field border and a 14px
 * `chevronDown` in `text-2` at the right edge — the same geometry as a text
 * input, which is why the box comes from `inputClass` rather than a second
 * copy of those rules. Two things are added: `appearance-none`, so the
 * browser's own arrow is not drawn beside ours, and 32px of right padding so
 * a long option ("Asia/Dubai · GST (UTC+4)") never runs under the chevron.
 *
 * It is a real `<select>`. The frames show a custom popover nowhere, and the
 * native control brings type-ahead, the mobile wheel and the platform's own
 * keyboard handling for free.
 */

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label: ReactNode;
  /** Shown to the right of the label — "· optional" on J3b's Expires. */
  labelAside?: ReactNode | undefined;
  help?: ReactNode | undefined;
  error?: string | undefined;
  size?: FieldSize | undefined;
  children: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, labelAside, help, error, size = 'md', id, className = '', children, ...rest },
  ref,
) {
  const generated = useId();
  const selectId = id ?? generated;

  return (
    <FieldFrame id={selectId} label={label} labelAside={labelAside} help={help} error={error} className={className}>
      {({ invalid, describedBy }) => (
        <span className="relative block">
          <select
            ref={ref}
            id={selectId}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className={inputClass(size, invalid, 'cursor-pointer appearance-none pr-8')}
            {...rest}
          >
            {children}
          </select>
          {/* right 10px, as measured; `pointer-events-none` so the whole box
              still opens the list. */}
          <Icon
            name="chevronDown"
            size={14}
            strokeWidth={2}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-2"
          />
        </span>
      )}
    </FieldFrame>
  );
});
