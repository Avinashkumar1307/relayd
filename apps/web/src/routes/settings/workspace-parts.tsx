import type { ReactNode, SelectHTMLAttributes } from 'react';
import { Icon, TONES, useToast, type Tone, type ToastApi } from '@relayd/ui';
import type { WorkspaceRole } from '@relayd/types';
import type { SessionDevice } from '../../api/workspace.js';

/**
 * The pieces sections J1, J2, J5 and J6 share.
 *
 * Nothing here re-implements a component from the design-system sheet. Each
 * is either a measurement the sheet does not name (the section heading above
 * a card, the read-only detail row) or a variant of a sheet component the
 * sheet itself draws differently on these frames (a role pill with no dot, a
 * label-less select inside a table cell, a filter chip).
 */

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

/**
 * `useToast()` that survives a missing provider.
 *
 * `apps/web/src/main.tsx` does not mount `<ToastProvider>` yet and the real
 * hook throws without one, which would take a settings page down over a
 * confirmation message. Until the provider is there (main.tsx is shared, and
 * not this section's file to edit) the absence degrades to no toast and
 * every page still works. `routes/billing/parts.tsx` carries the same
 * stopgap; both go the day the provider is mounted.
 */
const NO_TOAST: ToastApi = { toast: () => '', dismiss: () => undefined };

export function useSafeToast(): ToastApi {
  try {
    return useToast();
  } catch {
    return NO_TOAST;
  }
}

/** The tooltip on every control a suspended workspace withholds (K2). */
export const READ_ONLY_TITLE = 'Workspace is read-only';

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Times are shown in the workspace's zone, because J1 says so out loud:
 * "Schedules, reports and audit times use this zone", and J6's description
 * repeats it ("Times in Asia/Dubai"). A log read in the wrong zone is worse
 * than no log — two people comparing notes reach different conclusions about
 * the same row.
 */
/**
 * The months are spelled out here rather than taken from the locale because
 * `en-GB` abbreviates September to "Sept", and every J frame writes "Sep".
 * `routes/analytics/format.ts` writes down the same rule.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fields(value: string, timeZone: string): Record<string, string> | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone });
  } catch {
    // An unknown zone must not take the page down; UTC and a visible time
    // beat a crash, and the workspace's zone is shown on J1 either way.
    formatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' });
  }

  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value;
  return out;
}

/** "14 Feb 2026" — J1's Created row, J2a's Expires column. */
export function formatDate(value: string, timeZone: string): string {
  const part = fields(value, timeZone);
  if (part === null) return value;
  return `${Number(part['day'])} ${MONTHS[Number(part['month']) - 1] ?? ''} ${part['year']}`;
}

/** "19 Sep 2026, 10:42:18" — J6's Time column. */
export function formatDateTime(value: string, timeZone: string): string {
  const part = fields(value, timeZone);
  if (part === null) return value;
  return `${formatDate(value, timeZone)}, ${part['hour']}:${part['minute']}:${part['second']}`;
}

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

export const ROLE_LABEL: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

/**
 * J2b's role descriptions, verbatim. They are the only place in the product
 * that says what a role means in a sentence, so they are copy, not a gloss.
 */
export const ROLE_DESCRIPTION: Readonly<Record<Exclude<WorkspaceRole, 'owner'>, string>> = {
  admin: 'Everything except billing. Can approve launches and manage the team.',
  editor: 'Builds campaigns, templates and segments. Requests launches; cannot launch.',
  viewer: 'Read-only access to dashboard, campaigns and reports.',
};

/** J2a colours Editor success and Viewer neutral; the other two follow the ladder. */
const ROLE_TONE: Readonly<Record<WorkspaceRole, Tone>> = {
  owner: 'brand',
  admin: 'info',
  editor: 'success',
  viewer: 'neutral',
};

