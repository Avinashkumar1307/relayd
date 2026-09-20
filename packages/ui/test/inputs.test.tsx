// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Avatar, Monogram } from '../src/Avatar.js';
import { Checkbox } from '../src/Checkbox.js';
import { CopyButton } from '../src/CopyButton.js';
import { Mono } from '../src/Mono.js';
import { Radio, RadioCard, RadioGroup } from '../src/Radio.js';
import { RevealOnce } from '../src/RevealOnce.js';
import { SearchInput } from '../src/SearchInput.js';
import { Select } from '../src/Select.js';
import { Switch } from '../src/Switch.js';
import { Textarea } from '../src/Textarea.js';

/**
 * Form controls and identifiers (design/00 Design System.dc.html, "Form
 * fields" and "Monospace IDs and reveal-once secrets").
 *
 * The rules under test are the sheet's sentences: labels above and help
 * below, errors inline in danger; required compliance controls are always on
 * and say so; IDs are chips with a copy button; a secret is shown exactly
 * once and then masked forever. The class assertions are only the ones that
 * carry a measured value — the 18px box, the 20px track, the 30px search
 * well — because those are the numbers a refactor can lose silently.
 */

afterEach(cleanup);

describe('Select', () => {
  it('labels the control and swaps help for an inline error', () => {
    const { rerender } = render(
      <Select label="Timezone" help="Schedules and reports use this zone.">
        <option value="dubai">Asia/Dubai · GST (UTC+4)</option>
      </Select>,
    );
    expect(screen.getByLabelText('Timezone')).toBeTruthy();
    expect(screen.getByText('Schedules and reports use this zone.')).toBeTruthy();

    rerender(
      <Select label="Timezone" help="Schedules and reports use this zone." error="Pick a timezone">
        <option value="dubai">Asia/Dubai · GST (UTC+4)</option>
      </Select>,
    );
    expect(screen.queryByText('Schedules and reports use this zone.')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Pick a timezone');
    expect(screen.getByLabelText('Timezone').getAttribute('aria-invalid')).toBe('true');
  });

  it('is a native select, 36px, with our chevron and not the browser default', () => {
    const { container } = render(
      <Select label="Environment">
        <option value="live">Live</option>
      </Select>,
    );
    const select = screen.getByLabelText('Environment');

    expect(select.tagName).toBe('SELECT');
    expect(select.className).toContain('h-9');
    expect(select.className).toContain('appearance-none');
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });
});

describe('Textarea', () => {
  it('uses the rows the sheet shows and stays resizable, with no fixed control height', () => {
    render(<Textarea label="Internal notes" defaultValue="Q4 re-engagement" />);
    const area = screen.getByLabelText('Internal notes') as HTMLTextAreaElement;

    expect(area.tagName).toBe('TEXTAREA');
    expect(area.rows).toBe(2);
    expect(area.className).toContain('resize-y');
    expect(area.style.height).toBe('auto');
  });
});

describe('Checkbox', () => {
  it('names itself from the label only, and describes itself with the second line', () => {
    // The consent box on the sheet: the audit-log sentence is a description,
    // not part of the control's name.
    render(
      <Checkbox
        label="I confirm these contacts gave consent to receive email from this sender"
        description="Required to continue. Recorded in the audit log with your name and time."
      />,
    );
    const box = screen.getByRole('checkbox', {
      name: 'I confirm these contacts gave consent to receive email from this sender',
    });
    const describedBy = box.getAttribute('aria-describedby');

    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain('Recorded in the audit log');
  });

  it('paints the box when an uncontrolled checkbox is clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(<Checkbox label="Also add these contacts to Newsletter EU" />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    const painted = () => container.querySelector('span[aria-hidden="true"]')?.className ?? '';

    expect(painted()).toContain('border-border');
    await user.click(box);
    expect(box.checked).toBe(true);
    expect(painted()).toContain('bg-brand');
  });

  it('reports a partial selection as mixed, with the bar rather than the tick', () => {
    const { container } = render(<Checkbox label="Select all" size="sm" indeterminate />);
    const box = screen.getByRole('checkbox');

    expect(box.getAttribute('aria-checked')).toBe('mixed');
    expect(container.querySelector('svg')?.querySelector('path')?.getAttribute('d')).toBe('M5 12h14');
  });

  it('has the two measured boxes: 18 on a form, 16 in a table', () => {
    const { container } = render(
      <>
        <Checkbox label="Form" />
        <Checkbox label="Table" size="sm" />
      </>,
    );
    const boxes = container.querySelectorAll('span[aria-hidden="true"]');

    expect(boxes[0]?.className).toContain('h-[18px]');
    expect(boxes[1]?.className).toContain('h-4');
  });
});

