import { Checkbox, Field, Select } from '@relayd/ui';
import type { ProviderType } from '../../api/providers.js';
import { CREDENTIALS } from './provider-ui.js';

/**
 * The credential fields for one provider (E1c), and the rotate dialog.
 *
 * Every secret is `type="password"` and out of autofill: these are pasted in
 * shared screens and captured in screen recordings more often than anyone
 * admits, and none of them is a login the browser should offer to save.
 *
 * The values are mono because they are keys — the frame draws them that way,
 * and a transposed character in `AKIA3F7Q2B9XEXAMPLE` is otherwise invisible.
 * `Field` has no hook for the input's own class, so the family and size come
 * through `style` (see uiGaps in the section report).
 */

const MONO = { fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12 } as const;

export function CredentialFields({
  type,
  values,
  onChange,
  disabled = false,
}: {
  type: ProviderType;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
}) {
  const form = CREDENTIALS[type];

  return (
    <div className="grid gap-4 sm:grid-cols-2 sm:gap-x-5">
      {form.fields.map((field) => {
        const value = values[field.name] ?? '';

        if (field.kind === 'checkbox') {
          return (
            <div key={field.name} className="sm:col-span-2">
              <Checkbox
                label={field.label}
                checked={value === 'on'}
                disabled={disabled}
                onChange={(event) => onChange(field.name, event.target.checked ? 'on' : '')}
              />
            </div>
          );
        }

        if (field.kind === 'select') {
          return (
            <Select
              key={field.name}
              label={field.label}
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(field.name, event.target.value)}
            >
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          );
        }

        return (
          <Field
            key={field.name}
            label={field.label}
            type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
            value={value}
            disabled={disabled}
            placeholder={field.placeholder}
            autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
            spellCheck={false}
            style={field.mono === true ? MONO : undefined}
            onChange={(event) => onChange(field.name, event.target.value)}
          />
        );
      })}

      {form.chips === undefined ? null : (
        <div className="flex flex-col gap-1.5 text-ui">
          <span className="font-medium text-text">{form.chips.label}</span>
          <div className="flex flex-wrap gap-1.5">
            {form.chips.items.map((item) => (
              <code
                key={item}
                className="rounded-badge bg-neutral-soft px-1.5 py-0.5 font-mono text-label"
              >
                {item}
              </code>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
