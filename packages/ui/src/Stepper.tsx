import { Icon } from './icons.js';

/**
 * Wizard stepper (design/00 Design System.dc.html, "Wizard stepper · 7
 * steps"; design/G Campaigns.dc.html, the G2s1–G2s7 rail).
 *
 * The design has two, both vertical — there is no horizontal stepper in the
 * export:
 *
 * - `wizard` is the G2 create-campaign rail: rows `10px 12px`, the current
 *   row filled brand-soft, upcoming rows at 60% opacity, and the sub-label
 *   *under* the step name ("Audience / 48,213 estimated"), truncated.
 * - `compact` is the sheet's own card: rows `6px 8px`, no row fill and no
 *   dimming, the current step's label at 600, and the sub-label pushed to
 *   the right edge in 12px text-3.
 *
 * Shared by both: a 24px round bubble, 12/600, showing a 12px check at
 * stroke 3 once the step is behind you and its number before that.
 *
 * The component is the list only. G2 wraps it in a 260px sticky card
 * (`rounded-card border border-border bg-surface p-2 sticky top-0`), which
 * is page layout, not the stepper.
 */

export interface StepperStep {
  key: string;
  label: string;
  /** "48,213 estimated", "Autumn Escapes · 3 tags", "Launch". */
  sub?: string | undefined;
}

export type StepperVariant = 'wizard' | 'compact';

export interface StepperProps {
  steps: readonly StepperStep[];
  /** Zero-based index of the step being worked on. */
  current: number;
  variant?: StepperVariant | undefined;
  /** Given, completed steps become buttons; the current and later ones never do. */
  onStepClick?: ((index: number) => void) | undefined;
  /** Names the list for assistive tech. */
  label?: string | undefined;
}

type StepState = 'complete' | 'current' | 'upcoming';

const ROW: Record<StepperVariant, string> = {
  wizard: 'flex items-center gap-3 rounded-control px-3 py-2.5 text-ui',
  compact: 'flex items-center gap-3 rounded-control px-2 py-1.5 text-ui',
};

const ROW_STATE: Record<StepperVariant, Record<StepState, string>> = {
  wizard: {
    complete: 'bg-transparent',
    current: 'bg-brand-soft',
    upcoming: 'bg-transparent opacity-60',
  },
  compact: { complete: '', current: '', upcoming: '' },
};

const BUBBLE_STATE: Record<StepperVariant, Record<StepState, string>> = {
  wizard: {
    complete: 'border-transparent bg-brand text-on-brand',
    current: 'border-brand bg-surface text-brand',
    upcoming: 'border-transparent bg-neutral-soft text-text-3',
  },
  compact: {
    complete: 'border-transparent bg-brand text-on-brand',
    current: 'border-transparent bg-brand-soft text-brand',
    upcoming: 'border-border bg-surface text-text-3',
  },
};

const LABEL_STATE: Record<StepperVariant, Record<StepState, string>> = {
  wizard: { complete: 'font-medium', current: 'font-medium', upcoming: 'font-medium' },
  compact: {
    complete: 'font-normal text-text',
    current: 'font-semibold text-text',
    upcoming: 'font-normal text-text-2',
  },
};

const STATE_WORD: Record<StepState, string> = {
  complete: 'Completed',
  current: 'Current step',
  upcoming: 'Not started',
};

function Bubble({ variant, state, index }: { variant: StepperVariant; state: StepState; index: number }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'grid h-6 w-6 flex-none place-items-center rounded-full border text-caption font-semibold',
        BUBBLE_STATE[variant][state],
      ].join(' ')}
    >
      {state === 'complete' ? <Icon name="check" size={12} strokeWidth={3} /> : index + 1}
    </span>
  );
}

export function Stepper({ steps, current, variant = 'wizard', onStepClick, label = 'Steps' }: StepperProps) {
  return (
    <ol aria-label={label} className={variant === 'compact' ? 'flex flex-col gap-0.5' : 'flex flex-col'}>
      {steps.map((step, index) => {
        const state: StepState = index < current ? 'complete' : index === current ? 'current' : 'upcoming';
        const navigable = onStepClick !== undefined && state === 'complete';

        const body = (
          <>
            <Bubble variant={variant} state={state} index={index} />
            {variant === 'wizard' ? (
              <span className="min-w-0 flex-1">
                <span className={`block ${LABEL_STATE.wizard[state]}`}>{step.label}</span>
                {step.sub === undefined ? null : (
                  <span className="block truncate text-caption text-text-2">{step.sub}</span>
                )}
              </span>
            ) : (
              <>
                <span className={LABEL_STATE.compact[state]}>{step.label}</span>
                {step.sub === undefined ? null : (
                  <span className="ml-auto text-caption text-text-3">{step.sub}</span>
                )}
              </>
            )}
            <span className="sr-only">{STATE_WORD[state]}</span>
          </>
        );

        const rowClass = [ROW[variant], ROW_STATE[variant][state]].join(' ');

        return (
          <li key={step.key} aria-current={state === 'current' ? 'step' : undefined}>
            {navigable ? (
              <button
                type="button"
                onClick={() => onStepClick(index)}
                className={`w-full cursor-pointer text-left ${rowClass}`}
              >
                {body}
              </button>
            ) : (
              <div className={rowClass}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