describe('RadioGroup', () => {
  const strategies = (
    <>
      <Radio value="rr" label="Round-robin" description="Alternate members per recipient." />
      <Radio value="fo" label="Failover" description="Send through the first member." />
      <Radio value="none" label="Unavailable" disabled />
    </>
  );

  it('is a radiogroup named by its field label', () => {
    render(<RadioGroup label="Strategy">{strategies}</RadioGroup>);
    expect(screen.getByRole('radiogroup', { name: 'Strategy' })).toBeTruthy();
  });

  it('moves the selection with the arrow keys and skips a disabled option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RadioGroup label="Strategy" defaultValue="rr" onChange={onChange}>
        {strategies}
      </RadioGroup>,
    );
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    radios[0]?.focus();

    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenCalledWith('fo');
    expect(radios[1]?.checked).toBe(true);

    // Only two options are reachable; the disabled third is never landed on.
    await user.keyboard('{ArrowDown}');
    expect(radios[0]?.checked).toBe(true);
    expect(radios[2]?.checked).toBe(false);
  });

  it('marks the chosen card with the brand border over brand-soft', async () => {
    const user = userEvent.setup();
    render(
      <RadioGroup label="Sender">
        <RadioCard value="pool" label="EU pool" description="Two connections" />
        <RadioCard value="ses" label="SES eu-west-1" description="One connection" />
      </RadioGroup>,
    );
    const card = screen.getByRole('radio', { name: 'EU pool' }).closest('label');

    expect(card?.className).toContain('border-border');
    await user.click(screen.getByRole('radio', { name: 'EU pool' }));
    expect(card?.className).toContain('bg-brand-soft');
    expect(card?.className).toContain('border-brand');
  });
});

describe('Switch', () => {
  it('is a switch that reports its state and toggles', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch label="Click tracking" checked={false} onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Click tracking' });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('keeps a locked compliance control on, unmovable, and explained', async () => {
    // The sheet: "Required compliance controls are always on and say so."
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Switch
        label="Unsubscribe link"
        checked
        locked
        title="Required by law on every campaign"
        onChange={onChange}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Unsubscribe link' });

    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(toggle.getAttribute('title')).toBe('Required by law on every campaign');
    await user.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('draws the measured 36x20 track', () => {
    render(<Switch label="Open tracking" checked={false} />);
    const toggle = screen.getByRole('switch');

    expect(toggle.className).toContain('h-5');
    expect(toggle.className).toContain('w-9');
    expect(toggle.className).toContain('bg-seg-pending');
  });
});

describe('SearchInput', () => {
  it('is a labelled search box at the measured toolbar height', () => {
    const { container } = render(<SearchInput label="Search contacts" placeholder="Search email or name" />);

    expect(screen.getByRole('searchbox', { name: 'Search contacts' })).toBeTruthy();
    expect(container.firstElementChild?.className).toContain('h-[30px]');
  });

  it('offers the clear affordance only when there is something to clear', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const { rerender } = render(<SearchInput label="Search contacts" value="" onChange={() => {}} onClear={onClear} />);
    expect(screen.queryByRole('button', { name: 'Clear search contacts' })).toBeNull();

    rerender(<SearchInput label="Search contacts" value="amira" onChange={() => {}} onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'Clear search contacts' }));
    expect(onClear).toHaveBeenCalled();
  });

  it('carries the shortcut chip in the top-bar size', () => {
    const { container } = render(<SearchInput label="Search" size="md" kbd="⌘K" />);

    expect(container.firstElementChild?.className).toContain('h-[34px]');
    expect(container.querySelector('kbd')?.textContent).toBe('⌘K');
  });
});

