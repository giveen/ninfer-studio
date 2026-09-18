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
export const USER_PRESETS_STORAGE_KEY = 'ninfier-user-theme-presets';

export interface ThemeVariables {
  bg: string;
  panel: string;
  panel2: string;
  inset: string;
  ink: string;
  mute: string;
  accent: string;
  accentHover: string;
  line?: string;
  line2?: string;
  btnRadius?: string;
}

export type ThemePresetId =
  | 'midnight-lime'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'dracula'
  | 'monaspace-neon'
  | 'nordic-frost'
  | 'monokai-dark'
  | 'win95'
  | 'crisp-light'
  | 'solarized-light'
  | 'custom'
  | (string & {});

export interface ThemePreset {
  id: ThemePresetId;
  name: string;
  darkVariables: ThemeVariables;
  lightVariables: ThemeVariables;
}

export interface UserThemePreset {
  id: string;
  name: string;
  darkVariables: ThemeVariables;
  lightVariables: ThemeVariables;
  createdAt: number;
}

export const PRESET_THEMES: Record<Exclude<ThemePresetId, 'custom'>, ThemePreset> = {
  'midnight-lime': {
    id: 'midnight-lime',
    name: 'Midnight Lime',
    darkVariables: {
      bg: '#090d16',
      panel: '#111726',
      panel2: '#182032',
      inset: '#0d121e',
      ink: '#f1f5f9',
      mute: '#94a3b8',
      accent: '#b7f04a',
      accentHover: '#c8f75e',
      line: 'rgba(255, 255, 255, 0.08)',
      line2: 'rgba(255, 255, 255, 0.16)',
      btnRadius: '8px',
    },
    lightVariables: {
      bg: '#f4f9eb',
      panel: '#ffffff',
      panel2: '#eef6df',
      inset: '#e4f0cf',
      ink: '#162206',
      mute: '#4f6330',
      accent: '#5d8f16',
      accentHover: '#6ea71b',
      line: 'rgba(93, 143, 22, 0.15)',
      line2: 'rgba(93, 143, 22, 0.28)',
      btnRadius: '8px',
    },
  },
  'tokyo-night': {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    darkVariables: {
      bg: '#1a1b26',
      panel: '#1f2335',
      panel2: '#24283b',
      inset: '#16161e',
      ink: '#c0caf5',
      mute: '#7aa2f7',
      accent: '#bb9af7',
      accentHover: '#c099ff',
      line: 'rgba(122, 162, 247, 0.15)',
      line2: 'rgba(122, 162, 247, 0.28)',
      btnRadius: '8px',
    },
    lightVariables: {
      bg: '#e6e9ef',
      panel: '#ffffff',
      panel2: '#d5d6db',
      inset: '#e1e2e7',
      ink: '#343b58',
      mute: '#4c566a',
      accent: '#7aa2f7',
      accentHover: '#89b4fa',
      line: 'rgba(52, 59, 88, 0.12)',
      line2: 'rgba(52, 59, 88, 0.22)',
      btnRadius: '8px',
    },
  },
  'catppuccin-mocha': {
    id: 'catppuccin-mocha',
    name: 'Catppuccin',
    darkVariables: {
      bg: '#1e1e2e',
      panel: '#181825',
      panel2: '#313244',
      inset: '#11111b',
      ink: '#cdd6f4',
      mute: '#a6adc8',
      accent: '#cba6f7',
      accentHover: '#f5c2e7',
      line: 'rgba(205, 214, 244, 0.12)',
      line2: 'rgba(205, 214, 244, 0.24)',
      btnRadius: '10px',
    },
    lightVariables: {
      bg: '#eff1f5',
      panel: '#ffffff',
      panel2: '#e6e9ef',
      inset: '#dce0e8',
      ink: '#4c4f69',
      mute: '#6c6f85',
      accent: '#8839ef',
      accentHover: '#ea76cb',
      line: 'rgba(76, 79, 105, 0.12)',
      line2: 'rgba(76, 79, 105, 0.22)',
      btnRadius: '10px',
    },
  },
  'dracula': {
    id: 'dracula',
    name: 'Dracula',
    darkVariables: {
      bg: '#282a36',
      panel: '#21222c',
      panel2: '#44475a',
      inset: '#191a21',
      ink: '#f8f8f2',
      mute: '#6272a4',
      accent: '#bd93f9',
      accentHover: '#ff79c6',
      line: 'rgba(98, 114, 164, 0.3)',
      line2: 'rgba(98, 114, 164, 0.5)',
      btnRadius: '8px',
    },
    lightVariables: {
      bg: '#f8f8f2',
      panel: '#ffffff',
      panel2: '#e8e8e2',
      inset: '#deded6',
      ink: '#282a36',
      mute: '#6272a4',
      accent: '#9542e5',
      accentHover: '#d13894',
      line: 'rgba(40, 42, 54, 0.15)',
      line2: 'rgba(40, 42, 54, 0.25)',
      btnRadius: '8px',
    },
  },
  'monaspace-neon': {
    id: 'monaspace-neon',
    name: 'Monaspace Neon',
    darkVariables: {
      bg: '#0d1117',
      panel: '#161b22',
      panel2: '#21262d',
      inset: '#010409',
      ink: '#e6edf3',
      mute: '#8b949e',
      accent: '#2f81f7',
      accentHover: '#388bfd',
      line: 'rgba(48, 54, 61, 0.7)',
      line2: 'rgba(139, 148, 158, 0.3)',
      btnRadius: '6px',
    },
    lightVariables: {
      bg: '#f6f8fa',
      panel: '#ffffff',
      panel2: '#eaeef2',
      inset: '#e1e4e8',
      ink: '#1f2328',
      mute: '#57606a',
      accent: '#0969da',
      accentHover: '#218bff',
      line: 'rgba(31, 35, 40, 0.15)',
      line2: 'rgba(31, 35, 40, 0.25)',
      btnRadius: '6px',
    },
  },
  'nordic-frost': {
    id: 'nordic-frost',
    name: 'Nordic Frost',
    darkVariables: {
      bg: '#2e3440',
      panel: '#3b4252',
      panel2: '#434c5e',
      inset: '#242933',
      ink: '#eceff4',
      mute: '#d8dee9',
      accent: '#88c0d0',
      accentHover: '#8fbcbb',
      line: 'rgba(216, 222, 233, 0.12)',
      line2: 'rgba(216, 222, 233, 0.22)',
      btnRadius: '8px',
    },
    lightVariables: {
      bg: '#e5e9f0',
      panel: '#ffffff',
      panel2: '#eceff4',
      inset: '#d8dee9',
      ink: '#2e3440',
      mute: '#4c566a',
      accent: '#5e81ac',
      accentHover: '#81a1c1',
      line: 'rgba(46, 52, 64, 0.12)',
      line2: 'rgba(46, 52, 64, 0.22)',
      btnRadius: '8px',
    },
  },
  'monokai-dark': {
    id: 'monokai-dark',
    name: 'Monokai',
    darkVariables: {
      bg: '#272822',
      panel: '#3e3d32',
      panel2: '#49483e',
      inset: '#1e1f1c',
      ink: '#f8f8f2',
      mute: '#cfcfc2',
      accent: '#a6e22e',
      accentHover: '#b6f23e',
      line: 'rgba(248, 248, 242, 0.12)',
      line2: 'rgba(248, 248, 242, 0.22)',
      btnRadius: '6px',
    },
    lightVariables: {
      bg: '#f7f7f1',
      panel: '#ffffff',
      panel2: '#e8e8df',
      inset: '#deded2',
      ink: '#272822',
      mute: '#75715e',
      accent: '#689710',
      accentHover: '#7da61a',
      line: 'rgba(39, 40, 34, 0.15)',
      line2: 'rgba(39, 40, 34, 0.25)',
      btnRadius: '6px',
    },
  },
  'win95': {
    id: 'win95',
    name: 'Windows 95',
    darkVariables: {
      bg: '#004040',
      panel: '#2b2b2b',
      panel2: '#3c3c3c',
      inset: '#1a1a1a',
      ink: '#ffffff',
      mute: '#a0a0a0',
      accent: '#1084d0',
      accentHover: '#2094e0',
      line: '#555555',
      line2: '#000000',
      btnRadius: '2px',
    },
    lightVariables: {
      bg: '#008080',
      panel: '#c0c0c0',
      panel2: '#d4d4d4',
      inset: '#ffffff',
      ink: '#000000',
      mute: '#404040',
      accent: '#000080',
      accentHover: '#0000a0',
      line: '#808080',
      line2: '#000000',
      btnRadius: '2px',
    },
  },
  'crisp-light': {
    id: 'crisp-light',
    name: 'Crisp Slate',
    darkVariables: {
      bg: '#0f172a',
      panel: '#1e293b',
      panel2: '#334155',
      inset: '#090e1a',
      ink: '#f8fafc',
      mute: '#94a3b8',
      accent: '#84cc16',
      accentHover: '#a3e635',
      line: 'rgba(248, 250, 252, 0.12)',
      line2: 'rgba(248, 250, 252, 0.22)',
      btnRadius: '8px',
    },
    lightVariables: {
      bg: '#f1f5f9',
      panel: '#ffffff',
      panel2: '#f8fafc',
      inset: '#e2e8f0',
      ink: '#0f172a',
      mute: '#475569',
      accent: '#5d8f16',
      accentHover: '#6ea71b',
      line: 'rgba(15, 23, 42, 0.12)',
      line2: 'rgba(15, 23, 42, 0.22)',
      btnRadius: '8px',
    },
  },
  'solarized-light': {
    id: 'solarized-light',
    name: 'Solarized',
    darkVariables: {
      bg: '#002b36',
      panel: '#073642',
      panel2: '#586e75',
      inset: '#00212b',
      ink: '#93a1a1',
      mute: '#839496',
      accent: '#b58900',
      accentHover: '#cb9b00',
      line: 'rgba(147, 161, 161, 0.15)',
      line2: 'rgba(147, 161, 161, 0.28)',
      btnRadius: '8px',
    },
    lightVariables: {
      bg: '#fdf6e3',
      panel: '#eee8d5',
      panel2: '#e0d9c5',
      inset: '#f5efdc',
      ink: '#657b83',
      mute: '#839496',
      accent: '#b58900',
      accentHover: '#cb9b00',
      line: 'rgba(101, 123, 131, 0.18)',
      line2: 'rgba(101, 123, 131, 0.30)',
      btnRadius: '8px',
    },
  },
};


