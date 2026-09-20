import { useId, type ReactNode, type Ref, type SVGProps } from 'react';
import { Icon } from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import { SYSTEM_TAGS } from '../../api/templates.js';

/**
 * The pieces section F's frames draw that `@relayd/ui` does not carry: the
 * three glyphs the icon set is missing, the 26px inline select in a card
 * toolbar, the Desktop/Mobile pair, the card thumbnail, the code gutter and
 * the lint strip under the editor.
 *
 * Every measurement is read off `.design-rendered/frames/F/*.html`. Nothing
 * here re-implements something `@relayd/ui` already exports — the badges,
 * menu, tabs, modal, empty and error states and every button come from there.
 */

/* ----------------------------------------------------------------- icons -- */

/**
 * `@relayd/ui`'s `ICON_PATHS` has no clock, monitor or phone; F2a's header
 * and preview toolbar need all three. Reported under uiGaps.
 */
type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'd'> & { d: string; size?: number };

function Glyph({ d, size = 14, ...rest }: GlyphProps) {
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
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

export const ClockIcon = (props: Omit<GlyphProps, 'd'>) => (
  <Glyph d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2" {...props} />
);

export const MonitorIcon = (props: Omit<GlyphProps, 'd'>) => (
  <Glyph
    size={13}
    d="M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 21h8M12 17v4"
    {...props}
  />
);

export const PhoneIcon = (props: Omit<GlyphProps, 'd'>) => (
  <Glyph size={13} d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01" {...props} />
);

/* --------------------------------------------------------- inline selects -- */

/**
 * A bordered select that sits inside a toolbar rather than a form.
 *
 * F1's "Sort · Last edited" is 34px and F2a's "Preview as" is 26px; both put
 * their label beside the control, not above it, so `@relayd/ui`'s `Select` —
 * which always stacks a `FieldFrame` label — cannot draw either. Reported
 * under uiGaps.
 */
export function InlineSelect({
  label,
  value,
  onChange,
  size = 'md',
  inset = false,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  size?: 'sm' | 'md';
  /** F1's Sort control keeps its label inside the box; F2a's keeps it outside. */
  inset?: boolean;
  children: ReactNode;
}) {
  const id = useId();

  const field = (
    <span className="relative inline-block min-w-0">
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={[
          'w-full min-w-0 cursor-pointer appearance-none truncate text-text outline-none',
          'focus-visible:ring-[3px] focus-visible:ring-brand-soft',
          inset
            ? 'h-[32px] border-0 bg-transparent pr-5 pl-1 text-ui font-medium'
            : size === 'sm'
              ? 'h-6.5 rounded-badge border border-border bg-surface pr-6 pl-2 text-caption'
              : 'h-[34px] rounded-control border border-border bg-surface pr-7 pl-2 text-ui font-medium',
        ].join(' ')}
      >
        {children}
      </select>
      <Icon
        name="chevronDown"
        size={12}
        strokeWidth={2}
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-text-3 ${inset ? 'right-1' : 'right-2'}`}
      />
    </span>
  );

  return (
    <span
      className={
        inset
          ? 'inline-flex h-[34px] min-w-0 items-center gap-1 rounded-control border border-border bg-surface pl-2.5 text-ui text-text'
          : 'inline-flex min-w-0 items-center gap-2 text-text-2'
      }
    >
      <label htmlFor={id} className={size === 'sm' && !inset ? 'text-caption' : 'text-ui'}>
        {label}
      </label>
      {field}
    </span>
  );
}

/* ------------------------------------------------------ segmented toggle -- */

export interface ToggleOption<T extends string> {
  value: T;
  label: string;
  icon: ReactNode;
}

/** F2a's Desktop / Mobile pair: one 26px bordered box, brand-soft when on. */
export function SegmentedToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly ToggleOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <span role="group" aria-label={label} className="inline-flex overflow-hidden rounded-control border border-border">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={[
            'inline-flex h-6.5 cursor-pointer items-center gap-1.5 border-0 px-2 text-caption font-medium',
            index === 0 ? '' : 'border-l border-border',
            option.value === value ? 'bg-brand-soft text-brand' : 'bg-surface text-text-2',
          ].join(' ')}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- chips -- */

/** F2b's "Always on": an 18px neutral pill with a padlock. */
export function LockChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[18px] flex-none items-center gap-1 rounded-badge bg-neutral-soft px-1.5 text-label font-medium text-neutral-text">
      <Icon name="lock" size={10} strokeWidth={2.25} />
      {children}
    </span>
  );
}

/** F2a's amber "required" pill inside the merge-tag picker. */
export function RequiredChip() {
  return (
    <span className="inline-flex h-5 flex-none items-center rounded-badge bg-warning-soft px-[7px] text-label font-medium text-warning-text">
      required
    </span>
  );
}

/* ------------------------------------------------------------ thumbnail -- */

/**
 * The card thumbnail on F1: a miniature of the email, not a render of it.
 *
 * The greys and the header colour are the *email's* palette rather than the
 * app's — an email is a document with its own brand, and a workspace whose
 * header is teal has to look teal here. They are therefore inline styles and
 * not token utilities; listed under cannotReproduce.
 */
const PAPER = { background: '#FFFFFF', borderColor: '#E5E7EB', boxShadow: '0 1px 2px rgba(17, 24, 39, 0.05)' };
const BLOCK = { background: '#E5E7EB' };
const HEADING = { background: '#111827', opacity: 0.8 };
const BODY_LINE = { background: '#D1D5DB' };
const CTA = { background: '#4F46E5' };

export function TemplateThumb({ accent, hero }: { accent: string; hero: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="block h-[168px] overflow-hidden border-b border-border bg-tint px-7 pt-3.5"
    >
      <span className="block h-full overflow-hidden rounded-t-badge border" style={PAPER}>
        <span className="block h-[18px]" style={{ background: accent }} />
        <span className="flex flex-col gap-1.5 px-3 py-2.5">
          {hero ? <span className="block h-9 rounded-3" style={BLOCK} /> : null}
          <span className="block h-1.5 w-[70%] rounded-2" style={HEADING} />
          <span className="block h-1 w-[92%] rounded-2" style={BODY_LINE} />
          <span className="block h-1 w-[84%] rounded-2" style={BODY_LINE} />
          <span className="block h-1 w-[60%] rounded-2" style={BODY_LINE} />
          <span className="mt-0.5 block h-3 w-16 rounded-3" style={CTA} />
        </span>
      </span>
    </span>
  );
}

/* ----------------------------------------------------------------- lint -- */

export interface LintResult {
  /** Every template must carry `{{unsubscribe_url}}`; the line it is on. */
  unsubscribeLine: number | null;
  /** Merge tags written without a `|fallback`, in source order. */
  missingFallback: string[];
  /** Images with no `alt`, and the first line one is on. */
  imagesWithoutAlt: number;
  firstImageLine: number | null;
  lines: number;
  bytes: number;
}

const TAG = /\{\{\s*([A-Za-z0-9_]+)\s*(\|[^}]*)?\}\}/gu;
const IMG = /<img\b[^>]*>/giu;

/**
 * The three checks F2a's strip reports, computed from the source.
 *
 * It is a lint, not a gate: the server runs the authoritative version at
 * publish. Showing it live is what stops "Hi ," reaching 48,000 inboxes.
 */
export function lintHtml(html: string): LintResult {
  const lines = html.split('\n');

  let unsubscribeLine: number | null = null;
  const missingFallback: string[] = [];
  let imagesWithoutAlt = 0;
  let firstImageLine: number | null = null;

  lines.forEach((line, index) => {
    for (const match of line.matchAll(TAG)) {
      const field = match[1] ?? '';
      if (field === 'unsubscribe_url' && unsubscribeLine === null) unsubscribeLine = index + 1;
      if (match[2] === undefined && !SYSTEM_TAGS.includes(field) && !missingFallback.includes(field)) {
        missingFallback.push(field);
      }
    }

    for (const image of line.matchAll(IMG)) {
      if (/\balt\s*=/iu.test(image[0])) continue;
      imagesWithoutAlt += 1;
      if (firstImageLine === null) firstImageLine = index + 1;
    }
  });

  return {
    unsubscribeLine,
    missingFallback,
    imagesWithoutAlt,
    firstImageLine,
    lines: lines.length,
    bytes: new TextEncoder().encode(html).length,
  };
}

/** "1.4 KB", the way the strip writes it. */
export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function LintItem({ tone, children }: { tone: 'pass' | 'warn' | 'fail'; children: ReactNode }) {
  return (
    <span
      className={`inline-flex min-w-0 items-start gap-1.5 ${
        tone === 'pass' ? 'text-success-text' : tone === 'warn' ? 'text-text-2' : 'text-danger-text'
      }`}
    >
      {tone === 'pass' ? (
        <Icon name="check" size={12} strokeWidth={3} className="mt-0.5 flex-none" />
      ) : (
        <Icon
          name="alert"
          size={12}
          strokeWidth={2.5}
          className={`mt-0.5 flex-none ${tone === 'warn' ? 'text-warning-text' : ''}`}
        />
      )}
      {children}
    </span>
  );
}

/** F2a's footer strip: three checks on the left, the file's size on the right. */
export function LintBar({ lint }: { lint: LintResult }) {
  return (
    <div className="flex items-center gap-3.5 border-t border-border px-3.5 py-2 text-caption text-text-2">
      {lint.unsubscribeLine === null ? (
        <LintItem tone="fail">Unsubscribe link missing</LintItem>
      ) : (
        <LintItem tone="pass">Unsubscribe link present</LintItem>
      )}

      {lint.missingFallback.length === 0 ? (
        <LintItem tone="pass">All merge tags have fallbacks</LintItem>
      ) : (
        <LintItem tone="warn">
          {lint.missingFallback.length === 1
            ? `1 merge tag without a fallback · ${lint.missingFallback[0] ?? ''}`
            : `${lint.missingFallback.length} merge tags without a fallback`}
        </LintItem>
      )}

      {lint.imagesWithoutAlt === 0 ? null : (
        <LintItem tone="warn">
          {lint.imagesWithoutAlt === 1 ? '1 image' : `${lint.imagesWithoutAlt} images`} without alt
          text {lint.firstImageLine === null ? '' : `· line ${lint.firstImageLine}`}
        </LintItem>
      )}

      <span className="flex-1" />
      <span className="tabular-nums">{`${lint.lines} lines · ${formatBytes(lint.bytes)} · HTML`}</span>
    </div>
  );
}

/* ----------------------------------------------------------- code editor -- */

/**
 * The source editor: a plain `<textarea>` with a line-number gutter.
 *
 * No editor library and no new dependency. The gutter and the field share the
 * scroll container and the same 12px/1.7 mono metrics, so the numbers line up
 * without a scroll listener; the textarea is sized to its content (`rows`)
 * and never scrolls itself vertically. `wrap="off"` keeps one source line on
 * one row, which is the only way a line number can mean anything.
 */
export function CodeEditor({
  id,
  label,
  value,
  onChange,
  readOnly = false,
  textareaRef,
}: {
  id: string;
  label: string;
  value: string;
  onChange?: ((value: string) => void) | undefined;
  readOnly?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement> | undefined;
}) {
  const rows = Math.max(value.split('\n').length, 20);

  return (
    <div className="grid min-h-[480px] flex-1 grid-cols-[36px_1fr] gap-3 overflow-auto bg-tint px-3.5 py-3 font-mono text-caption leading-[1.7] lg:min-h-[620px]">
      <div aria-hidden="true" className="select-none text-right text-text-3">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>

      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        ref={textareaRef}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        wrap="off"
        rows={rows}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full min-w-0 resize-none overflow-x-auto border-0 bg-transparent p-0 font-mono text-caption leading-[1.7] text-text outline-none"
      />
    </div>
  );
}

/* ---------------------------------------------------------------- errors -- */

/** The server's sentence, punctuated, or a neutral one when there is none. */
export function sentence(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return message.endsWith('.') ? message : `${message}.`;
}

/** The trace id, when the failure carried one. Spread into `ErrorState`. */
export function requestId(error: unknown): { requestId?: string } {
  return error instanceof ApiError && error.requestId !== undefined
    ? { requestId: error.requestId }
    : {};
}
