import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Buttons (design/00 Design System.dc.html, "Buttons"; design/relayd-ui.js,
 * `BTN`).
 *
 * The sheet's rule: "One primary action per page. Danger is reserved for
 * destructive confirmations. Disabled buttons keep their label and explain
 * why in a tooltip."
 *
 * Two heights exist in the frames and both are here: 34px everywhere in the
 * app (`BTN` in relayd-ui.js), and 40px on the auth pages, where the whole
 * form is a size up (B1–B6 inputs and buttons are 40 with 14px text).
 *
 * `disabled` keeps the label and takes a `title` — the tooltip the sheet asks
 * for. A greyed button with no explanation is the most common way a UI says
 * "no" without saying why.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Shows a "working" state and blocks a second click. */
  pending?: boolean | undefined;
  /** Stretches to the container: the auth forms' submit. */
  block?: boolean | undefined;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-brand text-on-brand hover:bg-brand-hover',
  secondary: 'border-border bg-surface text-text hover:bg-tint',
  ghost: 'border-transparent bg-transparent text-text-2 hover:bg-tint hover:text-text',
  // #DC2626 / #FFFFFF in both themes (relayd-ui.js BTN.danger uses the hue,
  // not the themed text variant).
  danger: 'border-transparent bg-danger text-white hover:opacity-90',
};

const SIZE: Record<ButtonSize, string> = {
  md: 'h-[34px] px-3 text-ui',
  lg: 'h-10 px-4 text-body',
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  pending = false,
  block = false,
  disabled,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const inert = disabled === true || pending;

  return (
    <button
      type={type}
      disabled={inert}
      aria-busy={pending || undefined}
      className={[
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border font-medium',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
        // The sheet's disabled: neutral-soft on text-3, not-allowed, label kept.
        inert ? 'cursor-not-allowed border-transparent bg-neutral-soft text-text-3' : `cursor-pointer ${VARIANT[variant]}`,
        SIZE[size],
        block ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
