import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './icons.js';

/**
 * The segmented progress bar (design/00 Design System.dc.html, "Segmented
 * progress bar"; design/relayd-ui.js, `SEG_LEGEND`, `HATCH`, `segments()`).
 *
 * The sheet's rule, verbatim: "One bar per campaign. Segment order is fixed:
 * delivered → pending/queued → sending → soft bounce → hard bounce/complaint/
 * failed → delivery uncertain. Counts always appear in the legend."
 *
 * `SEG_ORDER` below is `SEG_LEGEND` from relayd-ui.js, key for key and label
 * for label, with each colour resolved to the token that holds it:
 * `#10B981` is `--success`, `#F59E0B` is `--warning`, `#DC2626` is
 * `--danger` and `#64748B` (the hatch) is `--uncertain`. Those four hues are
 * not redefined in the dark block of `tokens.css`, which is why the design
 * writes them literally and why using the token changes nothing but the
 * spelling.
 *
 * Geometry, measured: the bar is `height: 12; border-radius: 6; overflow:
 * hidden; background: var(--neutral-soft)` and each segment is a flex item
 * at its exact percentage with `min-width: 3` (4 for the hatch, which also
 * carries a 1px dashed inset outline). The small variant in a table cell or
 * a summary card is `height: 8; border-radius: 4`.
 *
 * Delivery uncertain is hatched and never hidden — INVARIANTS D3: those
 * recipients are unbilled and have to be visible in the report.
 */

export interface SegmentCounts {
  delivered?: number | undefined;
  pending?: number | undefined;
  queued?: number | undefined;
  sending?: number | undefined;
  soft?: number | undefined;
  hard?: number | undefined;
  complaint?: number | undefined;
  failed?: number | undefined;
  uncertain?: number | undefined;
}

export type SegmentKey = 'delivered' | 'pending' | 'sending' | 'soft' | 'danger' | 'uncertain';

export interface SegmentDefinition {
  key: SegmentKey;
  label: string;
  /** The token utility that paints it, or `hatch` for delivery uncertain. */
  fill: string;
}

export const SEG_ORDER: readonly SegmentDefinition[] = [
  { key: 'delivered', label: 'Delivered', fill: 'bg-success' },
  { key: 'pending', label: 'Pending / queued', fill: 'bg-seg-pending' },
  { key: 'sending', label: 'Sending', fill: 'bg-brand' },
  { key: 'soft', label: 'Soft bounce', fill: 'bg-warning' },
  { key: 'danger', label: 'Hard bounce / complaint / failed', fill: 'bg-danger' },
  { key: 'uncertain', label: 'Delivery uncertain', fill: 'hatch' },
];

/** relayd-ui.js `HATCH`, with `#64748B` spelled as the token that holds it. */
const HATCH_BAR: CSSProperties = {
  background: 'repeating-linear-gradient(135deg,var(--uncertain) 0 2px,transparent 2px 5px)',
  outline: '1px dashed var(--uncertain)',
  outlineOffset: '-1px',
};

/** relayd-ui.js `swatchStyle('hatch')` — a finer 1.5/4 hatch at 10px. */
const HATCH_SWATCH: CSSProperties = {
  background: 'repeating-linear-gradient(135deg,var(--uncertain) 0 1.5px,transparent 1.5px 4px)',
  outline: '1px dashed var(--uncertain)',
  outlineOffset: '-1px',
};

/** relayd-ui.js `fmt`. */
export const fmtCount = (n: number): string => n.toLocaleString('en-US');

/** relayd-ui.js `segments()`: the six buckets, folded from the raw counts. */
export function segmentValues(counts: SegmentCounts): Record<SegmentKey, number> {
  return {
    delivered: counts.delivered ?? 0,
    pending: (counts.pending ?? 0) + (counts.queued ?? 0),
    sending: counts.sending ?? 0,
    soft: counts.soft ?? 0,
    danger: (counts.hard ?? 0) + (counts.complaint ?? 0) + (counts.failed ?? 0),
    uncertain: counts.uncertain ?? 0,
  };
}

export interface SegmentedBarProps {
  counts: SegmentCounts;
  /** The denominator: `campaign.recipients`. Zero renders the empty track. */
  total: number;
  /** `md` is the 12px campaign bar; `sm` the 8px one in a card or a cell. */
  size?: 'sm' | 'md' | undefined;
  /** Counts under the bar. Off for the table-cell variant. */
  legend?: boolean | undefined;
  /** The title row above the bar: name left, "x of y processed · n%" right. */
  label?: ReactNode | undefined;
  /** The right half of that row. */
  labelAside?: ReactNode | undefined;
  /**
   * The "not billed" footnote, shown by default whenever a hatched segment
   * exists. The sheet prints it verbatim; it is never hidden silently.
   */
  note?: boolean | undefined;
  className?: string | undefined;
}

const UNCERTAIN_NOTE =
  'Delivery uncertain: the provider may have accepted these; we could not confirm. Not billed.';

export function SegmentedBar({
  counts,
  total,
  size = 'md',
  legend = true,
  label,
  labelAside,
  note = true,
  className = '',
}: SegmentedBarProps) {
  const values = segmentValues(counts);
  const present = SEG_ORDER.filter((seg) => values[seg.key] > 0);

  const summary = present.map((seg) => `${seg.label} ${fmtCount(values[seg.key])}`).join(', ');

  return (
    <div className={className}>
      {label === undefined && labelAside === undefined ? null : (
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate font-semibold">{label}</span>
          {labelAside === undefined ? null : <span className="flex-none text-ui text-text-2">{labelAside}</span>}
        </div>
      )}

      <div
        role="img"
        aria-label={total > 0 ? summary : 'No recipients yet'}
        className={[
          'flex overflow-hidden bg-neutral-soft',
          size === 'md' ? 'h-3 rounded-badge' : 'h-2 rounded-4',
        ].join(' ')}
      >
        {total > 0
          ? present.map((seg) => {
              const hatched = seg.fill === 'hatch';
              return (
                <div
                  key={seg.key}
                  title={`${seg.label}: ${fmtCount(values[seg.key])}`}
                  className={`flex-none ${hatched ? '' : seg.fill}`}
                  style={{
                    width: `${(values[seg.key] / total) * 100}%`,
                    minWidth: hatched ? 4 : 3,
                    ...(hatched ? HATCH_BAR : null),
                  }}
                />
              );
            })
          : null}
      </div>

      {legend ? (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-ui">
          {present.map((seg) => (
            <span key={seg.key} className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 flex-none rounded-2 ${seg.fill === 'hatch' ? '' : seg.fill}`}
                style={seg.fill === 'hatch' ? HATCH_SWATCH : undefined}
              />
              <span className="text-text-2">{seg.label}</span>
              <span className="font-medium tabular-nums">{fmtCount(values[seg.key])}</span>
            </span>
          ))}
        </div>
      ) : null}

      {note && values.uncertain > 0 ? (
        <div className="mt-2.5 flex items-center gap-1.5 text-caption text-text-2">
          <Icon name="info" size={13} strokeWidth={2} />
          {UNCERTAIN_NOTE}
        </div>
      ) : null}
    </div>
  );
}
