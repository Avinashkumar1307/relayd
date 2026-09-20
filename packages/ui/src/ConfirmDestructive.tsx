import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './Button.js';
import { inputClass } from './Field.js';
import { Modal } from './Modal.js';

/**
 * Destructive confirmation (design/00 Design System.dc.html, "Drawer, modal,
 * stepper, destructive confirmation"; J "Delete workspace?", E "Disconnect
 * …?").
 *
 * The sheet's rule, verbatim: "Destructive actions require typing the
 * resource name."
 *
 * Three things the frames do that a plain confirm dialog does not:
 *
 * 1. The body says what will actually be destroyed, in numbers, and what
 *    survives — "48,213 contacts, 126 campaigns … Exports stay downloadable
 *    for 30 days."
 * 2. The phrase must match **exactly**: `s.typed === 'Northwind Voyages'` in
 *    J, `s.dcTyped === dc.label` in E. No trimming, no case folding. A
 *    confirmation you can pass by accident is decoration.
 * 3. Until it matches, the danger button is the sheet's disabled button —
 *    neutral-soft on text-3, label intact — and carries the reason as its
 *    tooltip.
 *
 * Without `confirmPhrase` it is the same dialog with the button live from
 * the start: the frames use that shape for the destructive actions that are
 * reversible.
 */

export interface ConfirmDestructiveProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** "Delete workspace?" — a question, as every frame phrases it. */
  title: ReactNode;
  /** What will happen, in numbers, and what survives. */
  children: ReactNode;
  /** The danger button's label: "Delete workspace", "Disconnect". */
  confirmLabel: string;
  /** Default "Cancel"; E uses "Keep connection". */
  cancelLabel?: string | undefined;
  /** Typed exactly to arm the button: the workspace name, the connection label. */
  confirmPhrase?: string | undefined;
  /** What the field is for, e.g. "Workspace name". */
  inputLabel?: string | undefined;
  placeholder?: string | undefined;
  /** The request is in flight: the button says so and a second click does nothing. */
  pending?: boolean | undefined;
}

export function ConfirmDestructive({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmPhrase,
  inputLabel = 'Confirmation',
  placeholder,
  pending = false,
}: ConfirmDestructiveProps) {
  const [typed, setTyped] = useState('');

  // Every opening starts from empty: a phrase left in the box from the last
  // time would arm the button before the user has read the new dialog.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const armed = confirmPhrase === undefined || typed === confirmPhrase;
  const reason = confirmPhrase === undefined ? undefined : `Type ${confirmPhrase} to confirm`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={children}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={!armed}
            pending={pending}
            title={armed ? undefined : reason}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {confirmPhrase === undefined ? null : (
        <label className="flex flex-col gap-1.5">
          <span>
            Type{' '}
            <span className="rounded-4 bg-neutral-soft px-1.5 py-px font-mono text-caption">{confirmPhrase}</span> to
            confirm
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-label={inputLabel}
            placeholder={placeholder}
            autoComplete="off"
            className={inputClass('md', false)}
          />
        </label>
      )}
    </Modal>
  );
}
