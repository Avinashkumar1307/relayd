import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './icons.js';

/**
 * The search field (design/Shell.dc.html, the top-bar well; design/D
 * Audience.dc.html, the table toolbars).
 *
 * Two measured forms, and they are different controls in the frames:
 *   md 34px × 280, on `bg`, 14px icon, with the ⌘K chip — the top bar
 *   sm 30px × 240, transparent, 13px icon                — a table toolbar
 *
 * Both are a bordered row, so the focus ring lives on the wrapper
 * (`focus-within`) and the input itself is borderless and transparent —
 * otherwise the sheet's "3px brand-soft ring" would be drawn inside the box
 * instead of around it.
 *
 * There is no visible label in any frame, so `label` is required and becomes
 * the accessible name. A search box whose only clue is a placeholder is
 * unlabelled the moment somebody types in it.
 */

export type SearchInputSize = 'sm' | 'md';

const BOX: Record<SearchInputSize, string> = {
  sm: 'h-[30px] gap-2 px-2.5 bg-transparent',
  md: 'h-[34px] gap-2 pl-2.5 pr-2 bg-bg',
};

const WIDTH: Record<SearchInputSize, string> = { sm: 'w-60', md: 'w-[280px]' };
const GLYPH: Record<SearchInputSize, number> = { sm: 13, md: 14 };

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** The accessible name: "Search contacts". */
  label: string;
  size?: SearchInputSize | undefined;
  /** Stretch instead of taking the frame's measured 240 / 280. */
  fullWidth?: boolean | undefined;
  /** Shown when there is something to clear. */
  onClear?: (() => void) | undefined;
  /** The shortcut chip at the right end — `⌘K` in the top bar. */
  kbd?: ReactNode | undefined;
  wrapperClassName?: string | undefined;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { label, size = 'sm', fullWidth = false, onClear, kbd, wrapperClassName = '', className = '', value, ...rest },
  ref,
) {
  const clearable = onClear !== undefined && value !== undefined && value !== '';

  return (
    <div
      className={[
        'flex items-center rounded-control border border-border text-ui text-text',
        'focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand-soft',
        BOX[size],
        fullWidth ? 'w-full' : WIDTH[size],
        wrapperClassName,
      ].join(' ')}
    >
      <Icon name="search" size={GLYPH[size]} strokeWidth={2} className="flex-none text-text-3" />

      <input
        ref={ref}
        type="search"
        aria-label={label}
        value={value}
        className={`min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3 ${className}`}
        {...rest}
      />

      {clearable ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear ${label.toLowerCase()}`}
          className="grid h-5 w-5 flex-none cursor-pointer place-items-center rounded-badge text-text-3 hover:bg-tint hover:text-text"
        >
          <Icon name="x" size={13} strokeWidth={2} />
        </button>
      ) : null}

      {kbd === undefined ? null : (
        <kbd className="flex-none rounded-4 border border-border bg-surface px-[5px] py-px font-mono text-label font-medium text-text-2">
          {kbd}
        </kbd>
      )}
    </div>
  );
});
