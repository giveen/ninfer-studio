// Theme preference: a client-only setting applied as a `data-theme` attribute
// and `color-scheme` CSS property on <html>.
// Supports 3 modes: 'dark' | 'light' | 'system'.
// Only explicit 'dark' or 'light' choices are stored in localStorage.
// 'system' matches the OS color scheme dynamically via matchMedia.

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const STORAGE_KEY = 'ninfier-theme';

export function getSystemTheme(): ResolvedTheme {
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
    // fall through to 'system'
  }
  return 'system';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    return getSystemTheme();
  }
  return mode;
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.style.colorScheme = resolved;
  }
  try {
    if (mode === 'system') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, mode);
    }
  } catch {
    // localStorage unavailable (private mode, etc.)
  }
  return resolved;
}

export function subscribeTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {};
  }
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const listener = () => {
    onChange(mq.matches ? 'light' : 'dark');
  };
  if (mq.addEventListener) {
    mq.addEventListener('change', listener);
  } else if ('addListener' in mq) {
    (mq as unknown as { addListener: (l: () => void) => void }).addListener(listener);
  }
  return () => {
    if (mq.removeEventListener) {
      mq.removeEventListener('change', listener);
    } else if ('removeListener' in mq) {
      (mq as unknown as { removeListener: (l: () => void) => void }).removeListener(listener);
    }
  };
}
