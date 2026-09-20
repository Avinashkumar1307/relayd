import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button.js';
import { Icon } from './icons.js';

/**
 * The clipboard glyph is the one icon this group needs that `icons.tsx`
 * does not have yet; the paths are the sheet's own (00 Design System, the
 * error card's copy control).
 */
function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 9h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/**
 * Error states (design/K System States.dc.html K4d, "Generic error state —
 * request ID in mono for support"; design/00 Design System.dc.html, "Empty
 * and error states" for the in-table size).
 *
 * The sheet's rule, verbatim: "Error: what failed, a request ID in mono for
 * support, and a retry. Every table page has both."
 *
 * Measured from K4d: a card at `padding: 72px 24px`, a 48px `radius: 12`
 * tile in `--danger-soft` on `--danger-text` with a 22px alert icon, the
 * heading at `18px/1.2/600`, the sentence at 13 on `--text-2` capped at
 * 460, then a mono chip — `height: 32; padding: 0 6px 0 12px; border: 1px
 * solid var(--border); radius: 6; background: var(--tint); JetBrains Mono
 * 13` — holding the request id and a Copy button, a 12px `--text-3` meta
 * line, and the actions row at `gap: 8; margin-top: 8`.
 *
 * The sheet's in-table version is the same block one size down: 56px
 * padding, a 44px tile, a 16px heading, a 360 cap and a 28px chip whose
 * copy control is a 22px icon button.
 *
 * The request id is the whole point of the component. It is the only thing
 * that lets support join this screen to a trace (CLAUDE.md section 2: "one
 * trace id from request → recipient → provider message id"), so it is
 * rendered in mono, selectable, and copyable in one click.
 */

export interface ErrorStateProps {
  title?: ReactNode | undefined;
  description?: ReactNode | undefined;
  /** The trace id. Shown in mono with a copy button when present. */
  requestId?: string | undefined;
  /** The line under the chip: "20 Sep 2026, 09:58:12 GST · HTTP 502". */
  meta?: ReactNode | undefined;
  onRetry?: (() => void) | undefined;
  retryLabel?: string | undefined;
  /** Quieter actions to the left of retry: "Status page", "Contact support". */
  actions?: ReactNode | undefined;
  /** `page` is K4d's whole page; `table` the sheet's in-card block. */
  size?: 'table' | 'page' | undefined;
  className?: string | undefined;
}

/** K4d's own copy — a generic error, generically worded. */
const DEFAULT_TITLE = 'Something went wrong on our side';
const DEFAULT_DESCRIPTION =
  'The request failed with a server error. Nothing you did caused it and no data was changed. Try again; if it keeps happening, send support the request ID below and we can trace exactly what happened.';

function RequestId({ id, size }: { id: string; size: 'table' | 'page' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    // `navigator.clipboard` is absent on an insecure origin and in jsdom.
    // Failing to copy must not take the error page down with it.
    void navigator.clipboard?.writeText(id).catch(() => undefined);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-badge border border-border bg-tint font-mono',
        size === 'page' ? 'h-8 pr-1.5 pl-3 text-ui' : 'h-7 pr-1.5 pl-2.5 text-caption',
      ].join(' ')}
    >
      <code>{id}</code>
      <button
        type="button"
        onClick={copy}
        title="Copy request ID"
        aria-label={copied ? 'Request ID copied' : 'Copy request ID'}
        className={[
          'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
          size === 'page'
            ? 'h-6 cursor-pointer rounded-4 border border-border bg-surface px-2 font-sans text-label font-medium text-text-2'
            : 'grid h-5.5 w-5.5 cursor-pointer place-items-center rounded-4 border-0 bg-transparent text-text-2',
        ].join(' ')}
      >
        {size === 'page' ? (
          copied ? (
            'Copied'
          ) : (
            'Copy'
          )
        ) : copied ? (
          <Icon name="check" size={13} strokeWidth={2} />
        ) : (
          <CopyIcon />
        )}
      </button>
    </span>
  );
}

export function ErrorState({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  requestId,
  meta,
  onRetry,
  retryLabel = 'Try again',
  actions,
  size = 'page',
  className = '',
}: ErrorStateProps) {
  const page = size === 'page';

  return (
    <div
      role="alert"
      className={[
        'flex flex-col items-center gap-3 rounded-card border border-border bg-surface px-6 text-center',
        page ? 'py-18' : 'py-14',
        className,
      ].join(' ')}
    >
      <span
        className={[
          'grid place-items-center rounded-card bg-danger-soft text-danger-text',
          page ? 'h-12 w-12' : 'h-11 w-11',
        ].join(' ')}
      >
        <Icon name="alert" size={page ? 22 : 20} />
      </span>

      <div className={`font-semibold leading-heading ${page ? 'text-[18px]' : 'text-card'}`}>{title}</div>

      {description === undefined ? null : (
        <div className={`text-ui text-pretty text-text-2 ${page ? 'max-w-115' : 'max-w-90'}`}>
          {description}
        </div>
      )}

      {requestId === undefined ? null : (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <RequestId id={requestId} size={size} />
          {meta === undefined ? null : <span className="text-caption text-text-3">{meta}</span>}
        </div>
      )}

      {actions === undefined && onRetry === undefined ? null : (
        <div className="mt-2 flex gap-2">
          {actions}
          {onRetry === undefined ? null : <Button onClick={onRetry}>{retryLabel}</Button>}
        </div>
      )}
    </div>
  );
}
