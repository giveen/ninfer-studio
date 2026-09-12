// Theme preference: a client-only setting (not synced through the control
// plane — it's a per-machine display preference, not app config) applied as
// a `data-theme` attribute on <html> so theme.css's `:root[data-theme='light']`
// overrides take effect. Persisted to localStorage; a tiny inline script in
// index.html also applies it synchronously before first paint so switching
// to light doesn't flash dark on reload.
export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'ninfier-theme';

function getSystemTheme(): ThemeMode {
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function getStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // fall through to the OS preference
  }
  // No explicit choice yet — match the OS instead of always defaulting dark.
  return getSystemTheme();
}

export function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // localStorage unavailable (private mode, etc.) — theme just won't persist
  }
}