export const FONT_SANS_STORAGE_KEY = 'ninfier-font-sans';
export const FONT_MONO_STORAGE_KEY = 'ninfier-font-mono';

export const FONT_SANS_PRESETS = [
  { id: 'inter', label: 'Inter (Default)', value: "'Inter Variable', ui-sans-serif, system-ui, sans-serif" },
  { id: 'system', label: 'System Native UI', value: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { id: 'jetbrains-sans', label: 'JetBrains Sans', value: "'JetBrains Sans', 'Inter', ui-sans-serif, sans-serif" },
  { id: 'fira-sans', label: 'Fira Sans', value: "'Fira Sans', ui-sans-serif, sans-serif" },
  { id: 'trebuchet', label: 'Trebuchet / Clean', value: "'Trebuchet MS', 'Lucida Grande', sans-serif" },
];

export const FONT_MONO_PRESETS = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono (Default)', value: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace" },
  { id: 'monaspace-neon', label: 'Monaspace Neon', value: "'Monaspace Neon', 'JetBrains Mono', monospace" },
  { id: 'monaspace-argon', label: 'Monaspace Argon', value: "'Monaspace Argon', 'JetBrains Mono', monospace" },
  { id: 'fira-code', label: 'Fira Code', value: "'Fira Code', 'JetBrains Mono', monospace" },
  { id: 'source-code', label: 'Source Code Pro', value: "'Source Code Pro', ui-monospace, monospace" },
  { id: 'courier-new', label: 'Courier Retro', value: "'Courier New', Courier, monospace" },
];

