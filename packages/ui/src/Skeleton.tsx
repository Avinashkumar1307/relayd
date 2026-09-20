import type { CSSProperties, ReactNode } from 'react';

/**
 * Skeleton loaders (design/00 Design System.dc.html, "Skeleton loaders";
 * design/K System States.dc.html K4a/K4b/K4c and its `sk()` helper).
 *
 * The sheet's rule, verbatim: "Shapes match the final layout so nothing
 * jumps. Shimmer, no spinners, for anything longer than 300ms." K4a adds
 * the other half: "Header, tabs and actions are real so the page is
 * oriented before data arrives; row count matches the saved page size."
 *
 * That is why the three compositions below are the *body* of a page and not
 * the whole page: the title, the tabs and the buttons above them are the
 * real controls, rendered by the page itself.
 *
 * `sk()` in K is one shape: `linear-gradient(90deg, --neutral-soft 25%,
 * --tint 50%, --neutral-soft 75%)` at `background-size: 200% 100%` with the
 * `rl-shimmer` keyframes sliding it. The gradient is an inline style for the
 * same reason `Badge` uses one — a multi-stop gradient as a Tailwind
 * arbitrary value is longer and less legible than the declaration the design
 * already wrote — and the animation is the `animate-shimmer` token.
 *
 * Every shape is `aria-hidden`; the composition around it is the one thing a
 * screen reader hears, as a single `role="status"`.
 */

const SHIMMER: CSSProperties = {
  background: 'linear-gradient(90deg,var(--neutral-soft) 25%,var(--tint) 50%,var(--neutral-soft) 75%)',
  backgroundSize: '200% 100%',
};

export type SkeletonShape = 'line' | 'block' | 'circle';

export interface SkeletonProps {
  /** `line` 12/r4, `block` 32/r6, `circle` 36/round — K's `sk()` defaults. */
  shape?: SkeletonShape | undefined;
  width?: number | string | undefined;
  height?: number | string | undefined;
  radius?: number | 'full' | undefined;
  /** Layout only — never a colour, the shimmer owns that. */
  className?: string | undefined;
}

const SHAPE: Record<SkeletonShape, { width: number | string; height: number; radius: number | 'full' }> = {
  line: { width: '100%', height: 12, radius: 4 },
  block: { width: '100%', height: 32, radius: 6 },
  circle: { width: 36, height: 36, radius: 'full' },
};

export function Skeleton({ shape = 'line', width, height, radius, className = '' }: SkeletonProps) {
  const base = SHAPE[shape];
  const r = radius ?? base.radius;

  return (
    <span
      aria-hidden="true"
      className={`block flex-none animate-shimmer ${className}`}
      style={{
        ...SHIMMER,
        width: width ?? base.width,
        height: height ?? base.height,
        borderRadius: r === 'full' ? 9999 : r,
      }}
    />
  );
}

