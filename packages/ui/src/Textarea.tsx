import { forwardRef, useId, type CSSProperties, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { FieldFrame } from './field-parts.js';
import { inputClass, type FieldSize } from './Field.js';

/**
 * A textarea (design/00 Design System.dc.html, "Form fields", the "Internal
 * notes" specimen).
 *
 * Measured: `rows="2"`, 8px/12px padding, the field border and radius,
 * `resize: vertical`. Everything except the padding and the resize handle is
 * an input's box, so the class comes from `inputClass` — but that helper
 * prescribes a control *height* (36 / 40), which a textarea must not have.
 * `height: auto` is set inline rather than as a `h-auto` utility because two
 * height utilities on one element resolve by stylesheet order, which is not
 * ours to depend on; an inline style always wins and says why.
 *
 * The sheet shows no character counter, so there is none here.
 */

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  label: ReactNode;
  labelAside?: ReactNode | undefined;
  help?: ReactNode | undefined;
  error?: string | undefined;
  size?: FieldSize | undefined;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, labelAside, help, error, size = 'md', rows = 2, id, className = '', style, ...rest },
  ref,
) {
  const generated = useId();
  const areaId = id ?? generated;
  const box: CSSProperties = { height: 'auto', ...style };

  return (
    <FieldFrame id={areaId} label={label} labelAside={labelAside} help={help} error={error} className={className}>
      {({ invalid, describedBy }) => (
        <textarea
          ref={ref}
          id={areaId}
          rows={rows}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={inputClass(size, invalid, 'resize-y py-2 leading-body')}
          style={box}
          {...rest}
        />
      )}
    </FieldFrame>
  );
});
