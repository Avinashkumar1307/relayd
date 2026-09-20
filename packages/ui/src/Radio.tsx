import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/**
 * Radios and radio cards (design/G Campaigns.dc.html `radio` / `optCard`;
 * design/H Sending Pools.dc.html "Strategy"; design/J Settings & API.dc.html
 * the invite role picker).
 *
 * The export writes the dot once and reuses it everywhere:
 *   `{ width: 16, height: 16, borderRadius: 8, marginTop: 2,
 *      border: on ? '5px solid var(--brand)' : '1px solid var(--border)',
 *      background: 'var(--surface)' }`
 * — a 5px brand ring is the whole selected state; there is no inner dot
 * element.
 *
 * The card is `optCard`: the same row with 12/14 padding, radius 8, and a
 * brand border over `brand-soft` when chosen. Disabled members (a pool with
 * no headroom, on G2 step 3) keep their text at 0.55 opacity — the sheet's
 * rule that a control which says no still says what it was.
 *
 * Roving arrow keys are implemented here rather than left to the browser's
 * native radio behaviour so the group behaves identically under test and in
 * every engine; the handler calls `preventDefault`, so the native move never
 * runs twice.
 */

interface RadioGroupContextValue {
  name: string;
  value: string | undefined;
  select: (value: string) => void;
  groupDisabled: boolean;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

function useRadioGroup(component: string): RadioGroupContextValue {
  const context = useContext(RadioGroupContext);
  if (context === null) throw new Error(`<${component}> must be rendered inside a <RadioGroup>.`);
  return context;
}

export interface RadioGroupProps {
  /** The field label above the options — "Strategy" on H1b. */
  label?: ReactNode | undefined;
  /** One line under the label, in `text-2`. */
  description?: ReactNode | undefined;
  error?: string | undefined;
  /** Shared `name` for the inputs; generated when omitted. */
  name?: string | undefined;
  value?: string | undefined;
  defaultValue?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  disabled?: boolean | undefined;
  /** Arrow-key axis and default stacking. The frames use both. */
  orientation?: 'vertical' | 'horizontal' | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function RadioGroup({
  label,
  description,
  error,
  name,
  value,
  defaultValue,
  onChange,
  disabled = false,
  orientation = 'vertical',
  className = '',
  children,
}: RadioGroupProps) {
  const generated = useId();
  const groupName = name ?? generated;
  const labelId = `${generated}-label`;
  const errorId = `${generated}-error`;
  const listRef = useRef<HTMLDivElement>(null);

  const [uncontrolled, setUncontrolled] = useState<string | undefined>(defaultValue);
  const current = value === undefined ? uncontrolled : value;
  const invalid = error !== undefined && error !== '';

  const select = (next: string) => {
    if (value === undefined) setUncontrolled(next);
    onChange?.(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !back) return;

    const list = listRef.current;
    if (list === null) return;
    const inputs = Array.from(list.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
      (input) => !input.disabled,
    );
    if (inputs.length === 0) return;

    const active = inputs.findIndex((input) => input === document.activeElement || input.checked);
    const next =
      active < 0 ? (forward ? inputs[0] : inputs[inputs.length - 1]) : inputs[(active + (forward ? 1 : -1) + inputs.length) % inputs.length];
    if (next === undefined) return;

    event.preventDefault();
    next.focus();
    next.click();
  };

  return (
    <div className={`flex flex-col gap-1.5 text-ui ${className}`}>
      {label === undefined ? null : (
        <span id={labelId} className="font-medium text-text">
          {label}
        </span>
      )}
      {description === undefined ? null : <span className="text-caption text-text-2">{description}</span>}

      <RadioGroupContext.Provider value={{ name: groupName, value: current, select, groupDisabled: disabled }}>
        <div
          ref={listRef}
          role="radiogroup"
          aria-labelledby={label === undefined ? undefined : labelId}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onKeyDown={onKeyDown}
          className={orientation === 'vertical' ? 'flex flex-col gap-2.5' : 'flex flex-wrap items-start gap-2.5'}
        >
          {children}
        </div>
      </RadioGroupContext.Provider>

      {invalid ? (
        <span id={errorId} role="alert" className="text-caption text-danger-text">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** The 16px dot: a 5px brand ring when on, a 1px field border when off. */
function Dot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'mt-0.5 h-4 w-4 flex-none rounded-full bg-surface',
        checked ? 'border-[5px] border-brand' : 'border border-border',
        'peer-focus-visible:ring-[3px] peer-focus-visible:ring-brand-soft',
        'peer-disabled:border-border',
      ].join(' ')}
    />
  );
}

interface RadioItemBase {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

function useItem(value: string, disabled: boolean | undefined, component: string) {
  const { name, value: selected, select, groupDisabled } = useRadioGroup(component);
  const id = useId();
  return {
    id,
    name,
    checked: selected === value,
    inert: groupDisabled || disabled === true,
    select,
  };
}

export type RadioProps = RadioItemBase;

export function Radio({ value, label, description, disabled, className = '' }: RadioProps) {
  const { id, name, checked, inert, select } = useItem(value, disabled, 'Radio');
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;

  return (
    <label
      htmlFor={id}
      className={[
        'flex items-start gap-2.5 text-ui',
        inert ? 'cursor-not-allowed opacity-[0.55]' : 'cursor-pointer',
        className,
      ].join(' ')}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={inert}
        onChange={() => select(value)}
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        className="peer sr-only"
      />
      <Dot checked={checked} />
      <span>
        <span id={labelId}>{label}</span>
        {description === undefined ? null : (
          <span id={descriptionId} className="block text-caption text-text-2">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export interface RadioCardProps extends RadioItemBase {
  /** A chip on the label row — the "Pool" / "Connection" kind on G2 step 3. */
  aside?: ReactNode | undefined;
  /** Anything below the description inside the card: the headroom bar on G2. */
  children?: ReactNode | undefined;
  /** 12/14 padding as on G2 and H1b, or the tighter 10/12 of J2's role list. */
  density?: 'comfortable' | 'compact' | undefined;
}

const CARD_PADDING: Record<NonNullable<RadioCardProps['density']>, string> = {
  comfortable: 'px-3.5 py-3',
  compact: 'px-3 py-2.5',
};

export function RadioCard({
  value,
  label,
  description,
  disabled,
  aside,
  children,
  density = 'comfortable',
  className = '',
}: RadioCardProps) {
  const { id, name, checked, inert, select } = useItem(value, disabled, 'RadioCard');
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;

  return (
    <label
      htmlFor={id}
      className={[
        'flex select-none items-start gap-2.5 rounded-control border text-ui',
        CARD_PADDING[density],
        checked ? 'border-brand bg-brand-soft' : 'border-border bg-surface',
        inert ? 'cursor-not-allowed opacity-[0.55]' : 'cursor-pointer',
        className,
      ].join(' ')}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={inert}
        onChange={() => select(value)}
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        className="peer sr-only"
      />
      <Dot checked={checked} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span id={labelId} className="font-medium">
            {label}
          </span>
          {aside}
        </span>
        {description === undefined ? null : (
          <span id={descriptionId} className="mt-0.5 block text-caption text-text-2">
            {description}
          </span>
        )}
        {children}
      </span>
    </label>
  );
}
