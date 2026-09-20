/**
 * Theme switching (design/00 Design System.dc.html, "Colour": light is the
 * default; every dark frame is the same markup with `data-theme="dark"`).
 *
 * One attribute on <html>. The token sheet keys every variable off it, so
 * switching is a single DOM write and nothing re-renders for the sake of
 * colour.
 *
 * Persistence is `localStorage` under one key, wrapped in try/catch: private
 * windows and blocked storage throw, and a theme toggle that crashes the app
 * is worse than one that forgets.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'relayd.theme';

export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** The theme to start with: a stored choice, else the OS preference, else light. */
export function initialTheme(): Theme {
  const stored = readStoredTheme();
  if (stored !== null) return stored;

  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable. The attribute is set, which is what matters now.
  }
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}
