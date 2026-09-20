import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ICON_PATHS } from './icons.js';

/**
 * The copy button (design/00 Design System.dc.html, "Monospace IDs and
 * reveal-once secrets"; the same control on E1d and J3c).
 *
 * The export's behaviour is one line —
 * `copy(text, id) { navigator.clipboard.writeText(text); …
 *   setTimeout(() => this.setState({ copied: null }), 1500) }`
 * with the label read through `cb = (id) => copied === id ? 'Copied' : 'Copy'`.
 * So: the label swaps to "Copied" and back after 1.5 seconds, and the word
 * is always there — an icon that changes shape is not an announcement.
 *
 * Three measured sizes, all from the frames:
 *   xs 22px, borderless, 11px — inside an ID chip
 *   sm 26px, bordered,   11px — inside the sheet's read-only mono field
 *   md 32px, bordered,   12px — inside the 44px reveal-once field (E1d, J3c)
 */

/** Two rectangles; icons.tsx has no copy glyph yet. */
const COPY_PATH =
  'M9 9h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1';

export type CopyButtonSize = 'xs' | 'sm' | 'md';

const SIZE: Record<CopyButtonSize, string> = {
  xs: 'h-[22px] gap-1 rounded-4 border-transparent bg-transparent px-1.5 text-label text-text-2',
  sm: 'h-[26px] gap-1.5 rounded-badge border-border bg-surface px-2 text-label text-text-2 hover:bg-tint',
  md: 'h-8 gap-1.5 rounded-badge border-border bg-surface px-2.5 text-caption text-text hover:bg-tint',
};

export interface CopyButtonProps {
  /** What lands on the clipboard. */
  text: string;
  label?: string | undefined;
  copiedLabel?: string | undefined;
  size?: CopyButtonSize | undefined;
  /** Icon only — the label still names the target for assistive tech. */
  iconOnly?: boolean | undefined;
  /** Overrides the accessible name: "Copy campaign ID", not just "Copy". */
  ariaLabel?: string | undefined;
  /** How long the confirmation stands. The export uses 1500ms. */
  resetAfterMs?: number | undefined;
  onCopied?: (() => void) | undefined;
  /** The clipboard can be refused (permissions, insecure origin); never silent. */
  onError?: ((error: unknown) => void) | undefined;
  className?: string | undefined;
}

function Glyph({ d, size }: { d: string; size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  size = 'sm',
  iconOnly = false,
  ariaLabel,
  resetAfterMs = 1500,
  onCopied,
  onError,
  className = '',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const word: ReactNode = copied ? copiedLabel : label;

  const onClick = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    const written = clipboard === undefined ? Promise.reject(new Error('Clipboard unavailable')) : clipboard.writeText(text);

    void written.then(
      () => {
        setCopied(true);
        onCopied?.();
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetAfterMs);
      },
      (error: unknown) => {
        onError?.(error);
      },
    );
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={ariaLabel ?? label}
      aria-label={iconOnly ? (copied ? copiedLabel : (ariaLabel ?? label)) : ariaLabel}
      className={[
        'inline-flex flex-none cursor-pointer items-center whitespace-nowrap border font-medium',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
        SIZE[size],
        className,
      ].join(' ')}
    >
      <Glyph d={copied ? ICON_PATHS.check : COPY_PATH} size={13} />
      {iconOnly ? null : (
        <span aria-live="polite" className="whitespace-nowrap">
          {word}
        </span>
      )}
    </button>
  );
}
