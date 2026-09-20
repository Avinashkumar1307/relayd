// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BANNERS, BANNER_ORDER, Banner } from '../src/Banner.js';
import { Button } from '../src/Button.js';
import { ConfirmDestructive } from '../src/ConfirmDestructive.js';
import { Drawer } from '../src/Drawer.js';
import { Menu } from '../src/Menu.js';
import { Modal } from '../src/Modal.js';
import { Stepper } from '../src/Stepper.js';
import { ToastProvider, useToast } from '../src/Toast.js';

/**
 * Overlays and messaging (design/00 Design System.dc.html — "Drawer, modal,
 * stepper, destructive confirmation", "Toasts", "Global banners (K1)"; the
 * row menu on design/G Campaigns.dc.html).
 *
 * What is asserted is the sheet's own sentences and the contract a
 * screenshot cannot show: that a dialog is announced as one and traps
 * focus, that "destructive actions require typing the resource name" means
 * *exactly*, that "errors stay" while everything else goes at 6 seconds,
 * and that the six banners carry the state contract the K frames state.
 * The structural classes that carry the measured design are checked too,
 * never pixel positions.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* ---------------------------------------------------------------- Modal */

function ModalHarness(props: { closeOnScrimClick?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete workspace?"
        description="This cannot be undone."
        closeOnScrimClick={props.closeOnScrimClick ?? true}
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        }
      >
        <input aria-label="Workspace name" />
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('is a modal dialog named by its title and described by its sentence', async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    const dialog = screen.getByRole('dialog', { name: 'Delete workspace?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByText('This cannot be undone.')).toBeTruthy();
  });

  it('takes focus on open and hands it back to the trigger on close', async () => {
    render(<ModalHarness />);
    const trigger = screen.getByRole('button', { name: 'Open' });

    await userEvent.click(trigger);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('locks the page behind it while it is open', async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(document.body.style.overflow).toBe('hidden');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('keeps Tab inside the dialog', async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog');

    for (let i = 0; i < 4; i += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes on the scrim, unless the caller says not to', async () => {
    const { unmount } = render(<ModalHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    const scrim = document.querySelector('[data-rl-scrim="modal"]');
    expect(scrim).not.toBeNull();
    await userEvent.click(scrim as Element);
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<ModalHarness closeOnScrimClick={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(document.querySelector('[data-rl-scrim="modal"]') as Element);
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('is 520 wide by default, with the sheet’s other two sizes available', () => {
    const { rerender } = render(
      <Modal open onClose={() => {}} title="Merge 2 tags">
        body
      </Modal>,
    );
    expect(screen.getByRole('dialog').style.width).toBe('520px');

    rerender(
      <Modal open onClose={() => {}} title="Merge 2 tags" size="lg">
        body
      </Modal>,
    );
    expect(screen.getByRole('dialog').style.width).toBe('600px');
  });
});

/* --------------------------------------------------------------- Drawer */

describe('Drawer', () => {
  it('is a 440px dialog with a labelled close button and a scrollable body', async () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Amira Khalil" subtitle="amira.khalil@example.ae" footer={<span>foot</span>}>
        <p>profile</p>
      </Drawer>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Amira Khalil' });
    expect(dialog.style.width).toBe('440px');
    expect(dialog.className).toContain('border-l');

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Edit pool">
        <p>body</p>
      </Drawer>,
    );

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/* --------------------------------------------------- ConfirmDestructive */

function confirmView(onConfirm = vi.fn()) {
  render(
    <ConfirmDestructive
      open
      onClose={() => {}}
      onConfirm={onConfirm}
      title="Delete workspace?"
      confirmLabel="Delete workspace"
      confirmPhrase="Northwind Voyages"
      placeholder="Workspace name"
    >
      This permanently deletes Northwind Voyages.
    </ConfirmDestructive>,
  );
  return { onConfirm, button: screen.getByRole('button', { name: 'Delete workspace' }) };
}

describe('ConfirmDestructive', () => {
  it('keeps the danger button disabled, with the reason, until the name is typed', async () => {
    const { button } = confirmView();

    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toBe('Type Northwind Voyages to confirm');
  });

  it('will not accept a near miss', async () => {
    const { button } = confirmView();
    const input = screen.getByLabelText('Confirmation');

    await userEvent.type(input, 'northwind voyages');
    expect(button.hasAttribute('disabled')).toBe(true);

    await userEvent.clear(input);
    await userEvent.type(input, 'Northwind Voyages ');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('arms on an exact match and confirms once', async () => {
    const { onConfirm, button } = confirmView();

    await userEvent.type(screen.getByLabelText('Confirmation'), 'Northwind Voyages');
    expect(button.hasAttribute('disabled')).toBe(false);

    await userEvent.click(button);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('forgets what was typed when it is opened again', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <ConfirmDestructive
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={() => {}}
            title="Delete workspace?"
            confirmLabel="Delete workspace"
            confirmPhrase="Northwind Voyages"
          >
            gone
          </ConfirmDestructive>
        </>
      );
    }
    render(<Harness />);

    await userEvent.type(screen.getByLabelText('Confirmation'), 'Northwind Voyages');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));

    expect((screen.getByLabelText('Confirmation') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Delete workspace' }).hasAttribute('disabled')).toBe(true);
  });
});

/* -------------------------------------------------------------- Stepper */

const STEPS = [
  { key: 'details', label: 'Details', sub: 'Autumn Escapes' },
  { key: 'audience', label: 'Audience', sub: '48,213 est.' },
  { key: 'sender', label: 'Sender & pool' },
  { key: 'content', label: 'Content' },
];

describe('Stepper', () => {
  it('marks the current step and announces where each one stands', () => {
    render(<Stepper steps={STEPS} current={2} />);
    const items = screen.getAllByRole('listitem');

    expect(items[0]?.getAttribute('aria-current')).toBeNull();
    expect(items[2]?.getAttribute('aria-current')).toBe('step');
    expect(items[0]?.textContent).toContain('Completed');
    expect(items[2]?.textContent).toContain('Current step');
    expect(items[3]?.textContent).toContain('Not started');
  });

  it('numbers the steps it has not reached and checks the ones behind it', () => {
    const { container } = render(<Stepper steps={STEPS} current={2} />);
    const items = screen.getAllByRole('listitem');

    // Steps 1 and 2 are done: a check, not a number.
    expect(container.querySelectorAll('svg')).toHaveLength(2);
    expect(items[2]?.textContent).toContain('3');
    expect(items[3]?.textContent).toContain('4');
  });

  it('shows the sub-label the frames put under each step', () => {
    render(<Stepper steps={STEPS} current={2} />);
    expect(screen.getByText('48,213 est.')).toBeTruthy();
  });

  it('lets you go back to a finished step, never forward to an unfinished one', async () => {
    const onStepClick = vi.fn();
    render(<Stepper steps={STEPS} current={2} onStepClick={onStepClick} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);

    await userEvent.click(buttons[0] as HTMLElement);
    expect(onStepClick).toHaveBeenCalledWith(0);
  });

  it('has the sheet’s compact rows as well as the wizard rail', () => {
    const { container, rerender } = render(<Stepper steps={STEPS} current={1} />);
    // The rail dims what is still ahead; the compact card does not.
    expect(container.innerHTML).toContain('opacity-60');

    rerender(<Stepper steps={STEPS} current={1} variant="compact" />);
    expect(container.innerHTML).not.toContain('opacity-60');
  });
});

/* ---------------------------------------------------------------- Toast */

function ToastHarness() {
  const { toast } = useToast();
  return (
    <>
      <button type="button" onClick={() => toast({ tone: 'success', title: 'Draft saved', description: 'Autumn Escapes, 10:42' })}>
        Fire success
      </button>
      <button
        type="button"
        onClick={() => toast({ tone: 'danger', title: 'Export failed', description: 'request req_01J8ZK3VQ7M2' })}
      >
        Fire error
      </button>
    </>
  );
}

describe('Toast', () => {
  it('shows the title and the detail, and takes the tone as a left border', async () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fire success' }));

    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('Draft saved');
    expect(toast.textContent).toContain('Autumn Escapes, 10:42');
    expect(toast.className).toContain('border-l-success');
    expect(toast.className).toContain('border-l-[3px]');
  });

  it('dismisses after six seconds, but an error stays', () => {
    // fireEvent, not userEvent: user-event's own waits run on the timers
    // this test has just replaced.
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fire success' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fire error' }));
    expect(screen.queryByRole('status')).not.toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();

    act(() => void vi.advanceTimersByTime(6000));

    expect(screen.queryByRole('status')).toBeNull();
    // "errors stay": the danger toast is still there, with its request id.
    expect(screen.getByRole('alert').textContent).toContain('req_01J8ZK3VQ7M2');
  });

  it('can be dismissed by hand and runs its action', async () => {
    const onAction = vi.fn();
    function Harness() {
      const { toast } = useToast();
      return (
        <button
          type="button"
          onClick={() => toast({ tone: 'info', title: 'Import running', action: { label: 'View', onClick: onAction } })}
        >
          Fire
        </button>
      );
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Fire' }));
    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(onAction).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('refuses to be used without a provider rather than silently doing nothing', () => {
    function Orphan() {
      useToast();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);
  });
});

/* --------------------------------------------------------------- Banner */

describe('Banner', () => {
  it('renders the tone, the copy, the action and the state key', () => {
    render(
      <Banner
        tone="warning"
        icon="alert"
        title={BANNERS.past_due.title}
        body={BANNERS.past_due.body}
        action={{ label: BANNERS.past_due.actionLabel, href: '/billing' }}
        code="past_due"
      />,
    );

    const banner = screen.getByRole('status');
    expect(banner.className).toContain('bg-warning-soft');
    expect(banner.className).toContain('border-warning');
    expect(banner.textContent).toContain('Payment failed on 15 Sep.');
    expect(screen.getByRole('link', { name: 'Update payment method' }).getAttribute('href')).toBe('/billing');
    expect(screen.getByText('past_due')).toBeTruthy();
  });

  it('interrupts for a danger banner and waits its turn otherwise', () => {
    const { rerender } = render(<Banner tone="danger" icon="lock" title="Workspace suspended." />);
    expect(screen.getByRole('alert')).toBeTruthy();

    rerender(<Banner tone="info" icon="info" title="New account sending cap: 500 emails/day." />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('carries all six K1 banners with their state contract', () => {
    expect(BANNER_ORDER).toHaveLength(6);

    for (const key of BANNER_ORDER) {
      const definition = BANNERS[key];
      expect(definition.key).toBe(key);
      expect(definition.title.length).toBeGreaterThan(0);
      // The sheet: "Copy says what happened and what continues to work."
      expect(definition.contract.keepsWorking.length).toBeGreaterThan(0);
      expect(definition.contract.blocked.length).toBeGreaterThan(0);
      expect(definition.contract.trigger.length).toBeGreaterThan(0);
      expect(definition.contract.clearedBy.length).toBeGreaterThan(0);
    }
  });

  it('is the dunning ladder, and only suspension is read-only', () => {
    expect(BANNERS.past_due.tone).toBe('warning');
    expect(BANNERS.restricted.tone).toBe('warning');
    expect(BANNERS.suspended.tone).toBe('danger');
    expect(BANNERS.provider_failed.tone).toBe('danger');

    expect(BANNERS.suspended.contract.readOnly).toBe(true);
    expect(BANNERS.past_due.contract.readOnly).toBe(false);
    expect(BANNERS.restricted.contract.readOnly).toBe(false);

    // The one banner an admin, not the owner, is asked to act on.
    expect(BANNERS.provider_failed.contract.actor).toBe('Admin');
  });
});

/* ----------------------------------------------------------------- Menu */

const ITEMS = [
  { key: 'edit', label: 'Edit' },
  { key: 'duplicate', label: 'Duplicate' },
  { key: 'launch', label: 'Launch', disabled: true, reason: 'Viewers cannot launch campaigns' },
  { key: 'delete', label: 'Delete', tone: 'danger' as const, separatorBefore: true },
];

describe('Menu', () => {
  it('is a closed menu button until it is opened', async () => {
    render(<Menu items={ITEMS} />);
    const trigger = screen.getByRole('button', { name: 'Quick actions' });

    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
  });

  it('is 190 wide and 2px under the 28px trigger, as the campaigns row measures', async () => {
    render(<Menu items={ITEMS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Quick actions' }));

    const menu = screen.getByRole('menu');
    expect(menu.style.width).toBe('190px');
    expect(menu.className).toContain('top-[30px]');
    expect(screen.getByRole('button', { name: 'Quick actions' }).className).toContain('h-7');
  });

  it('walks with the arrow keys and wraps', async () => {
    render(<Menu items={ITEMS} />);
    const trigger = screen.getByRole('button', { name: 'Quick actions' });

    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Edit');

    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement?.textContent).toBe('Delete');

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Edit');
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    render(<Menu items={ITEMS} />);
    const trigger = screen.getByRole('button', { name: 'Quick actions' });

    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the click lands elsewhere', async () => {
    render(
      <>
        <Menu items={ITEMS} />
        <p>elsewhere</p>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Quick actions' }));
    await userEvent.click(screen.getByText('elsewhere'));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs the item that was chosen and colours the destructive one', async () => {
    const onSelect = vi.fn();
    render(<Menu items={[{ key: 'delete', label: 'Delete', tone: 'danger', onSelect }]} />);

    await userEvent.click(screen.getByRole('button', { name: 'Quick actions' }));
    const item = screen.getByRole('menuitem', { name: 'Delete' });
    expect(item.className).toContain('text-danger-text');

    await userEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps a disabled item readable and says why it cannot be chosen', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        items={[{ key: 'launch', label: 'Launch', disabled: true, reason: 'Viewers cannot launch campaigns', onSelect }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Quick actions' }));

    const item = screen.getByRole('menuitem', { name: 'Launch' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('Viewers cannot launch campaigns');

    await userEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('separates the destructive item from the rest', async () => {
    render(<Menu items={ITEMS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Quick actions' }));

    expect(screen.getByRole('menu').querySelectorAll('[role="separator"]')).toHaveLength(1);
  });
});
