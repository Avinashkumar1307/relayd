import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Tone } from './states.js';

/**
 * Toasts (design/00 Design System.dc.html, "Toasts").
 *
 * The sheet's rule, verbatim: "Bottom-right, one line, optional action,
 * dismiss after 6 seconds (errors stay)."
 *
 * Measured from the sheet: the stack is fixed at right 24 / bottom 24, 360px
 * wide, 8px between toasts, `z-index: 100`. Each toast is `12px 14px` on the
 * surface with the one overlay shadow, an 8px radius and a 3px left border
 * in the tone's hue — that border is the only colour on it. One line: a 500
 * title, then the detail in text-2 after a middot, then the optional action
 * and the dismiss.
 *
 * ## No icon
 *
 * The sheet's toast has none — the tone is the left border and the title is
 * the message. Adding one would be inventing a component the design does not
 * have (CLAUDE.md section 15), so the announcement carries the meaning
 * instead: `role="alert"` for danger, `role="status"` for the rest.
 *
 * ## "Errors stay"
 *
 * A danger toast defaults to no timeout, because the thing it is reporting
 * usually needs the request id in it. Everything else goes after 6s.
 */

export type ToastTone = Extract<Tone, 'success' | 'info' | 'warning' | 'danger'>;

/** The sheet's timing. */
export const TOAST_DURATION = 6000;

const BORDER: Record<ToastTone, string> = {
  success: 'border-l-success',
  info: 'border-l-info',
  warning: 'border-l-warning',
  danger: 'border-l-danger',
};

export interface ToastOptions {
  /** Defaults to `info`. */
  tone?: ToastTone | undefined;
  /** "Draft saved", "Export failed" — 500 weight, always present. */
  title: string;
  /** "Autumn Escapes, 10:42", "request req_01J8ZK3VQ7M2" — shown after a middot. */
  description?: string | undefined;
  action?: { label: string; onClick: () => void } | undefined;
  /** ms, or `null` to stay until dismissed. Defaults to 6000, and to `null` for danger. */
  duration?: number | null | undefined;
}

export interface ToastRecord extends ToastOptions {
  id: string;
}

export interface ToastProps {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
  dismissLabel?: string | undefined;
}

/** One toast. Exported so a page can render the sheet's row outside the stack. */
export function Toast({ toast, onDismiss, dismissLabel = 'Dismiss' }: ToastProps) {
  const tone = toast.tone ?? 'info';
  const duration = toast.duration === undefined ? (tone === 'danger' ? null : TOAST_DURATION) : toast.duration;

  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (duration === null) return;
    const timer = setTimeout(() => dismissRef.current(toast.id), duration);
    return () => clearTimeout(timer);
  }, [duration, toast.id]);

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={[
        'flex items-center gap-2.5 rounded-control border-l-[3px] bg-surface px-3.5 py-3 text-ui text-text shadow-overlay',
        BORDER[tone],
      ].join(' ')}
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium">{toast.title}</span>
        {toast.description === undefined ? null : <span className="text-text-2"> · {toast.description}</span>}
      </span>
      {toast.action === undefined ? null : (
        <button
          type="button"
          onClick={toast.action.onClick}
          className="flex-none cursor-pointer font-medium text-brand no-underline"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label={dismissLabel}
        className="flex-none cursor-pointer text-text-3"
      >
        ✕
      </button>
    </div>
  );
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    nextId.current += 1;
    const id = `toast-${nextId.current}`;
    setItems((current) => [...current, { ...options, id }]);
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {items.length === 0
        ? null
        : createPortal(
            <div
              data-rl-toasts=""
              className="fixed right-6 bottom-6 z-[100] flex w-[360px] max-w-[calc(100vw-48px)] flex-col gap-2"
            >
              {items.map((item) => (
                <Toast key={item.id} toast={item} onDismiss={dismiss} />
              ))}
            </div>,
            document.body,
          )}
    </ToastContext.Provider>
  );
}

/**
 * The toast api. Throws outside a `ToastProvider` rather than returning a
 * no-op: a "saved" that silently never appears is worse than a crash in
 * development (CLAUDE.md section 6.5 — never swallow an error to return a
 * default).
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used inside a <ToastProvider>');
  return api;
}
