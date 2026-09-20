// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ThemeControl,
  applyTheme,
  currentTheme,
  initialTheme,
  readStoredPreference,
  resolveTheme,
  setThemePreference,
} from '../src/index.js';

/**
 * The theme preference and its control.
 *
 * The rules under test are the ones a screenshot cannot see: that "System"
 * is stored as the *absence* of a choice, that `applyTheme` never persists
 * (so a boot call or the preview's `?theme=` flag cannot freeze a theme
 * forever), that the control is a real radiogroup, and that a browser which
 * refuses storage still gets a working switch.
 */

const KEY = 'relayd.theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom has no media engine, so this stands in for the OS: `matches` is
 * readable, settable, and notifies whoever subscribed.
 */
function osPrefersDark(dark: boolean) {
  const state = { matches: dark };
  const listeners = new Set<() => void>();

  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return state.matches;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );

  return {
    /** The person flips their device to dark while the app is open. */
    set(next: boolean) {
      state.matches = next;
      for (const listener of listeners) listener();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

describe('the preference', () => {
  it('is System when nothing is stored', () => {
    expect(readStoredPreference()).toBe('system');
  });

  it('follows the device while it is System', () => {
    osPrefersDark(true);
    expect(resolveTheme('system')).toBe('dark');
    expect(initialTheme()).toBe('dark');
  });

  it('falls back to light when matchMedia is missing', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      throw new Error('not implemented');
    });
    expect(resolveTheme('system')).toBe('light');
    expect(initialTheme()).toBe('light');
  });

  it('stores an explicit Light or Dark and sets the attribute', () => {
    expect(setThemePreference('dark')).toBe('dark');
    expect(window.localStorage.getItem(KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(currentTheme()).toBe('dark');
  });

  it('removes the key for System rather than writing a value', () => {
    // "System" is the absence of a choice. Writing the word would be a
    // second representation of the same state.
    setThemePreference('dark');
    osPrefersDark(false);

    expect(setThemePreference('system')).toBe('light');
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(readStoredPreference()).toBe('system');
  });

  it('does not persist from applyTheme', () => {
    // main.tsx calls applyTheme(initialTheme()) on boot and the preview
    // honours ?theme=dark. If either wrote to storage, System could never
    // survive a reload and a screenshot flag would stick in the reader's
    // own browser.
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(setThemePreference('dark')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(readStoredPreference()).toBe('system');
  });
});

describe('ThemeControl, segmented', () => {
  it('is a radiogroup of three named options, System selected by default', () => {
    render(<ThemeControl />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });

    const options = screen.getAllByRole('radio');
    expect(options.map((option) => option.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(group.getAttribute('aria-label')).toBe('Theme');
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
  });

  it('persists the chosen option and paints the page', async () => {
    render(<ThemeControl />);

    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(window.localStorage.getItem(KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await userEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('moves the selection with the arrow keys', async () => {
    render(<ThemeControl />);
    const system = screen.getByRole('radio', { name: 'System' });

    system.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Light' }));

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');

    // And wraps back round, as a radiogroup does.
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');

    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps one stop in the tab order', () => {
    render(<ThemeControl />);
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('tabindex')).toBe('-1');
  });

  it('renders with storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    render(<ThemeControl />);
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('ThemeControl, icon', () => {
  it('cycles System → Light → Dark → System and says what the press will do', async () => {
    osPrefersDark(false);
    render(<ThemeControl variant="icon" />);

    const button = () => screen.getByRole('button');
    expect(button().getAttribute('aria-label')).toBe(
      'Theme: System (matches your device). Switch to Light.',
    );
    expect(button().getAttribute('title')).toBe(button().getAttribute('aria-label'));

    await userEvent.click(button());
    expect(button().getAttribute('aria-label')).toBe('Theme: Light (always light). Switch to Dark.');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await userEvent.click(button());
    expect(button().getAttribute('aria-label')).toBe('Theme: Dark (always dark). Switch to System.');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await userEvent.click(button());
    expect(button().getAttribute('aria-label')).toBe(
      'Theme: System (matches your device). Switch to Light.',
    );
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('starts from the stored choice', () => {
    window.localStorage.setItem(KEY, 'dark');
    render(<ThemeControl variant="icon" />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Theme: Dark');
  });

  it('follows the device live while the preference is System, and lets go on unmount', () => {
    const os = osPrefersDark(false);
    const view = render(<ThemeControl variant="icon" />);
    expect(os.listeners).toBe(1);

    act(() => os.set(true));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    view.unmount();
    expect(os.listeners).toBe(0);
  });

  it('stops following the device once a theme is chosen outright', async () => {
    const os = osPrefersDark(false);
    render(<ThemeControl variant="icon" />);

    await userEvent.click(screen.getByRole('button')); // System → Light
    expect(os.listeners).toBe(0);

    act(() => os.set(true));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('takes the sidebar tokens, like the Sign out button beside it', () => {
    render(<ThemeControl variant="icon" />);
    const className = screen.getByRole('button').className;

    expect(className).toContain('text-sidebar-muted');
    expect(className).toContain('hover:bg-white/[.08]');
    expect(className).toContain('hover:text-white');
  });
});
