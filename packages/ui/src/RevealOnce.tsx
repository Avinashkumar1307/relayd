import { useState, type ReactNode } from 'react';
import { CopyButton } from './CopyButton.js';
import { Icon } from './icons.js';

/**
 * The reveal-once secret (design/00 Design System.dc.html, "Monospace IDs
 * and reveal-once secrets"; the full-page forms of it are J3c, the new API
 * key, and E1d, the inbound webhook URL).
 *
 * The sheet's rule, verbatim: "Secrets (API keys, webhook signing secrets)
 * are shown exactly once, then masked forever; rotating is the only way to
 * see a new one." The export models it as three states, labelled in the
 * card's corner — `State 1 of 3 · never revealed`, `State 2 of 3 · revealed,
 * shown once`, `State 3 of 3 · masked forever` — and this component is those
 * three, in that order, one way only:
 *
 *   hidden   → masked value, "Reveal once", and the sentence that says the
 *              reveal is final.
 *   revealed → the value in a brand-bordered box with the 3px ring, a copy
 *              button, "I've stored it", and the warning strip.
 *   masked   → masked value, the caller's rotate / revoke actions, and the
 *              lock footnote naming who revealed it and when.
 *
 * `secret` is only ever passed for the revealed state; there is no prop that
 * holds it while the component is masked, because the UI must not be the
 * thing that keeps a shown-once value alive in memory after the user has
 * acknowledged it.
 */

export type RevealPhase = 'hidden' | 'revealed' | 'masked';

export interface RevealOnceProps {
  /** The field label above the box — "Secret key" on J3c. */
  label?: ReactNode | undefined;
  /** What is shown whenever the secret is not: `rk_live_7f3a••••…`. */
  masked: string;
  /** The real value. Only read in the revealed phase. */
  secret?: string | undefined;
  /** Controlled phase; omit to let the component walk the three states. */
  phase?: RevealPhase | undefined;
  defaultPhase?: RevealPhase | undefined;
  onReveal?: (() => void) | undefined;
  /** "I've stored it" — the only way out of the revealed state. */
  onAcknowledge?: (() => void) | undefined;
  revealLabel?: string | undefined;
  acknowledgeLabel?: string | undefined;
  /** hidden: why the reveal is final. */
  note?: ReactNode | undefined;
  /** revealed: the warning strip. */
  warning?: ReactNode | undefined;
  /** masked: the lock line — who revealed it, when. */
  footnote?: ReactNode | undefined;
  /** masked: Rotate / Revoke, supplied by the page. */
  actions?: ReactNode | undefined;
  /** 36px as on the sheet, or the 44px field of E1d and J3c. */
  size?: 'md' | 'lg' | undefined;
  className?: string | undefined;
}

const BOX: Record<'md' | 'lg', string> = {
  md: 'h-9 text-ui',
  lg: 'h-11 text-body',
};

const PAD: Record<'md' | 'lg', { flat: string; withButton: string }> = {
  md: { flat: 'px-3', withButton: 'pl-3 pr-1.5' },
  lg: { flat: 'px-3.5', withButton: 'pl-3.5 pr-1.5' },
};

/** 36px, to line up with the field beside it — the frames draw it taller than BTN's 34. */
const ACTION = 'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-control border px-3 text-ui font-medium';

export function RevealOnce({
  label,
  masked,
  secret,
  phase,
  defaultPhase = 'hidden',
  onReveal,
  onAcknowledge,
  revealLabel = 'Reveal once',
  acknowledgeLabel = "I've stored it",
  note,
  warning,
  footnote,
  actions,
  size = 'md',
  className = '',
}: RevealOnceProps) {
  const [uncontrolled, setUncontrolled] = useState<RevealPhase>(defaultPhase);
  const current = phase ?? uncontrolled;

  const reveal = () => {
    if (phase === undefined) setUncontrolled('revealed');
    onReveal?.();
  };

  const acknowledge = () => {
    if (phase === undefined) setUncontrolled('masked');
    onAcknowledge?.();
  };

  const maskedBox = (
    <span
      className={[
        'flex flex-1 items-center rounded-control border border-border bg-tint font-mono text-text-2',
        BOX[size],
        PAD[size].flat,
      ].join(' ')}
    >
      <span className="truncate">{masked}</span>
    </span>
  );

  return (
    <div className={`flex flex-col gap-2.5 text-ui ${className}`}>
      {label === undefined ? null : <span className="font-medium text-text">{label}</span>}

      {current === 'revealed' ? (
        <>
          <div className="flex items-center gap-2.5">
            <span
              className={[
                'flex flex-1 items-center justify-between gap-2 rounded-control border border-brand bg-surface',
                'ring-[3px] ring-brand-soft',
                'font-mono text-text',
                BOX[size],
                PAD[size].withButton,
              ].join(' ')}
            >
              <code className="truncate font-mono">{secret ?? masked}</code>
              <CopyButton
                text={secret ?? masked}
                size={size === 'lg' ? 'md' : 'sm'}
                ariaLabel={typeof label === 'string' ? `Copy ${label.toLowerCase()}` : undefined}
              />
            </span>
            <button type="button" onClick={acknowledge} className={`${ACTION} border-border bg-surface text-text`}>
              {acknowledgeLabel}
            </button>
          </div>
          {warning === undefined ? null : (
            <div
              role="status"
              className="flex items-start gap-2 rounded-control bg-warning-soft px-3 py-2.5 text-caption text-warning-text"
            >
              <span className="mt-px flex-none">
                <Icon name="alert" size={14} strokeWidth={2} />
              </span>
              <span>{warning}</span>
            </div>
          )}
        </>
      ) : current === 'hidden' ? (
        <>
          <div className="flex items-center gap-2.5">
            {maskedBox}
            <button
              type="button"
              onClick={reveal}
              className={`${ACTION} border-transparent bg-brand text-on-brand hover:bg-brand-hover`}
            >
              {revealLabel}
            </button>
          </div>
          {note === undefined ? null : <span className="text-caption text-text-2">{note}</span>}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            {maskedBox}
            {actions}
          </div>
          {footnote === undefined ? null : (
            <span className="flex items-center gap-1.5 text-caption text-text-2">
              <Icon name="lock" size={13} strokeWidth={2} className="flex-none" />
              {footnote}
            </span>
          )}
        </>
      )}
    </div>
  );
}
