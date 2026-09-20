import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type SVGProps } from 'react';

/**
 * Row-actions menu (design/G Campaigns.dc.html, the campaigns table row;
 * design/F Templates.dc.html, the template card).
 *
 * Measured from the G1 row: a 28px transparent trigger with a 6px radius
 * and the horizontal three-dot glyph at 16px / stroke 2.5, hovering to
 * neutral-soft; the panel 190px wide and 2px below it, right-aligned, on the
 * surface with a 1px border, an 8px radius, the overlay shadow, 4px of
 * padding and `z-index: 5`; items `8px 10px` with a 6px radius, hovering to
 * tint, 13px. Destructive items are `danger-text` — G computes exactly that
 * with `/Cancel|Delete/.test(label)`.
 *
 * The frames show the panel open and nothing else; the keyboard contract is
 * the ARIA menu pattern: the trigger says `aria-haspopup`, Down/Up open it
 * on the first/last item, arrows and Home/End move, Escape closes and hands
 * focus back to the trigger, a click elsewhere closes it.
 *
 * A disabled item keeps its label and says why in a tooltip — the sheet's
 * button rule, which matters more here, where the item is the only place
 * that explains a "no". It is `aria-disabled`, not `disabled`, so it stays
 * in the arrow-key order and can actually be read.
 */

/** The horizontal three dots. `icons.tsx` has no ellipsis; see the report. */
const MORE_PATH = 'M12 12h.01M19 12h.01M5 12h.01';

function MoreIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={MORE_PATH} />
    </svg>
  );
}

export type MenuItemTone = 'default' | 'danger' | 'muted';

const ITEM_TONE: Record<MenuItemTone, string> = {
  default: 'text-text',
  danger: 'text-danger-text',
  muted: 'text-text-2',
};

export interface MenuItem {
  key: string;
  label: string;
  onSelect?: (() => void) | undefined;
  /** `danger` for Cancel and Delete, `muted` for Archive — the frames' colours. */
  tone?: MenuItemTone | undefined;
  disabled?: boolean | undefined;
  /** Why it is disabled. Required in spirit: a greyed row with no reason says nothing. */
  reason?: string | undefined;
  /** Draws the 1px rule above this item, as the templates menu does before Archive. */
  separatorBefore?: boolean | undefined;
}

export interface MenuProps {
  items: readonly MenuItem[];
  /** The trigger's accessible name and tooltip. */
  label?: string | undefined;
  /** Panel width; the campaigns row measures 190, the template card 170. */
  width?: number | undefined;
}

export function Menu({ items, label = 'Quick actions', width = 190 }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Outside click, exactly as the shell's workspace switcher does it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[active]?.focus();
  }, [open, active]);

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openAt(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(Math.max(items.length - 1, 0));
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = items.length - 1;
    if (event.key === 'Escape') {
      // Stops here so an Escape inside a dialog's row menu closes the menu
      // and leaves the dialog open.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index >= last ? 0 : index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index <= 0 ? last : index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(last);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const select = (item: MenuItem) => {
    if (item.disabled === true) return;
    close(true);
    item.onSelect?.();
  };

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onTriggerKeyDown}
        className="grid h-7 w-7 cursor-pointer place-items-center rounded-badge bg-transparent text-text-2 hover:bg-neutral-soft"
      >
        <MoreIcon />
      </button>

      {!open ? null : (
        <ul
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="absolute top-[30px] right-0 z-[5] rounded-control border border-border bg-surface p-1 text-ui shadow-overlay"
          style={{ width }}
        >
          {items.map((item, index) => (
            <Fragment key={item.key}>
              {item.separatorBefore === true ? <li role="separator" className="my-1 border-t border-border" /> : null}
              <li role="none">
                <button
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={index === active ? 0 : -1}
                  aria-disabled={item.disabled === true ? true : undefined}
                  title={item.reason}
                  onClick={() => select(item)}
                  onMouseEnter={() => setActive(index)}
                  className={[
                    'block w-full rounded-badge px-2.5 py-2 text-left hover:bg-tint',
                    item.disabled === true
                      ? 'cursor-not-allowed text-text-3'
                      : `cursor-pointer ${ITEM_TONE[item.tone ?? 'default']}`,
                  ].join(' ')}
                >
                  {item.label}
                </button>
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </span>
  );
}
