import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FONT_MONO_PRESETS,
  FONT_SANS_PRESETS,
  PRESET_STORAGE_KEY,
  PRESET_THEMES,
  STORAGE_KEY,
  applyFontFamily,
  applyPresetTheme,
  applyTheme,
  deleteUserThemePreset,
  exportThemeCSS,
  exportThemeJSON,
  getStoredCustomVars,
  getStoredFontMono,
  getStoredFontSans,
  getStoredPreset,
  getStoredTheme,
  getSystemTheme,
  getUserThemePresets,
  parseAndValidateThemeJSON,
  resolveTheme,
  saveUserThemePreset,
  subscribeTheme,
} from './theme';



class MockStorage implements Storage {
  private store: Record<string, string> = {};
  get length() {
    return Object.keys(this.store).length;
  }
  clear() {
    this.store = {};
  }
  getItem(key: string) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  }
  key(index: number) {
    return Object.keys(this.store)[index] ?? null;
  }
  removeItem(key: string) {
    delete this.store[key];
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
}

describe('theme preferences', () => {
  let storage: MockStorage;
  let docElement: {
    attributes: Record<string, string>;
    style: Record<string, string>;
    setAttribute: (name: string, val: string) => void;
    removeAttribute: (name: string) => void;
    getAttribute: (name: string) => string | null;
  };

  beforeEach(() => {
    storage = new MockStorage();
    docElement = {
      attributes: {},
      style: {},
      setAttribute(name: string, val: string) {
        this.attributes[name] = val;
      },
      removeAttribute(name: string) {
        delete this.attributes[name];
      },
      getAttribute(name: string) {
        return this.attributes[name] ?? null;
      },
    };

    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('document', { documentElement: docElement });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('defaults getStoredTheme to system when localStorage is empty', () => {
    expect(getStoredTheme()).toBe('system');
  });

  it('returns stored theme when set to dark or light', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    expect(getStoredTheme()).toBe('light');

    localStorage.setItem(STORAGE_KEY, 'dark');
    expect(getStoredTheme()).toBe('dark');
  });

  it('resolves explicit and system theme modes correctly', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('system')).toBe(getSystemTheme());
  });

  it('applyTheme("system") sets data-theme and colorScheme without polluting localStorage', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    const resolved = applyTheme('system');

    expect(docElement.getAttribute('data-theme')).toBe(resolved);
    expect(docElement.style.colorScheme).toBe(resolved);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('applyTheme("light") sets attributes and persists to localStorage', () => {
    const resolved = applyTheme('light');

    expect(resolved).toBe('light');
    expect(docElement.getAttribute('data-theme')).toBe('light');
    expect(docElement.style.colorScheme).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('subscribes to OS prefers-color-scheme changes', () => {
    let listener: (() => void) | undefined;
    const addEventListenerMock = vi.fn((event, cb) => {
      listener = cb;
    });
    const removeEventListenerMock = vi.fn();

    vi.stubGlobal('window', {
      matchMedia: vi.fn().mockReturnValue({
        matches: true,
        media: '(prefers-color-scheme: light)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: addEventListenerMock,
        removeEventListener: removeEventListenerMock,
        dispatchEvent: vi.fn(),
      }),
    });

    const onChange = vi.fn();
    const cleanup = subscribeTheme(onChange);

    expect(addEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function));

    if (listener) listener();
    expect(onChange).toHaveBeenCalledWith('light');

    cleanup();
    expect(removeEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('handles localStorage throwing gracefully', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('Access denied');
      },
      setItem() {
        throw new Error('Access denied');
      },
      removeItem() {
        throw new Error('Access denied');
      },
    });

    expect(getStoredTheme()).toBe('system');
    expect(() => applyTheme('dark')).not.toThrow();
  });

  it('manages theme presets and applies CSS variables', () => {
    expect(getStoredPreset()).toBe('midnight-lime');

    applyPresetTheme('tokyo-night');
    expect(localStorage.getItem(PRESET_STORAGE_KEY)).toBe('tokyo-night');
    expect(docElement.style['--color-bg']).toBe('#1a1b26');
    expect(docElement.style['--color-accent']).toBe('#bb9af7');

    const customVars = {
      bg: '#111111',
      panel: '#222222',
      panel2: '#333333',
      inset: '#000000',
      ink: '#ffffff',
      mute: '#888888',
      accent: '#ff0055',
      accentHover: '#ff3377',
    };
    applyPresetTheme('custom', customVars);
    expect(localStorage.getItem(PRESET_STORAGE_KEY)).toBe('custom');
    expect(getStoredCustomVars()).toEqual(customVars);
    expect(docElement.style['--color-bg']).toBe('#111111');
    expect(docElement.style['--color-accent']).toBe('#ff0055');
  });

  it('exports CSS variables formatted correctly', () => {
    const css = exportThemeCSS(PRESET_THEMES['nordic-frost'].darkVariables);
    expect(css).toContain('--color-bg: #2e3440');
    expect(css).toContain('--color-accent: #88c0d0');
  });

  it('supports Catppuccin, Dracula, and Monaspace Neon presets across dark and light modes', () => {
    applyPresetTheme('catppuccin-mocha', null, 'dark');
    expect(docElement.style['--color-bg']).toBe('#1e1e2e');
    expect(docElement.style['--color-accent']).toBe('#cba6f7');

    applyPresetTheme('catppuccin-mocha', null, 'light');
    expect(docElement.style['--color-bg']).toBe('#eff1f5');
    expect(docElement.style['--color-accent']).toBe('#8839ef');

    applyPresetTheme('dracula', null, 'dark');
    expect(docElement.style['--color-bg']).toBe('#282a36');
    expect(docElement.style['--color-accent']).toBe('#bd93f9');

    applyPresetTheme('dracula', null, 'light');
    expect(docElement.style['--color-bg']).toBe('#f8f8f2');
    expect(docElement.style['--color-accent']).toBe('#9542e5');
  });


  it('manages font family configuration', () => {
    expect(getStoredFontSans()).toBe(FONT_SANS_PRESETS[0].value);
    expect(getStoredFontMono()).toBe(FONT_MONO_PRESETS[0].value);

    applyFontFamily("'Fira Sans', sans-serif", "'Monaspace Neon', monospace");
    expect(docElement.style['--font-sans']).toBe("'Fira Sans', sans-serif");
    expect(docElement.style['--font-mono']).toBe("'Monaspace Neon', monospace");
    expect(getStoredFontSans()).toBe("'Fira Sans', sans-serif");
    expect(getStoredFontMono()).toBe("'Monaspace Neon', monospace");
  });

  it('saves, resolves, and deletes user-created theme presets', () => {
    const darkVars = { ...PRESET_THEMES['midnight-lime'].darkVariables, accent: '#ff00bb' };
    const lightVars = { ...PRESET_THEMES['midnight-lime'].lightVariables, accent: '#aa0088' };

    const created = saveUserThemePreset('Cyberpunk Neon', darkVars, lightVars);
    expect(created.name).toBe('Cyberpunk Neon');
    expect(created.id).toContain('user-');

    const userPresets = getUserThemePresets();
    expect(userPresets).toHaveLength(1);
    expect(userPresets[0].name).toBe('Cyberpunk Neon');

    applyPresetTheme(created.id, null, 'dark');
    expect(docElement.style['--color-accent']).toBe('#ff00bb');

    deleteUserThemePreset(created.id);
    expect(getUserThemePresets()).toHaveLength(0);
  });

  it('parses and validates imported theme JSON strings', () => {
    const validJSON = JSON.stringify({
      name: 'Emerald Dawn',
      darkVariables: { bg: '#051d1a', panel: '#0a2d28', accent: '#00ffcc' },
      lightVariables: { bg: '#e6f9f5', panel: '#ffffff', accent: '#00aa88' },
    });

    const parsed = parseAndValidateThemeJSON(validJSON);
    expect(parsed.name).toBe('Emerald Dawn');
    expect(parsed.darkVariables.bg).toBe('#051d1a');
    expect(parsed.darkVariables.accent).toBe('#00ffcc');

    expect(() => parseAndValidateThemeJSON('invalid json')).toThrow();
  });

  it('exports theme data into JSON format', () => {
    const preset = {
      name: 'Custom Sunset',
      darkVariables: PRESET_THEMES['dracula'].darkVariables,
      lightVariables: PRESET_THEMES['dracula'].lightVariables,
    };
    const jsonStr = exportThemeJSON(preset);
    expect(jsonStr).toContain('"name": "Custom Sunset"');
    expect(jsonStr).toContain('"accent": "#bd93f9"');
  });
});


