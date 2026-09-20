import type { CSSProperties, ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from 'recharts';
import { CARD_SURFACE, HEALTH, Icon, StateBadge, fmtCount } from '@relayd/ui';
import type { DashboardProvider, Rate } from '../../api/analytics.js';

/**
 * The pieces the dashboard (C1–C4, Cm) and the campaign report (G4a, G4b)
 * are built from, measured off the frames.
 *
 * Everything here is presentational: it takes numbers and returns the block
 * the frame draws. The pages decide what to ask for and what to do when the
 * answer is missing.
 *
 * Two rules from docs/06 §13 are load-bearing rather than decorative, and
 * both are visible in these components rather than in a tooltip:
 *
 *   the click rate is the headline — it is the only card at 32px, and it is
 *   marked `data-headline` so a redesign has to remove it deliberately;
 *
 *   the open rate always carries "approximate" and a tilde. A customer who
 *   decides on a number inflated 30–60% by privacy proxies was misled by us,
 *   and a disclosure nobody hovers is not a disclosure.
 */

/**
 * relayd-ui.js `HATCH` / `swatchStyle('hatch')`, for delivery uncertain.
 *
 * `SegmentedBar` holds the same two objects privately, which is right for a
 * bar; the usage band and the standalone legend here need the swatch without
 * a bar around it.
 */
const HATCH_SWATCH: CSSProperties = {
  background: 'repeating-linear-gradient(135deg,var(--uncertain) 0 1.5px,transparent 1.5px 4px)',
  outline: '1px dashed var(--uncertain)',
  outlineOffset: '-1px',
};

export function HatchSwatch() {
  return <span aria-hidden="true" className="h-2.5 w-2.5 flex-none rounded-2" style={HATCH_SWATCH} />;
}

/** The pill beside a stat label: "Headline", "3". */
export function Chip({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone: 'brand' | 'warning' | 'neutral';
  title?: string;
}) {
  const style = {
    brand: 'bg-brand-soft text-brand',
    warning: 'bg-warning-soft text-warning-text',
    neutral: 'bg-neutral-soft text-neutral-text',
  }[tone];

  return (
    <span
      title={title}
      className={`inline-flex h-5 flex-none items-center gap-1 rounded-badge px-[7px] text-label font-medium ${style} ${
        title === undefined ? '' : 'cursor-help'
      }`}
    >
      {children}
    </span>
  );
}

/** C1's "approximate" chip. Always rendered, never on hover. */
export const APPROXIMATE_TITLE =
  'Opens are inflated by privacy proxies (Apple Mail Privacy Protection, Gmail image caching). Treat as directional only.';

export function ApproximateChip({ title = APPROXIMATE_TITLE }: { title?: string }) {
  return (
    <Chip tone="neutral" title={title}>
      approximate
      <Icon name="info" size={11} strokeWidth={2} />
    </Chip>
  );
}

/**
 * The header's range control (C1: "This billing period ⌄").
 *
 * A real `<select>` styled as the frame's 34px secondary button. `Select`
 * from `@relayd/ui` is the form field — it always draws a label above the
 * box, which is right in a form and wrong in a page header, where the
 * current value *is* the label.
 */
export function RangePicker<T extends string>({
  value,
  options,
  onChange,
  label = 'Date range',
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <span className="relative inline-flex">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-[34px] cursor-pointer appearance-none rounded-control border border-border bg-surface pr-8 pl-3 text-ui font-medium text-text focus-visible:ring-[3px] focus-visible:ring-brand-soft focus-visible:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevronDown"
        size={14}
        strokeWidth={2}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text-2"
      />
    </span>
  );
}

/**
 * The plan-usage band (C1's "Emails sent this period", Cm's compact card).
 *
 * The delivery-uncertain count sits in it at every width: those recipients
 * are unbilled (D3) and the number that explains a gap between "sent" and
 * "delivered" belongs next to the one being charged for.
 */
export function UsageBand({
  sent,
  limit,
  renewsLabel,
  renewsShort,
  uncertain,
}: {
  sent: number;
  limit: number;
  renewsLabel: string;
  /** Cm prints "Renews 1 Oct"; the percentage and the countdown do not fit. */
  renewsShort: string;
  uncertain: number;
}) {
  const pct = limit > 0 ? Math.min(100, (sent / limit) * 100) : 0;

  const track = (
    <div className="h-2 flex-1 overflow-hidden rounded-4 bg-neutral-soft">
      <div className="h-full rounded-4 bg-brand" style={{ width: `${pct}%` }} />
    </div>
  );

  return (
    <div className={`${CARD_SURFACE} mb-3 px-3.5 py-3.5 sm:mb-4 sm:px-4.5`}>
      <div className="hidden items-center gap-5 sm:flex">
        <div className="whitespace-nowrap text-ui text-text-2">Emails sent this period</div>
        <div className="whitespace-nowrap text-section font-semibold leading-heading tracking-heading tabular-nums">
          {fmtCount(sent)} <span className="text-ui font-normal text-text-2">of {fmtCount(limit)}</span>
        </div>
        {track}
        <div className="whitespace-nowrap text-caption text-text-2">{renewsLabel}</div>
        <div className="flex items-center gap-1.5 whitespace-nowrap border-l border-border pl-4 text-caption text-text-2">
          <HatchSwatch />
          {fmtCount(uncertain)} delivery uncertain · not billed
        </div>
      </div>

      <div className="sm:hidden">
        <div className="flex justify-between text-ui">
          <span className="text-text-2">Emails sent</span>
          <span className="font-semibold tabular-nums">
            {fmtCount(sent)} <span className="font-normal text-text-2">/ {fmtCount(limit)}</span>
          </span>
        </div>
        <div className="mt-2 flex">{track}</div>
        <div className="mt-1.5 flex justify-between text-caption text-text-2">
          <span>{renewsShort}</span>
          <span>{fmtCount(uncertain)} uncertain · not billed</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The 48px trend line on the headline card.
 *
 * A polyline rather than a chart component: it has no axes, no scale and no
 * tooltip, and the frame draws it as one `<polyline>` with a non-scaling
 * stroke so it stays 1.5px however the card is stretched.
 */
export function Sparkline({ values }: { values: readonly number[] }) {
  const points = sparklinePoints(values);

  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" width="100%" height={48} className="block" aria-hidden="true">
      <polyline
        fill="none"
        stroke="var(--brand)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        points={points}
      />
    </svg>
  );
}

/** C3's flat line when nothing has been sent, C1's trend when it has. */
export function sparklinePoints(values: readonly number[]): string {
  if (values.length < 2) return '0,36 100,36';

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;

  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = span === 0 ? 36 : 34 - ((value - min) / span) * 26;
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * The headline card (C1, G4a): the click rate, at 32px, with its own trend.
 *
 * `data-headline` marks it rather than a class name, because docs/06 makes
 * this the number a campaign is judged by and a redesign that levels the
 * cards should have to delete an attribute, not a font size.
 */
export function HeadlineRateCard({
  label = 'Click rate',
  value,
  detail,
  delta,
  sparkline,
  className = '',
}: {
  label?: string;
  value: string;
  /** The neutral line: "1,023 unique clickers of 22,241 delivered". */
  detail?: ReactNode;
  /** The comparison, in success text: "+0.8 pts vs your last 5 newsletters". */
  delta?: ReactNode;
  sparkline?: readonly number[] | undefined;
  className?: string;
}) {
  return (
    <div
      data-headline="true"
      className={`${CARD_SURFACE} grid min-w-0 items-center gap-x-6 gap-y-1 px-3.5 py-3.5 sm:px-5 sm:py-4.5 ${
        sparkline === undefined ? '' : 'grid-cols-[auto_minmax(0,1fr)]'
      } ${className}`}
    >
      <div className="col-span-full flex items-center gap-2">
        <span className="text-ui text-text-2">{label}</span>
        <Chip tone="brand">Headline</Chip>
      </div>

      <div className="min-w-0">
        <div className="text-headline font-semibold leading-heading tracking-[-0.02em] tabular-nums">{value}</div>
        {detail == null ? null : <div className="mt-1 text-caption text-text-2">{detail}</div>}
        {delta == null ? null : <div className="mt-1 text-caption text-success-text">{delta}</div>}
      </div>

      {sparkline === undefined ? null : <Sparkline values={sparkline} />}
    </div>
  );
}

/**
 * A secondary stat card (C1's open, bounce and complaint).
 *
 * `@relayd/ui`'s `Stat` is the same block, and the dashboard uses it; this
 * exists for the two cards that need a meter between the value and the
 * footnote at a size `Stat` does not take.
 */
export function MeterCard({
  label,
  shortLabel,
  aside,
  value,
  meter,
  footnote,
  weight = 'semibold',
  compact = false,
  className = '',
}: {
  label: string;
  /** Cm's own wording for the same card: "Open · approx.", "Bounce". */
  shortLabel?: string;
  aside?: ReactNode;
  value: string;
  meter?: ReactNode;
  footnote?: ReactNode;
  /**
   * C1 and G4a draw the open rate at 500 and every exact rate at 600. The
   * lighter weight is the same disclosure the tilde and the chip make: this
   * number is not as solid as the ones beside it.
   */
  weight?: 'semibold' | 'medium';
  /**
   * Cm: at 390px three of these sit in one row, so the card keeps its label
   * and its number and drops the meter, the chip and the footnote. The value
   * is the thing being compared; a 6px bar a thumb's width across is not.
   */
  compact?: boolean;
  className?: string;
}) {
  const hide = compact ? 'hidden sm:block' : '';

  return (
    <div
      className={`${CARD_SURFACE} flex min-w-0 flex-col ${
        compact ? 'gap-1 px-3 py-3 sm:gap-1.5 sm:px-4.5 sm:py-4' : 'gap-1.5 px-4.5 py-4'
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`truncate text-text-2 ${compact ? 'text-label sm:text-ui' : 'text-ui'}`}>
          {shortLabel === undefined ? (
            label
          ) : (
            <>
              <span className="sm:hidden">{shortLabel}</span>
              <span className="hidden sm:inline">{label}</span>
            </>
          )}
        </span>
        {aside === undefined ? null : (
          <span className={compact ? 'hidden sm:inline-flex' : 'inline-flex'}>{aside}</span>
        )}
      </div>
      <div
        className={`leading-heading tracking-heading tabular-nums ${
          compact ? 'text-[18px] sm:text-title' : 'text-title'
        } ${weight === 'medium' ? 'font-medium' : 'font-semibold'}`}
      >
        {value}
      </div>
      {meter === undefined ? null : <div className={hide}>{meter}</div>}
      {footnote === undefined ? null : (
        <div className={`text-caption text-text-2 ${hide}`}>{footnote}</div>
      )}
    </div>
  );
}

/**
 * The bounce meter: soft and hard on one 6px bar.
 *
 * Full width is a 1% bounce rate, which is how C1 draws 0.6% soft and 0.3%
 * hard at 60% and 30%. A bar scaled to the campaign's own worst day would
 * make every workspace look the same; this one says "how close to 1%".
 */
export function BounceMeter({ soft, hard }: { soft: number; hard: number }) {
  return (
    <div className="flex h-1.5 overflow-hidden rounded-3 bg-neutral-soft">
      <div className="bg-warning" style={{ width: `${meterPct(soft, 0.01)}%` }} />
      <div className="bg-danger" style={{ width: `${meterPct(hard, 0.01)}%` }} />
    </div>
  );
}

/**
 * The complaint meter, with the auto-pause threshold marked.
 *
 * The threshold sits at 60% of the bar whatever it is set to, so the shape
 * of "how close am I to being paused" is the same on every workspace.
 */
export function ComplaintMeter({ value, threshold }: { value: number | null; threshold: number }) {
  const full = threshold / 0.6;

  return (
    <div className="relative mt-0.5 h-1.5 rounded-3 bg-neutral-soft">
      <div
        className="h-full rounded-3 bg-success"
        style={{ width: `${value === null ? 0 : meterPct(value, full)}%` }}
      />
      <div className="absolute -top-1 h-3.5 w-0.5 rounded-[1px] bg-danger" style={{ left: '60%' }} />
    </div>
  );
}

const meterPct = (value: number, full: number): number =>
  full <= 0 ? 0 : Math.max(0, Math.min(100, (value / full) * 100));

/** C1's provider strip: three connections, each with today's quota. */
export function ProviderCard({ provider }: { provider: DashboardProvider }) {
  const used =
    provider.dailyLimit === null || provider.dailyLimit === 0
      ? 0
      : Math.min(100, (provider.sentToday / provider.dailyLimit) * 100);

  return (
    <div className={`${CARD_SURFACE} flex min-w-0 items-center gap-3 px-4 py-3`}>
      <span className="grid h-9 w-9 flex-none place-items-center rounded-control bg-brand-soft font-mono text-label font-medium text-brand">
        {provider.code}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-ui font-medium">{provider.name}</span>
          <span className="min-w-0 flex-1 truncate text-caption text-text-2">{provider.label}</span>
          <StateBadge states={HEALTH} state={provider.health} />
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-2 bg-neutral-soft">
            <div
              className={`h-full rounded-2 ${used >= 80 ? 'bg-warning' : 'bg-brand'}`}
              style={{ width: `${used}%` }}
            />
          </div>
          <span className="whitespace-nowrap text-caption tabular-nums text-text-2">
            {fmtCount(provider.sentToday)} / {provider.dailyLimit === null ? '—' : fmtCount(provider.dailyLimit)} today
          </span>
        </div>
      </div>
    </div>
  );
}

export interface ChartPoint {
  /** The axis value, already formatted: "21 Aug", "+3h". */
  label: string;
  value: number;
  /**
   * How strongly the bar is drawn, straight off the frames: C1 fades the
   * whole series to 0.5 and gives today 1; G4a gives the first 24 hours
   * 0.85 and everything after it 0.5. It is the one thing the bars say
   * beyond their height, so it is a number rather than a flag.
   */
  opacity?: number;
}

/**
 * The bar chart on C1 ("Sending activity") and G4a ("Clicks over time").
 *
 * Recharts, with the frames' own chrome and nothing else: three dashed
 * gridlines, a solid baseline, four ticks on a scale rounded up to a round
 * step, and no vertical grid, legend or axis lines — none of which the
 * frames draw. The x labels are the frame's four (or five) captions spread
 * under the plot rather than one per bar, because thirty dates do not fit
 * and the frame does not try.
 */
export function BarTimeChart({
  points,
  height = 160,
  axisLabels,
  unit,
}: {
  points: readonly ChartPoint[];
  height?: number;
  /** The captions under the plot, left to right. */
  axisLabels: readonly string[];
  /** "accepted", "clicks" — the noun in the tooltip. */
  unit: string;
}) {
  const max = points.reduce((top, point) => Math.max(top, point.value), 0);
  const step = niceStep(max / 3);
  const ticks = [0, step, step * 2, step * 3];

  return (
    <div className="mt-3.5 grid grid-cols-[32px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5">
      {/*
        The scale is drawn beside the plot rather than by the chart, exactly
        as the frames lay it out: four captions, top to bottom, the last one
        level with the baseline. Recharts centres a tick's text on its value,
        so its own axis clips the "0" in half at the bottom of the plot —
        which is how the zero went missing the first time this was built.
      */}
      <div
        className="flex flex-col justify-between text-right text-label leading-none text-text-3 tabular-nums"
        style={{ height }}
        aria-hidden="true"
      >
        {[...ticks].reverse().map((tick) => (
          <span key={tick}>{compact(tick)}</span>
        ))}
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points as ChartPoint[]} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <ReferenceLine y={0} stroke="var(--border)" />
            <YAxis hide width={0} domain={[0, ticks[3] ?? 1]} ticks={ticks} />
            <Tooltip
              cursor={false}
              isAnimationActive={false}
              contentStyle={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                boxShadow: 'var(--overlay-shadow)',
                fontSize: 12,
                padding: '6px 10px',
              }}
              labelStyle={{ color: 'var(--text-2)' }}
              itemStyle={{ color: 'var(--text)' }}
              formatter={(value) => [`${fmtCount(Number(value))} ${unit}`, '']}
            />
            <Bar dataKey="value" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {points.map((point) => (
                <Cell key={point.label} fill="var(--brand)" fillOpacity={point.opacity ?? 0.5} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div />
      {/* Keyed by position, not by text: G4a's captions repeat ("22:00"
          appears twice) and two identical keys drop one of them. */}
      <div className="flex justify-between text-label text-text-3">
        {axisLabels.map((label, index) => (
          <span key={`${index}-${label}`}>{label}</span>
        ))}
      </div>
    </div>
  );
}

/** 4,373 → 5,000; 97 → 100. The frames' axes are always round. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const factor = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return factor * magnitude;
}

/** 15000 → "15k", 300 → "300". The frames' own y labels. */
export function compact(value: number): string {
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
  }
  return String(value);
}

/** A horizontal meter row: label, bar, value. G4a's funnel and client list. */
export function MeterRow({
  label,
  width,
  value,
  fill = 'bg-brand',
  columns = '76px 1fr 120px',
  barHeight = 22,
}: {
  label: ReactNode;
  /** 0–100. */
  width: number;
  value: ReactNode;
  fill?: string;
  columns?: string;
  barHeight?: number;
}) {
  return (
    <div className="grid items-center gap-2.5 text-ui" style={{ gridTemplateColumns: columns }}>
      <span className="truncate text-text-2">{label}</span>
      <span
        className="block overflow-hidden rounded-4 bg-neutral-soft"
        style={{ height: barHeight }}
      >
        <span className={`block h-full rounded-4 ${fill}`} style={{ width: `${Math.max(0, Math.min(100, width))}%` }} />
      </span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

/** The one-line footnote under a rate: bot-filtered count, or the caveat. */
export function RateFootnote({ rate }: { rate: Rate | undefined }) {
  if (rate === undefined) return null;
  const text =
    rate.botFiltered > 0
      ? `${fmtCount(rate.botFiltered)} automated events excluded`
      : (rate.caveat ?? null);

  return text === null ? null : <div className="text-caption text-text-2">{text}</div>;
}

/** A tilde in front of a directional rate, as every frame draws it. */
export function approximate(formatted: string, rate: Rate | undefined): string {
  if (formatted === '—') return formatted;
  return rate?.confidence === 'directional' ? `~${formatted}` : formatted;
}

/**
 * G4a's "Excluded: 1,204 bot events".
 *
 * In the header, beside the export, rather than in a footnote: it is the
 * single sentence that explains why every number on the page is lower than
 * the provider's own dashboard, and the frame puts it where that question
 * gets asked.
 */
export const BOT_TITLE =
  'These events came from known bots and security scanners (link pre-fetchers, Apple MPP, Microsoft SafeLinks). They are excluded from every number on this page, not deleted.';

export function BotChip({ count }: { count: number }) {
  return (
    <span title={BOT_TITLE} className="cursor-help text-ui whitespace-nowrap">
      Excluded: {fmtCount(count)} bot events
    </span>
  );
}

/**
 * The export, as an anchor.
 *
 * A fetch would have to rebuild the filename the server already put in
 * `Content-Disposition`, and a blob download loses it. `Button` is a
 * `<button>` and cannot carry `href`/`download`, so this is the same 34px
 * secondary surface on an `<a>`.
 */
export function DownloadLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      download
      className="inline-flex h-8.5 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-ui font-medium whitespace-nowrap text-text no-underline hover:bg-tint"
    >
      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
      {children}
    </a>
  );
}

export interface Slice {
  label: string;
  /** 0–1. */
  share: number;
  /** A token background utility: `bg-brand`, `bg-info`, `bg-success`. */
  fill: string;
}

/**
 * One 10px bar split by share, with the legend underneath (G4a's "Device").
 *
 * A stacked bar rather than a donut: three shares that add to 100% are a
 * ranking, and a bar is the shape people read a ranking from.
 */
export function StackBar({ slices }: { slices: readonly Slice[] }) {
  return (
    <>
      <div className="flex h-2.5 overflow-hidden rounded-5">
        {slices.map((slice) => (
          <span key={slice.label} className={slice.fill} style={{ width: `${slice.share * 100}%` }} />
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1.5 text-caption text-text-2">
        {slices.map((slice) => (
          <span key={slice.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2.5 w-2.5 flex-none rounded-2 ${slice.fill}`} />
            {slice.label} {Math.round(slice.share * 100)}%
          </span>
        ))}
      </div>
    </>
  );
}

/** "https://northwind.travel/offers/santorini" → "northwind.travel/offers/santorini". */
export function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//u, '').replace(/^www\./u, '').replace(/\/$/u, '');
}
