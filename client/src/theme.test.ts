import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  browserStorage,
  DARK_THEME_COLOR,
  effectiveTheme,
  LIGHT_THEME_COLOR,
  readThemeMode,
  THEME_STORAGE_KEY,
  writeThemeMode,
  systemThemePreference,
} from './theme';

describe('device theme preference', () => {
  it('defaults to System for empty, invalid, or unavailable storage', () => {
    expect(readThemeMode({ getItem: () => null })).toBe('system');
    expect(readThemeMode({ getItem: () => 'sepia' })).toBe('system');
    expect(
      readThemeMode({
        getItem: () => {
          throw new Error('storage unavailable');
        },
      }),
    ).toBe('system');
  });

  it('uses only valid saved modes and does not surface storage write failures', () => {
    expect(readThemeMode({ getItem: () => 'dark' })).toBe('dark');
    const values = new Map<string, string>();
    expect(writeThemeMode({ setItem: (key, value) => values.set(key, value) }, 'light')).toBe(true);
    expect(values.get(THEME_STORAGE_KEY)).toBe('light');
    expect(
      writeThemeMode(
        {
          setItem: () => {
            throw new Error('storage unavailable');
          },
        },
        'dark',
      ),
    ).toBe(false);
  });

  it('follows the live system value only when System is selected', () => {
    expect(effectiveTheme('system', true)).toBe('dark');
    expect(effectiveTheme('system', false)).toBe('light');
    expect(effectiveTheme('light', true)).toBe('light');
    expect(effectiveTheme('dark', false)).toBe('dark');
  });

  it('updates the document theme and browser toolbar color together', () => {
    const root = document.createElement('html');
    const meta = document.createElement('meta');
    expect(applyTheme(root, 'dark', false, meta)).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(meta.content).toBe(DARK_THEME_COLOR);
    expect(applyTheme(root, 'system', false, meta)).toBe('light');
    expect(meta.content).toBe(LIGHT_THEME_COLOR);
  });

  it('falls back safely when the browser has no system-theme API', () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    try {
      expect(systemThemePreference()).toBeNull();
    } finally {
      if (original)
        Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('returns empty optional storage when localStorage access itself is blocked', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage unavailable');
      },
    });
    try {
      expect(browserStorage().getItem(THEME_STORAGE_KEY)).toBeNull();
      expect(browserStorage().setItem(THEME_STORAGE_KEY, 'dark')).toBeUndefined();
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else Reflect.deleteProperty(window, 'localStorage');
    }
  });
});