describe('Mono', () => {
  it('is a chip in the mono face on the tint', () => {
    const { container } = render(<Mono value="cmp_8f3k2a" />);
    const chip = container.firstElementChild;

    expect(chip?.textContent).toBe('cmp_8f3k2a');
    expect(chip?.className).toContain('font-mono');
    expect(chip?.className).toContain('bg-tint');
    expect(chip?.className).toContain('h-7');
  });

  it('has a full-width 36px field form for a read-only URL', () => {
    const { container } = render(
      <Mono variant="field" value="https://hooks.relayd.io/in/prv_ses_eu1/9f2c1a" copy copyLabel="Copy webhook URL" />,
    );
    const field = container.firstElementChild;

    expect(field?.className).toContain('h-9');
    expect(field?.className).toContain('rounded-control');
    expect(screen.getByRole('button', { name: 'Copy webhook URL' })).toBeTruthy();
  });

  it('shortens what it shows but never what it copies', async () => {
    const user = userEvent.setup();
    const full = '0100018f3a2b4c5d-7e8f9a0b-1c2d-4e5f-8a9b-0c1d2e3f4a5b-000000';
    const { container } = render(<Mono value={full} truncate={12} copy copyLabel="Copy provider message ID" />);

    expect(screen.getByText('0100018f3a2b…')).toBeTruthy();
    expect(container.firstElementChild?.getAttribute('title')).toBe(full);

    await user.click(screen.getByRole('button', { name: 'Copy provider message ID' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(full);
    });
  });
});

describe('CopyButton', () => {
  it('copies, says so, and goes back to Copy', async () => {
    const user = userEvent.setup();
    render(<CopyButton text="rk_live_7f3a" resetAfterMs={300} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('rk_live_7f3a');
    expect(screen.getByRole('button').textContent).toBe('Copied');
    await waitFor(() => {
      expect(screen.getByRole('button').textContent).toBe('Copy');
    });
  });

  it('reports a refused clipboard instead of pretending it worked', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<CopyButton text="rk_live_7f3a" onError={onError} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    expect(screen.getByRole('button').textContent).toBe('Copy');
    writeText.mockRestore();
  });
});

describe('RevealOnce', () => {
  it('walks the sheets three states and never goes back', async () => {
    const user = userEvent.setup();
    render(
      <RevealOnce
        label="Secret key"
        masked="rk_live_7f3a••••••••••••••••••••"
        secret="rk_live_7f3a9c2e4b8d1f6a0e5c3b7d9a2f4e6c"
        note="You can reveal this key exactly one time."
        warning="This key will not be shown again."
        footnote="Revealed once by Dana Haddad. Masked permanently."
        actions={<button type="button">Rotate key</button>}
      />,
    );

    // 1 of 3: masked, and the reveal is announced as final.
    expect(screen.getByText('rk_live_7f3a••••••••••••••••••••')).toBeTruthy();
    expect(screen.queryByText('rk_live_7f3a9c2e4b8d1f6a0e5c3b7d9a2f4e6c')).toBeNull();
    expect(screen.getByText('You can reveal this key exactly one time.')).toBeTruthy();

    // 2 of 3: shown once, copyable, with the warning.
    await user.click(screen.getByRole('button', { name: 'Reveal once' }));
    expect(screen.getByText('rk_live_7f3a9c2e4b8d1f6a0e5c3b7d9a2f4e6c')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('This key will not be shown again.');

    // 3 of 3: masked forever, with rotate as the only way on.
    await user.click(screen.getByRole('button', { name: "I've stored it" }));
    expect(screen.queryByText('rk_live_7f3a9c2e4b8d1f6a0e5c3b7d9a2f4e6c')).toBeNull();
    expect(screen.getByText('rk_live_7f3a••••••••••••••••••••')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate key' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reveal once' })).toBeNull();
  });

  it('draws the revealed value in the brand box with the 3px ring', () => {
    const { container } = render(
      <RevealOnce masked="•••" secret="rk_live_3e9c" phase="revealed" size="lg" warning="Copy it now." />,
    );
    const box = container.querySelector('code')?.parentElement;

    expect(box?.className).toContain('border-brand');
    expect(box?.className).toContain('ring-[3px]');
    expect(box?.className).toContain('h-11');
  });
});

describe('Avatar and Monogram', () => {
  it('names a person avatar and takes a measured size', () => {
    render(<Avatar initials="DH" name="Dana Haddad" size={24} />);
    const avatar = screen.getByRole('img', { name: 'Dana Haddad' });

    expect(avatar.textContent).toBe('DH');
    expect(avatar.className).toContain('h-6');
    expect(avatar.className).toContain('rounded-full');
    expect(avatar.className).toContain('bg-brand-soft');
  });

  it('hides a decorative avatar from assistive tech instead of spelling initials', () => {
    const { container } = render(<Avatar initials="DH" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('sets an entity monogram square, and a provider kind in the mono face', () => {
    const { container } = render(
      <>
        <Monogram size={28} name="Northwind Voyages">
          NV
        </Monogram>
        <Monogram size={44} name="Amazon SES">
          SES
        </Monogram>
      </>,
    );
    const [workspace, provider] = Array.from(container.querySelectorAll('span'));

    expect(workspace?.className).toContain('rounded-badge');
    expect(workspace?.className).not.toContain('font-mono');
    expect(provider?.className).toContain('font-mono');
    expect(provider?.className).toContain('h-11');
  });

  it('puts the sidebar monogram on the navy chip, not the brand tint', () => {
    render(
      <Monogram tone="sidebar" name="Northwind Voyages">
        NV
      </Monogram>,
    );
    expect(screen.getByRole('img', { name: 'Northwind Voyages' }).className).toContain('bg-sidebar-chip');
  });
});
