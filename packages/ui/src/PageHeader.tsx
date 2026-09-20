import type { ReactNode } from 'react';

/**
 * The page title block (design/D Audience.dc.html D1, design/G
 * Campaigns.dc.html G1, design/01 Shell + Dashboard options.dc.html 1a,
 * design/K System States.dc.html K4c — they all draw the same header).
 *
 * Measured: `display:flex; align-items:flex-end; justify-content:
 * space-between; gap:16px; margin-bottom:20px`, an `<h1>` at
 * `24px/1.2/600, letter-spacing -0.01em` (the sheet's `text-title`), a
 * description at the inherited 14 on `--text-2` with `margin: 4px 0 0`, and
 * the actions in a `gap:8px` row.
 *
 * A detail page (K4c) is the same header with two additions: the row aligns
 * to the top rather than the baseline because a back link sits above the
 * title, and a state badge sits beside the title. Both are slots here, so a
 * campaign page and a list page are the same component.
 *
 * Tabs, when a page has them, go underneath — F and J both put the strip
 * directly after this block, and `Tabs variant="page"` already carries its
 * own 20px bottom margin.
 */

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode | undefined;
  /** Right-hand buttons. */
  actions?: ReactNode | undefined;
  /** A back link or breadcrumb above the title (K4c). */
  back?: ReactNode | undefined;
  /** A state badge beside the title (K4c). */
  badge?: ReactNode | undefined;
  /** Rendered under the header — a `Tabs variant="page"`. */
  tabs?: ReactNode | undefined;
  className?: string | undefined;
}

export function PageHeader({ title, description, actions, back, badge, tabs, className = '' }: PageHeaderProps) {
  // K4c's detail header aligns to the top once a back link is above the
  // title; without one the frames align the actions to the title baseline.
  const align = back === undefined ? 'items-end' : 'items-start';

  return (
    <>
      {/*
        The row wraps below the `sm` breakpoint and only then. On a phone the
        title and its actions cannot both fit on one line, and because the
        actions are `flex-none` the row would otherwise refuse to shrink,
        stretch the shell's content column past the viewport and take every
        page on the screen with it — the description clipped mid-word, cards
        running off the right edge. Above `sm` nothing changes: one line,
        actions right, exactly as the frames draw it.
      */}
      <div className={`flex flex-wrap ${align} justify-between gap-4 mb-5 sm:flex-nowrap ${className}`}>
        <div className="min-w-0">
          {back === undefined ? null : <div className="mb-2.5 text-caption">{back}</div>}
          <div className="flex items-center gap-2.5">
            <h1 className="m-0 min-w-0 text-title font-semibold leading-heading tracking-heading">{title}</h1>
            {badge}
          </div>
          {description === undefined ? null : <p className="mt-1 mb-0 text-body text-text-2">{description}</p>}
        </div>
        {actions === undefined ? null : (
          <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {tabs}
    </>
  );
}