export function getStoredFontSans(): string {
  try {
    return localStorage.getItem(FONT_SANS_STORAGE_KEY) || FONT_SANS_PRESETS[0].value;
  } catch {
    return FONT_SANS_PRESETS[0].value;
  }
}

export function getStoredFontMono(): string {
  try {
    return localStorage.getItem(FONT_MONO_STORAGE_KEY) || FONT_MONO_PRESETS[0].value;
  } catch {
    return FONT_MONO_PRESETS[0].value;
  }
}

export function applyFontFamily(sansVal?: string, monoVal?: string): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const style = document.documentElement.style;
  if (sansVal) {
    if (style.setProperty) {
      style.setProperty('--font-sans', sansVal);
    } else {
      (style as unknown as Record<string, string>)['--font-sans'] = sansVal;
    }
    try {
      localStorage.setItem(FONT_SANS_STORAGE_KEY, sansVal);
    } catch {
      // ignore
    }
  }
  if (monoVal) {
    if (style.setProperty) {
      style.setProperty('--font-mono', monoVal);
    } else {
      (style as unknown as Record<string, string>)['--font-mono'] = monoVal;
    }
    try {
      localStorage.setItem(FONT_MONO_STORAGE_KEY, monoVal);
    } catch {
      // ignore
    }
  }
}

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