/**
 * A role pill.
 *
 * `Badge` from the sheet always draws its 6px dot; J2a's invitation pills
 * have none — relayd-ui.js hands `badgeStyle` and `dotStyle` back separately
 * and this frame uses only the first. The tone table is still the sheet's,
 * so no colour is invented here.
 */
export function RolePill({ role }: { role: WorkspaceRole }) {
  const tone = TONES[ROLE_TONE[role]];
  return (
    <span
      className="inline-flex h-5.5 items-center rounded-badge border border-transparent px-2 text-caption font-medium whitespace-nowrap"
      style={{ color: tone.fg, background: tone.bg }}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Page furniture                                                      */
/* ------------------------------------------------------------------ */

/**
 * The heading above a card: 16/600 with one 13px line under it.
 *
 * Measured from J1 ("Workspace details", "Danger zone") and J5 ("Change
 * password", "Active sessions"). `PageHeader` is the page's own title and is
 * a size up; `CardHeader` lives inside a card. This sits between them, and
 * the frames use it on four of the six J pages.
 */
export function SectionHeading({
  title,
  description,
  actions,
  tone = 'default',
}: {
  title: ReactNode;
  description?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  tone?: 'default' | 'danger' | undefined;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h2
          className={`m-0 text-card leading-heading font-semibold ${tone === 'danger' ? 'text-danger-text' : ''}`}
        >
          {title}
        </h2>
        {description === undefined ? null : (
          <p className="mt-1 mb-0 text-ui text-text-2">{description}</p>
        )}
      </div>
      {actions}
    </div>
  );
}

/** One row of J1's read-only identifier list: label left, value right. */
export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <span className="text-text-2">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-right">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

export interface InlineSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** The accessible name; there is no visible label in a table cell. */
  label: string;
  /** The 28px table-cell control (J2a) or the 28px filter chip (J6). */
  variant?: 'cell' | 'chip' | undefined;
  /** The chip's dim prefix: "Actor", "Action", "Date". */
  prefix?: string | undefined;
}

/**
 * A select with no visible label.
 *
 * `Select` from the sheet always renders a `<label>` above the box, which is
 * right for a form and wrong inside a table row (J2a's Role column) and on a
 * filter strip (J6). Same geometry, same chevron, name on `aria-label`.
 */
export function InlineSelect({
  label,
  variant = 'cell',
  prefix,
  className = '',
  ...rest
}: InlineSelectProps) {
  return (
    <span
      className={[
        'relative inline-flex h-7 items-center gap-1.5 rounded-control border border-border pr-6 pl-2.5',
        variant === 'chip' ? 'bg-tint text-caption text-text-2' : 'bg-surface text-ui',
        className,
      ].join(' ')}
    >
      {prefix === undefined ? null : <span>{prefix}</span>}
      <select
        aria-label={label}
        className={[
          'cursor-pointer appearance-none border-0 bg-transparent py-0 font-medium text-text outline-none',
          'focus-visible:ring-[3px] focus-visible:ring-brand-soft',
          'disabled:cursor-not-allowed disabled:text-text-3',
          variant === 'chip' ? 'text-caption' : 'text-ui',
        ].join(' ')}
        {...rest}
      />
      {/* right 8px, as measured; `pointer-events-none` so the whole chip
          still opens the list. */}
      <Icon
        name="chevronDown"
        size={12}
        strokeWidth={2}
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-text-3"
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Device glyphs (J5)                                                  */
/* ------------------------------------------------------------------ */

/**
 * The three session glyphs.
 *
 * `ICON_PATHS` in `@relayd/ui` carries the navigation and the chrome; J5 is
 * the only frame that draws a monitor, a phone and a question mark, and the
 * paths below are copied from it verbatim.
 */
const DEVICE_PATHS: Readonly<Record<SessionDevice, string>> = {
  desktop: 'M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 21h8M12 17v4',
  mobile: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
  unknown: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
};

export function DeviceIcon({ kind }: { kind: SessionDevice }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={DEVICE_PATHS[kind]} />
    </svg>
  );
}
