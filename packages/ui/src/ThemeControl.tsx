import { useRef, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './icons.js';
import { useThemePreference, type ThemePreference } from './theme.js';

/**
 * The light / dark / system control.
 *
 * ## Why this has no frame of its own
 *
 * The export has dark variants (C2 dashboard, G3d campaign detail, G4b
 * analytics, F2c template editor) but draws no control anywhere for
 * switching between them: it shows what dark mode looks like without saying
 * where you turn it on. This component is therefore a deliberate, documented
 * addition at the owner's request, not something measured off a frame — and
 * it is built entirely out of the design's existing vocabulary rather than a
 * new one.
 *
 * ## Geometry
 *
 * The segmented variant is the export's own segmented control, measured from
 * design/F Templates.dc.html line 167 — the editor's Desktop / Mobile
 * preview switcher:
 *
 *   wrapper `inline-flex; border: 1px solid var(--border); border-radius: 8;
 *            overflow: hidden`
 *   segment `inline-flex; gap: 5; height: 26; padding: 0 8px; border: 0;
 *            borderLeft: 1px solid var(--border) on all but the first;
 *            background: on ? var(--brand-soft) : var(--surface);
 *            color: on ? var(--brand) : var(--text-2);
 *            fontSize: 12; fontWeight: 500`
 *
 * Every option carries its icon *and* its word, because the sheet's rule is
 * that colour is never the only signal.
 *
 * The icon variant is a sidebar control and takes the sidebar tokens, the
 * same ones the collapse toggle and Sign out use: `text-sidebar-muted` with
 * `hover:bg-white/[.08] hover:text-white`.
 *
 * ## Semantics
 *
 * Segmented is a `radiogroup` with roving tabstops: one stop in the tab
 * order, arrows move between the options and select as they go. The icon
 * button is a plain button that cycles, and its label says both where it is
 * and what pressing it will do — "Theme: System (matches your device).
 * Switch to Light." — because an icon that changes meaning on every press
 * has to say so out loud.
 */

interface ThemeOption {
  value: ThemePreference;
  label: string;
  icon: IconName;
  /** The tooltip on the icon variant and on the System segment. */
  hint: string;
}

const SYSTEM: ThemeOption = { value: 'system', label: 'System', icon: 'monitor', hint: 'matches your device' };

const OPTIONS: readonly ThemeOption[] = [
  SYSTEM,
  { value: 'light', label: 'Light', icon: 'sun', hint: 'always light' },
  { value: 'dark', label: 'Dark', icon: 'moon', hint: 'always dark' },
];

function optionFor(preference: ThemePreference): ThemeOption {
  return OPTIONS.find((option) => option.value === preference) ?? SYSTEM;
}

/** system → light → dark → system. */
function nextAfter(preference: ThemePreference): ThemeOption {
  const at = OPTIONS.findIndex((option) => option.value === preference);
  return OPTIONS[(at + 1) % OPTIONS.length] ?? SYSTEM;
}

export type ThemeControlVariant = 'segmented' | 'icon';

export interface ThemeControlProps {
  /** `segmented` for a settings page, `icon` for the sidebar's user row. */
  variant?: ThemeControlVariant | undefined;
  /** Names the group for assistive tech; the segmented variant's only label. */
  label?: string | undefined;
  className?: string | undefined;
}

export function ThemeControl({ variant = 'segmented', label = 'Theme', className = '' }: ThemeControlProps) {
  const { preference, setPreference } = useThemePreference();
  const group = useRef<HTMLDivElement>(null);

  if (variant === 'icon') {
    const current = optionFor(preference);
    const next = nextAfter(preference);
    const title = `${label}: ${current.label} (${current.hint}). Switch to ${next.label}.`;

    return (
      <button
        type="button"
        onClick={() => setPreference(next.value)}
        title={title}
        aria-label={title}
        className={[
          'grid h-7 w-7 flex-none place-items-center rounded-badge',
          'text-sidebar-muted hover:bg-white/[.08] hover:text-white',
          className,
        ].join(' ')}
      >
        <Icon name={current.icon} size={16} />
      </button>
    );
  }

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !back) return;

    const at = OPTIONS.findIndex((option) => option.value === preference);
    const target = OPTIONS[(at + (forward ? 1 : -1) + OPTIONS.length) % OPTIONS.length];
    if (target === undefined) return;

    event.preventDefault();
    setPreference(target.value);
    group.current?.querySelector<HTMLButtonElement>(`[data-theme-option="${target.value}"]`)?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      className={`inline-flex overflow-hidden rounded-control border border-border ${className}`}
    >
      {OPTIONS.map((option, index) => {
        const on = option.value === preference;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-theme-option={option.value}
            title={`${option.label} — ${option.hint}`}
            onClick={() => setPreference(option.value)}
            className={[
              'inline-flex h-[26px] cursor-pointer items-center gap-[5px] whitespace-nowrap px-2 text-caption font-medium',
              'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
              index === 0 ? '' : 'border-l border-border',
              on ? 'bg-brand-soft text-brand' : 'bg-surface text-text-2 hover:bg-tint hover:text-text',
            ].join(' ')}
          >
            <Icon name={option.icon} size={13} strokeWidth={2} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