export function getUserThemePresets(): UserThemePreset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as UserThemePreset[];
  } catch {
    // ignore
  }
  return [];
}

export function saveUserThemePreset(
  name: string,
  darkVariables: ThemeVariables,
  lightVariables: ThemeVariables
): UserThemePreset {
  const presets = getUserThemePresets();
  const newPreset: UserThemePreset = {
    id: `user-${Date.now()}`,
    name: name.trim() || 'Custom Preset',
    darkVariables,
    lightVariables,
    createdAt: Date.now(),
  };
  presets.push(newPreset);
  try {
    localStorage.setItem(USER_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore
  }
  return newPreset;
}

export function deleteUserThemePreset(id: string): void {
  const presets = getUserThemePresets().filter((p) => p.id !== id);
  try {
    localStorage.setItem(USER_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore
  }
}

export function parseAndValidateThemeJSON(jsonString: string): {
  name: string;
  darkVariables: ThemeVariables;
  lightVariables: ThemeVariables;
} {
  const data = JSON.parse(jsonString);
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid theme JSON format');
  }
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Imported Theme';
  const fallbackVars = PRESET_THEMES['midnight-lime'].darkVariables;

  const validateVars = (obj: any): ThemeVariables => {
    if (!obj || typeof obj !== 'object') return { ...fallbackVars };
    return {
      bg: typeof obj.bg === 'string' ? obj.bg : fallbackVars.bg,
      panel: typeof obj.panel === 'string' ? obj.panel : fallbackVars.panel,
      panel2: typeof obj.panel2 === 'string' ? obj.panel2 : fallbackVars.panel2,
      inset: typeof obj.inset === 'string' ? obj.inset : fallbackVars.inset,
      ink: typeof obj.ink === 'string' ? obj.ink : fallbackVars.ink,
      mute: typeof obj.mute === 'string' ? obj.mute : fallbackVars.mute,
      accent: typeof obj.accent === 'string' ? obj.accent : fallbackVars.accent,
      accentHover: typeof obj.accentHover === 'string' ? obj.accentHover : fallbackVars.accentHover,
      line: typeof obj.line === 'string' ? obj.line : fallbackVars.line,
      line2: typeof obj.line2 === 'string' ? obj.line2 : fallbackVars.line2,
      btnRadius: typeof obj.btnRadius === 'string' ? obj.btnRadius : fallbackVars.btnRadius,
    };
  };

  const darkVars = data.darkVariables
    ? validateVars(data.darkVariables)
    : data.variables
    ? validateVars(data.variables)
    : { ...fallbackVars };
  const lightVars = data.lightVariables
    ? validateVars(data.lightVariables)
    : data.variables
    ? validateVars(data.variables)
    : PRESET_THEMES['midnight-lime'].lightVariables;

  return { name, darkVariables: darkVars, lightVariables: lightVars };
}

export function exportThemeJSON(preset: {
  name: string;
  darkVariables: ThemeVariables;
  lightVariables: ThemeVariables;
}): string {
  return JSON.stringify(preset, null, 2);
}

export function getStoredPreset(): ThemePresetId {
  try {
    const stored = localStorage.getItem(PRESET_STORAGE_KEY) as ThemePresetId | null;
    if (stored) {
      if (stored === 'custom' || stored in PRESET_THEMES) return stored;
      const userPresets = getUserThemePresets();
      if (userPresets.some((p) => p.id === stored)) return stored;
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

export function getPresetVariables(presetId: ThemePresetId, mode?: ThemeMode): ThemeVariables | null {
  const resolved = resolveTheme(mode ?? getStoredTheme());
  if (presetId in PRESET_THEMES) {
    const preset = PRESET_THEMES[presetId as keyof typeof PRESET_THEMES];
    return resolved === 'light' ? preset.lightVariables : preset.darkVariables;
  }
  const userPresets = getUserThemePresets();
  const found = userPresets.find((p) => p.id === presetId);
  if (found) {
    return resolved === 'light' ? found.lightVariables : found.darkVariables;
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
    ['line', '--color-line'],
    ['line2', '--color-line2'],
    ['btnRadius', '--btn-radius'],
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
        style.setProperty(cssVar, vars[key]!);
      } else {
        (style as unknown as Record<string, string>)[cssVar] = vars[key]!;
      }
    }
  }
}

export function applyPresetTheme(presetId: ThemePresetId, customVars?: ThemeVariables | null, modeOverride?: ThemeMode): void {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, presetId);
  } catch {
    // localStorage unavailable
  }

  const modeToUse = modeOverride ?? getStoredTheme();
  const resolvedMode = applyTheme(modeToUse);

  if (presetId in PRESET_THEMES) {
    const preset = PRESET_THEMES[presetId as keyof typeof PRESET_THEMES];
    const vars = resolvedMode === 'light' ? preset.lightVariables : preset.darkVariables;
    applyCSSVariables(vars);
  } else if (presetId === 'custom' && customVars) {
    try {
      localStorage.setItem(CUSTOM_VARS_STORAGE_KEY, JSON.stringify(customVars));
    } catch {
      // localStorage unavailable
    }
    applyCSSVariables(customVars);
  } else {
    const userPresets = getUserThemePresets();
    const found = userPresets.find((p) => p.id === presetId);
    if (found) {
      const vars = resolvedMode === 'light' ? found.lightVariables : found.darkVariables;
      applyCSSVariables(vars);
    }
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
  --color-line: ${vars.line ?? 'rgba(255, 255, 255, 0.08)'};
  --color-line2: ${vars.line2 ?? 'rgba(255, 255, 255, 0.16)'};
  --btn-radius: ${vars.btnRadius ?? '8px'};
}`;
}



export function getStoredUIScale(): string {
  try {
    return localStorage.getItem('ninfier-ui-scale') || '14px';
  } catch {
    return '14px';
  }
}

export function applyUIScale(scale: string): void {
  try {
    localStorage.setItem('ninfier-ui-scale', scale);
  } catch {
    // localStorage unavailable
  }
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--ui-scale', scale);
    const zoomMap: Record<string, string> = {
      '12.5px': '90%',
      '14px': '100%',
      '15.5px': '110%',
    };
    const zoomVal = zoomMap[scale] || scale;
    (document.documentElement.style as any).zoom = zoomVal;
  }
}

export function initTheme(): void {
  const preset = getStoredPreset();
  const mode = getStoredTheme();
  const sans = getStoredFontSans();
  const mono = getStoredFontMono();
  const scale = getStoredUIScale();

  if (preset === 'custom') {
    const customVars = getStoredCustomVars();
    if (customVars) applyPresetTheme('custom', customVars, mode);
  } else {
    applyPresetTheme(preset, null, mode);
  }
  applyFontFamily(sans, mono);
  applyUIScale(scale);
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

