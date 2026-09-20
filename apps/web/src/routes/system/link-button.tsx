import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * A link wearing a button's clothes.
 *
 * Section-local on purpose. `@relayd/ui`'s `Button` is a `<button>` and has
 * no `as`/`href` escape hatch, and three of the actions section K has to
 * draw are anchors in the export rather than buttons: A4's "Go to your
 * dashboard", and K4d's "Status page". Rendering a `<button>` that
 * navigates would take middle-click, "open in new tab" and the status bar
 * away from a destination that has a URL.
 *
 * The classes are `Button`'s own, copied from one place so the two stay the
 * same shape: 34px, `rounded-control`, 13px medium, the same focus ring.
 * `lg` is the 44px A4 uses for its pair of actions.
 */

const VARIANT = {
  primary: 'border-transparent bg-brand text-white hover:bg-brand-hover',
  secondary: 'border-border bg-surface text-text hover:bg-tint',
} as const;

const SIZE = {
  md: 'h-[34px] px-3 text-ui',
  lg: 'h-11 px-4.5 text-[15px]',
} as const;

export interface LinkButtonProps {
  /** An in-app route. Use `href` for anything outside the SPA. */
  to?: string | undefined;
  /** An external or absent destination — the export writes these as "#". */
  href?: string | undefined;
  variant?: keyof typeof VARIANT | undefined;
  size?: keyof typeof SIZE | undefined;
  children: ReactNode;
}

export function LinkButton({ to, href, variant = 'secondary', size = 'md', children }: LinkButtonProps) {
  const className = [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border font-medium no-underline',
    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
    VARIANT[variant],
    SIZE[size],
  ].join(' ');

  if (to !== undefined) {
    return (
      <Link to={to} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <a href={href ?? '#'} className={className}>
      {children}
    </a>
  );
}
