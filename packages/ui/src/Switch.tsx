import { useId, type ReactNode } from 'react';

/**
 * A switch (design/00 Design System.dc.html, "Form fields", the tracking
 * row).
 *
 * Measured: a 36×20 track, radius 10, brand when on and `seg-pending` when
 * off, with a 16px white knob 2px inside the track — left 2 off, left 18 on.
 * The sheet shows exactly one size.
 *
 * The third row on the sheet is the one that matters: "Unsubscribe link"
 * carries an "Always on" chip with a lock and is drawn at 0.55 opacity. That
 * is the sheet's rule for a compliance control — it is shown, it is on, and
 * it says why it cannot be moved. `locked` is that state; `aside` is the
 * slot the chip goes in.
 *
 * It is a `role="switch"` button, not a checkbox: the frames read it as a
 * setting that takes effect, not a form value to submit.
 */

export interface SwitchProps {
  label: ReactNode;
  /** A muted suffix on the label — "(approximate)" on Open tracking. */
  hint?: ReactNode | undefined;
  /** A chip after the label — the "Always on" lock on Unsubscribe link. */
  aside?: ReactNode | undefined;
  checked: boolean;
  onChange?: ((next: boolean) => void) | undefined;
  disabled?: boolean | undefined;
  /** Compliance controls: on, dimmed, and not movable. */
  locked?: boolean | undefined;
  /** The reason, as a tooltip — a control that says no says why. */
  title?: string | undefined;
  className?: string | undefined;
}

export function Switch({
  label,
  hint,
  aside,
  checked,
  onChange,
  disabled = false,
  locked = false,
  title,
  className = '',
}: SwitchProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const inert = disabled || locked;

  return (
    <div className={`flex items-center justify-between gap-3 text-ui ${className}`}>
      <span className="flex items-center gap-1.5">
        <span id={labelId}>{label}</span>
        {hint === undefined ? null : <span className="text-text-2">{hint}</span>}
        {aside}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={inert}
        title={title}
        onClick={inert ? undefined : () => onChange?.(!checked)}
        className={[
          'relative h-5 w-9 flex-none rounded-full',
          'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
          checked ? 'bg-brand' : 'bg-seg-pending',
          inert ? 'cursor-not-allowed opacity-[0.55]' : 'cursor-pointer',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ${checked ? 'left-[18px]' : 'left-0.5'}`}
        />
      </button>
    </div>
  );
}
