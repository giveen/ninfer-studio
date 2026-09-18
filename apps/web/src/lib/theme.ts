// Theme preference: a client-only setting applied as a `data-theme` attribute
// and `color-scheme` CSS property on <html>.
// Supports 3 modes: 'dark' | 'light' | 'system'.
// Only explicit 'dark' or 'light' choices are stored in localStorage.
// 'system' matches the OS color scheme dynamically via matchMedia.

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const STORAGE_KEY = 'ninfier-theme';
export const PRESET_STORAGE_KEY = 'ninfier-preset-theme';
export const CUSTOM_VARS_STORAGE_KEY = 'ninfier-custom-theme-vars';

export interface ThemeVariables {
  bg: string;
  panel: string;
  panel2: string;
  inset: string;
  ink: string;
  mute: string;
  accent: string;
  accentHover: string;
}

export type ThemePresetId =
  | 'midnight-lime'
  | 'tokyo-night'
  | 'nordic-frost'
  | 'monokai-dark'
  | 'win95'
  | 'crisp-light'
  | 'solarized-light'
  | 'custom';

export interface ThemePreset {
  id: ThemePresetId;
  name: string;
  mode: 'dark' | 'light';
  variables: ThemeVariables;
}

export const PRESET_THEMES: Record<Exclude<ThemePresetId, 'custom'>, ThemePreset> = {
  'midnight-lime': {
    id: 'midnight-lime',
    name: 'Midnight Lime',
    mode: 'dark',
    variables: {
      bg: '#090d16',
      panel: '#111726',
      panel2: '#182032',
      inset: '#0d121e',
      ink: '#f1f5f9',
      mute: '#94a3b8',
      accent: '#b7f04a',
      accentHover: '#c8f75e',
    },
  },
  'tokyo-night': {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    variables: {
      bg: '#1a1b26',
      panel: '#1f2335',
      panel2: '#24283b',
      inset: '#16161e',
      ink: '#c0caf5',
      mute: '#7aa2f7',
      accent: '#bb9af7',
      accentHover: '#c099ff',
    },
  },
  'nordic-frost': {
    id: 'nordic-frost',
    name: 'Nordic Frost',
    mode: 'dark',
    variables: {
      bg: '#2e3440',
      panel: '#3b4252',
      panel2: '#434c5e',
      inset: '#242933',
      ink: '#eceff4',
      mute: '#d8dee9',
      accent: '#88c0d0',
      accentHover: '#8fbcbb',
    },
  },
  'monokai-dark': {
    id: 'monokai-dark',
    name: 'Monokai Dark',
    mode: 'dark',
    variables: {
      bg: '#272822',
      panel: '#3e3d32',
      panel2: '#49483e',
      inset: '#1e1f1c',
      ink: '#f8f8f2',
      mute: '#cfcfc2',
      accent: '#a6e22e',
      accentHover: '#b6f23e',
    },
  },
  'win95': {
    id: 'win95',
    name: 'Windows 95',
    mode: 'light',
    variables: {
      bg: '#008080',
      panel: '#c0c0c0',
      panel2: '#d4d4d4',
      inset: '#ffffff',
      ink: '#000000',
      mute: '#555555',
      accent: '#000080',
      accentHover: '#0000a0',
    },
  },
  'crisp-light': {
    id: 'crisp-light',
    name: 'Crisp Light',
    mode: 'light',
    variables: {
      bg: '#f1f5f9',
      panel: '#ffffff',
      panel2: '#f8fafc',
      inset: '#e2e8f0',
      ink: '#0f172a',
      mute: '#475569',
      accent: '#5d8f16',
      accentHover: '#6ea71b',
    },
  },
  'solarized-light': {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    variables: {
      bg: '#fdf6e3',
      panel: '#eee8d5',
      panel2: '#e0d9c5',
      inset: '#f5efdc',
      ink: '#657b83',
      mute: '#839496',
      accent: '#b58900',
      accentHover: '#cb9b00',
    },
  },
};


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

export function getStoredPreset(): ThemePresetId {
  try {
    const stored = localStorage.getItem(PRESET_STORAGE_KEY) as ThemePresetId | null;
    if (stored && (stored === 'custom' || stored in PRESET_THEMES)) {
      return stored;
    }
  } catch {
    // fall through
  }
  return 'midnight-lime';
}

export function getStoredCustomVars(): ThemeVariables | null {
  try {
    const raw = localStorage.getItem(CUSTOM_VARS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ThemeVariables;
  } catch {
    // fall through
  }
  return null;
}

export function applyCSSVariables(vars: ThemeVariables | null): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const style = document.documentElement.style;
  const keys: Array<[keyof ThemeVariables, string]> = [
    ['bg', '--color-bg'],
    ['panel', '--color-panel'],
    ['panel2', '--color-panel2'],
    ['inset', '--color-inset'],
    ['ink', '--color-ink'],
    ['mute', '--color-mute'],
    ['accent', '--color-accent'],
    ['accentHover', '--color-accent-hover'],
  ];

  if (!vars) {
    for (const [, cssVar] of keys) {
      if (style.removeProperty) {
        style.removeProperty(cssVar);
      } else {
        delete (style as unknown as Record<string, string>)[cssVar];
      }
    }
    return;
  }

  for (const [key, cssVar] of keys) {
    if (vars[key]) {
      if (style.setProperty) {
        style.setProperty(cssVar, vars[key]);
      } else {
        (style as unknown as Record<string, string>)[cssVar] = vars[key];
      }
    }
  }
}

export function applyPresetTheme(presetId: ThemePresetId, customVars?: ThemeVariables | null): void {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, presetId);
  } catch {
    // localStorage unavailable
  }

  if (presetId in PRESET_THEMES) {
    const preset = PRESET_THEMES[presetId as keyof typeof PRESET_THEMES];
    applyTheme(preset.mode);
    applyCSSVariables(preset.variables);
  } else if (presetId === 'custom' && customVars) {
    try {
      localStorage.setItem(CUSTOM_VARS_STORAGE_KEY, JSON.stringify(customVars));
    } catch {
      // localStorage unavailable
    }
    applyCSSVariables(customVars);
  }
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

export function exportThemeCSS(vars: ThemeVariables): string {
  return `/* Ninfer Custom Theme */
:root {
  --color-bg: ${vars.bg};
  --color-panel: ${vars.panel};
  --color-panel2: ${vars.panel2};
  --color-inset: ${vars.inset};
  --color-ink: ${vars.ink};
  --color-mute: ${vars.mute};
  --color-accent: ${vars.accent};
  --color-accent-hover: ${vars.accentHover};
}`;
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

