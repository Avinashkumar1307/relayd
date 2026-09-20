/**
 * Theme switching (design/00 Design System.dc.html, "Colour": light is the
 * default; every dark frame is the same markup with `data-theme="dark"`).
 *
 * One attribute on <html>. The token sheet keys every variable off it, so
 * switching is a single DOM write and nothing re-renders for the sake of
 * colour.
 *
 * ## Three states, not two
 *
 * The preference is `system | light | dark`; the *theme* is only ever
 * `light | dark`. "System" is not a third colour scheme, it is the absence
 * of a stored choice — so choosing it REMOVES the key rather than writing
 * the word, and `resolveTheme` asks `matchMedia` each time it is needed.
 * That keeps one representation of "I have not chosen", which is what every
 * build before this one already stored.
 *
 * ## `applyTheme` does not persist
 *
 * It sets the attribute and nothing else. Persistence belongs to
 * `setThemePreference`, because two callers would otherwise turn a temporary
 * theme into a permanent one:
 *
 *   - `apps/web/src/main.tsx` calls `applyTheme(initialTheme())` on boot. If
 *     that wrote to storage, the resolved value would be frozen on the first
 *     page load and "System" could never survive a reload — the OS could
 *     flip to dark forever after and the app would stay light.
 *   - the preview's `?theme=dark` screenshot flag would stick that theme in
 *     the reader's own browser permanently. That was a real bug, and moving
 *     the write out of `applyTheme` is the fix.
 *
 * Persistence is `localStorage` under one key, wrapped in try/catch: private
 * windows and blocked storage throw, and a theme toggle that crashes the app
 * is worse than one that forgets.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** What the person chose. `system` is the default and stores nothing. */
export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'relayd.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The OS query, or null where `matchMedia` is missing or throws. */
function darkQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(DARK_QUERY);
  } catch {
    return null;
  }
}

export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** The stored choice, or `system` when nothing is stored or storage throws. */
export function readStoredPreference(): ThemePreference {
  return readStoredTheme() ?? 'system';
}

/** `system` asks the OS; everything else is already a theme. */
export function resolveTheme(preference: ThemePreference): Theme {
  if (preference !== 'system') return preference;
  return darkQuery()?.matches === true ? 'dark' : 'light';
}

/** The theme to start with: a stored choice, else the OS preference, else light. */
export function initialTheme(): Theme {
  return resolveTheme(readStoredPreference());
}

/** Sets the attribute. Does not persist — see the note at the top of this file. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Persists the preference, applies the theme it resolves to, and returns
 * that theme. `system` removes the key rather than writing a value.
 */
export function setThemePreference(preference: ThemePreference): Theme {
  try {
    if (preference === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage unavailable. The attribute below is set, which is what
    // matters now; the choice simply will not outlive the tab.
  }

  const theme = resolveTheme(preference);
  applyTheme(theme);
  return theme;
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Flips light↔dark and stores it as an explicit choice. */
export function toggleTheme(): Theme {
  return setThemePreference(currentTheme() === 'dark' ? 'light' : 'dark');
}

export interface ThemePreferenceState {
  preference: ThemePreference;
  resolved: Theme;
  setPreference: (next: ThemePreference) => void;
}

/**
 * The preference as React state.
 *
 * While the preference is `system` this subscribes to the OS query, so
 * flipping the device theme repaints the app immediately instead of at the
 * next reload. It unsubscribes on unmount, and does nothing at all where
 * `matchMedia` is absent.
 */
export function useThemePreference(): ThemePreferenceState {
  const [preference, setStored] = useState<ThemePreference>(() => readStoredPreference());
  const [resolved, setResolved] = useState<Theme>(() => resolveTheme(preference));

  useEffect(() => {
    if (preference !== 'system') return;

    const query = darkQuery();
    if (query === null) return;

    // Only on an actual change: applying on the first run would stamp the
    // attribute over a theme someone set deliberately without storing it —
    // the preview's `?theme=` flag being exactly that.
    const onChange = () => {
      const next = resolveTheme('system');
      setResolved(next);
      applyTheme(next);
    };

    try {
      query.addEventListener('change', onChange);
    } catch {
      return;
    }
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setStored(next);
    setResolved(setThemePreference(next));
  }, []);

  return { preference, resolved, setPreference };
}
