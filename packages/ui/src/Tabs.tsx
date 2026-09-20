import { useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * Underline tabs (design/G Campaigns.dc.html G1 `tabBtn`; design/F
 * Templates.dc.html and design/J Settings & API.dc.html for the page
 * variant; design/D Audience.dc.html D1 for the card variant).
 *
 * Measured, from `tabBtn`: `height: 44; padding: 0 10px; border: 0;
 * borderBottom: 2px solid brand|transparent; marginBottom: -1; fontSize: 13;
 * fontWeight: on ? 500 : 400`, the active one on `--text` and the rest on
 * `--text-2`. The strip itself is `border-bottom: 1px solid var(--border)`
 * and the tabs sit on top of it, which is what the -1px is for.
 *
 * Two placements, both in the frames:
 *   `page` — F/J: a bare strip above the content, `gap:4; margin-bottom:20`,
 *            items padded `10px 12px`.
 *   `card` — D1/G1: the first row inside a table card, `padding: 0 16px`,
 *            items 44px tall.
 *
 * Counts are a plain `--text-3` span after the label, not a pill: that is
 * how F, J and G1 all draw them.
 *
 * Keyboard: one stop in the tab order, arrows move between tabs and select
 * as they go (the ARIA "automatic activation" pattern — these tabs filter a
 * table, so moving to one and not applying it would be a lie).
 */

export interface TabItem {
  key: string;
  label: ReactNode;
  /** Shown after the label in `--text-3`, as F/J/G1 draw it. */
  count?: number | string | undefined;
  disabled?: boolean | undefined;
}

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onChange: (key: string) => void;
  variant?: 'page' | 'card' | undefined;
  /** Names the tablist for a screen reader: "Campaign states". */
  label: string;
  /** The right-hand slot on G1's strip: the search box. */
  actions?: ReactNode | undefined;
  className?: string | undefined;
}

const STRIP: Record<'page' | 'card', string> = {
  page: 'flex gap-1 border-b border-border mb-5 text-ui',
  card: 'flex items-center gap-1 px-4 border-b border-border text-ui',
};

const ITEM: Record<'page' | 'card', string> = {
  page: 'px-3 py-2.5',
  card: 'h-11 px-2.5',
};

export function Tabs({ items, value, onChange, variant = 'page', label, actions, className = '' }: TabsProps) {
  const strip = useRef<HTMLDivElement>(null);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;

    const enabled = items.filter((item) => item.disabled !== true);
    if (enabled.length === 0) return;

    const at = enabled.findIndex((item) => item.key === value);
    const last = enabled.length - 1;
    let next = at;
    if (event.key === 'ArrowLeft') next = at <= 0 ? last : at - 1;
    if (event.key === 'ArrowRight') next = at >= last ? 0 : at + 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = last;

    const target = enabled[next];
    if (target === undefined) return;

    event.preventDefault();
    onChange(target.key);

    const buttons = strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[items.findIndex((item) => item.key === target.key)]?.focus();
  };

  return (
    <div ref={strip} role="tablist" aria-label={label} onKeyDown={move} className={`${STRIP[variant]} ${className}`}>
      {items.map((item) => {
        const on = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            data-tab={item.key}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            disabled={item.disabled === true}
            onClick={() => onChange(item.key)}
            className={[
              'inline-flex items-center gap-1.5 whitespace-nowrap border-0 border-b-2 -mb-px bg-transparent',
              'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
              ITEM[variant],
              on ? 'border-brand font-medium text-text' : 'border-transparent font-normal text-text-2',
              item.disabled === true ? 'cursor-not-allowed text-text-3' : 'cursor-pointer',
            ].join(' ')}
          >
            {item.label}
            {item.count === undefined ? null : <span className="text-text-3 tabular-nums">{item.count}</span>}
          </button>
        );
      })}
      {actions === undefined ? null : (
        <>
          <span className="flex-1" />
          {actions}
        </>
      )}
    </div>
  );
}