/** The single live-region wrapper every composition below announces through. */
function Loading({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    // `role="status"` takes no name from its contents, so the label is both
    // an `aria-label` (what the region is) and text inside it (what the live
    // region announces when it appears).
    <div role="status" aria-busy="true" aria-live="polite" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** K's row widths, so eight skeleton rows never look like eight identical ones. */
const WIDTHS = [0.72, 0.55, 0.64, 0.48, 0.7, 0.58, 0.66, 0.5] as const;

const pct = (n: number): string => `${n * 100}%`;

const CARD = 'bg-surface border border-border rounded-card';

/**
 * K4a — a table page's card: saved-view tabs, a filter row, the tinted
 * header strip, `rows` body rows on the contacts grid, and the footer.
 */
export interface TableSkeletonProps {
  /** "Row count matches the saved page size" — K4a's note. */
  rows?: number | undefined;
  /** The saved-view tab row above the filters (K4a has it, K4c does not). */
  tabs?: boolean | undefined;
  label?: string | undefined;
}

export function TableSkeleton({ rows = 8, tabs = true, label = 'Loading table' }: TableSkeletonProps) {
  const grid =
    'grid grid-cols-[44px_minmax(0,1.5fr)_minmax(0,1fr)_132px_minmax(0,1.1fr)_minmax(0,1fr)_124px_110px] items-center';

  return (
    <Loading label={label} className={`${CARD} overflow-hidden`}>
      {tabs ? (
        <div className="flex gap-4 border-b border-border px-4 py-3.5">
          <Skeleton width={90} height={14} />
          <Skeleton width={90} height={14} />
          <Skeleton width={90} height={14} />
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Skeleton width={120} height={28} radius={8} />
        <Skeleton width={120} height={28} radius={8} />
        <span className="flex-1" />
        <Skeleton width={220} height={30} radius={8} />
      </div>

      <div className="h-9 border-b border-border bg-tint" />

      {Array.from({ length: rows }, (_, i) => {
        const w = WIDTHS[i % WIDTHS.length] ?? 0.6;
        return (
          <div key={i} className={`${grid} border-b border-border py-3.25`}>
            <div className="pl-4">
              <Skeleton width={16} height={16} />
            </div>
            <div className="px-3">
              <Skeleton width={pct(w)} height={14} />
            </div>
            <div className="px-3">
              <Skeleton width={pct(1.2 - w)} height={14} />
            </div>
            <div className="px-3">
              <Skeleton width={84} height={22} radius={6} />
            </div>
            <div className="flex gap-1 px-3">
              <Skeleton width={48} height={20} radius={6} />
              <Skeleton width={48} height={20} radius={6} />
            </div>
            <div className="px-3">
              <Skeleton width="70%" />
            </div>
            <div className="px-3">
              <Skeleton width="60%" />
            </div>
            <div className="pr-4 pl-3">
              <Skeleton width="60%" />
            </div>
          </div>
        );
      })}

      <div className="flex justify-between px-4 py-3">
        <Skeleton width={160} />
        <Skeleton width={160} />
      </div>
    </Loading>
  );
}

// K4b's bars come from the real activity series; a skeleton has none, so
// this is a fixed profile of the same shape — 30 bars, never under 2px.
const BARS = [
  38, 52, 45, 61, 57, 72, 66, 49, 55, 63, 78, 70, 58, 44, 51, 67, 74, 82, 69, 60, 47, 56, 64, 77, 85, 71, 62, 54, 68, 80,
] as const;

/** K4b — the dashboard body: usage strip, stat row, provider strip, chart, table and the attention rail. */
export function DashboardSkeleton({ label = 'Loading dashboard' }: { label?: string }) {
  return (
    <Loading label={label}>
      <div className={`${CARD} mb-4 flex items-center gap-5 px-4.5 py-4`}>
        <Skeleton width={140} />
        <Skeleton width={120} height={24} radius={6} />
        <Skeleton height={8} className="flex-1" />
        <Skeleton width={140} />
      </div>

      <div className="mb-4 grid grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))] gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${CARD} flex flex-col gap-2.5 px-5 py-4.5`}>
            <Skeleton width={i === 0 ? 120 : 90} />
            <Skeleton width={i === 0 ? 160 : 100} height={i === 0 ? 32 : 24} radius={6} />
            <Skeleton width="70%" />
          </div>
        ))}
      </div>

      <div className="mb-5 grid grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${CARD} flex items-center gap-3 px-4 py-3.5`}>
            <Skeleton width={36} height={36} radius={8} />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton width="70%" />
              <Skeleton height={4} radius={2} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_352px] items-start gap-6">
        <div className="flex min-w-0 flex-col gap-5">
          <div className={`${CARD} px-4.5 py-4`}>
            <Skeleton width={140} />
            <div className="mt-4 flex h-40 items-end gap-1">
              {BARS.map((h, i) => (
                <Skeleton key={i} width="auto" height={`${h}%`} radius={2} className="flex-1" />
              ))}
            </div>
          </div>

          <div className={`${CARD} overflow-hidden`}>
            <div className="border-b border-border px-4.5 py-3.5">
              <Skeleton width={140} />
            </div>
            {WIDTHS.slice(0, 5).map((w, i) => (
              <div
                key={i}
                className="grid grid-cols-[minmax(0,1fr)_168px_120px_92px_88px] items-center border-b border-border py-3.5"
              >
                <div className="px-4.5">
                  <Skeleton width={pct(w)} height={14} />
                </div>
                <div className="px-3">
                  <Skeleton width={84} height={22} radius={6} />
                </div>
                <div className="px-3">
                  <Skeleton width={96} height={8} radius={4} />
                </div>
                <div className="px-3">
                  <Skeleton width="60%" />
                </div>
                <div className="px-3">
                  <Skeleton width="60%" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={`${CARD} flex flex-col gap-4 px-4.5 py-4`}>
          <Skeleton width={140} />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton width={26} height={26} radius={6} />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton width="80%" />
                <Skeleton height={10} />
                <Skeleton width="60%" height={10} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Loading>
  );
}

/** K4c — a detail page's body: the progress card, six stat tiles, the recipient table and the rail. */
export function DetailSkeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <Loading label={label}>
      <div className={`${CARD} mb-4 px-5 py-4.5`}>
        <div className="flex justify-between">
          <Skeleton width={140} />
          <Skeleton width={140} />
        </div>
        <Skeleton height={14} radius={7} className="mt-3.5" />
        <div className="mt-3 flex gap-5.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width={120} />
          ))}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-6 gap-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`${CARD} flex flex-col gap-2 px-3.5 py-3`}>
            <Skeleton width="60%" />
            <Skeleton width="50%" height={22} radius={6} />
            <Skeleton width="80%" height={11} />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4">
        <div className={`${CARD} overflow-hidden`}>
          <div className="flex gap-2 border-b border-border px-4 py-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width={120} height={28} radius={8} />
            ))}
          </div>
          <div className="h-9 border-b border-border bg-tint" />
          {WIDTHS.map((w, i) => (
            <div
              key={i}
              className="grid grid-cols-[minmax(0,1.3fr)_150px_minmax(0,1.4fr)_60px_140px_120px] items-center border-b border-border py-3.25"
            >
              <div className="px-4">
                <Skeleton width={pct(w)} height={14} />
              </div>
              <div className="px-3">
                <Skeleton width={84} height={22} radius={6} />
              </div>
              <div className="px-3">
                <Skeleton width={pct(1.2 - w)} height={14} />
              </div>
              <div className="px-3">
                <Skeleton width="60%" />
              </div>
              <div className="px-3">
                <Skeleton width="70%" />
              </div>
              <div className="pr-4 pl-3">
                <Skeleton width="60%" />
              </div>
            </div>
          ))}
        </div>

        <div className={`${CARD} flex flex-col gap-3.5 px-4.5 py-4`}>
          <Skeleton width={140} />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-2.5">
              <Skeleton width={8} height={8} radius={4} />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton width="80%" />
                <Skeleton height={10} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Loading>
  );
}
