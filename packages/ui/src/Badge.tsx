import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './icons.js';
import { TONES, stateStyle, type StateStyle, type Tone } from './states.js';

/**
 * Status badges (design/00 Design System.dc.html, "Status badges";
 * design/relayd-ui.js, `badge` and `stateBadge`).
 *
 * The sheet's rule, verbatim: "Every campaign, recipient, contact and
 * connection carries one. Pulsing dot = transitional. Outline + warning dot =
 * completed with errors. Lock = held by billing. Hatched dashed = delivery
 * uncertain, never hidden."
 *
 * The geometry is relayd-ui.js's `badge()`: 22px tall, 0 8px padding, radius
 * 6, 12/500, a 6px dot. It is applied as inline style rather than utility
 * classes because two of the tones (`uncertain`, `bot`) are gradients, and a
 * gradient as a Tailwind arbitrary value is longer and less legible than the
 * one line relayd-ui.js already wrote.
 *
 * The word is always present. Colour is never the only signal.
 */

export interface BadgeProps {
  tone: Tone;
  children: ReactNode;
  // `| undefined` on each optional: `StateBadge` forwards fields straight
  // from a `StateStyle`, where they may be absent, and
  // `exactOptionalPropertyTypes` otherwise refuses the pass-through.
  pulse?: boolean | undefined;
  outline?: boolean | undefined;
  /** Overrides the dot colour, e.g. a warning dot on a success outline. */
  dot?: Tone | undefined;
  lock?: boolean | undefined;
  title?: string | undefined;
}

export function Badge({ tone, children, pulse, outline, dot, lock, title }: BadgeProps) {
  const t = TONES[tone];

  const badge: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 22,
    padding: '0 8px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    color: t.fg,
    background: outline === true ? 'transparent' : t.bg,
    border: t.dashed === true ? `1px dashed ${t.dot}` : `1px solid ${outline === true ? t.dot : 'transparent'}`,
  };

  const dotStyle: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: 3,
    flex: 'none',
    background: dot === undefined ? t.dot : TONES[dot].dot,
    animation: pulse === true ? 'rl-pulse 1.2s ease-in-out infinite' : 'none',
  };

  return (
    <span style={badge} title={title}>
      <span style={dotStyle} aria-hidden="true" />
      {children}
      {lock === true ? <Icon name="lock" size={11} strokeWidth={2} /> : null}
    </span>
  );
}

/**
 * A badge for a state key, looked up in one of the maps from `states.ts`.
 *
 * The `code` prop shows the raw state name in mono beside the label — the
 * sheet's badge rows do this — for screens where an operator needs the exact
 * value the API returned, not the friendly word.
 */
export function StateBadge({
  states,
  state,
  code,
}: {
  states: Readonly<Record<string, StateStyle>>;
  state: string;
  code?: boolean;
}) {
  const s = stateStyle(states, state);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Badge tone={s.tone} pulse={s.pulse} outline={s.outline} dot={s.dot} lock={s.lock}>
        {s.label}
      </Badge>
      {code === true ? (
        <code
          style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12, color: 'var(--text-3)' }}
        >
          {state}
        </code>
      ) : null}
    </span>
  );
}
