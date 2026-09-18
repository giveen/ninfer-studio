import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, getStoredTheme, getSystemTheme, resolveTheme, subscribeTheme, STORAGE_KEY } from './theme';

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
});
