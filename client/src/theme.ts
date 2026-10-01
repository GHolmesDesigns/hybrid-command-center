export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_STORAGE_KEY = 'hcc-theme-mode';
export const LIGHT_THEME_COLOR = '#f4f3ef';
export const DARK_THEME_COLOR = '#151a18';
const UNAVAILABLE_STORAGE: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => null,
  setItem: () => undefined,
};

export function readThemeMode(storage: Pick<Storage, 'getItem'>): ThemeMode {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return THEME_MODES.includes(value as ThemeMode) ? (value as ThemeMode) : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemeMode(storage: Pick<Storage, 'setItem'>, mode: ThemeMode): boolean {
  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export function effectiveTheme(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

export function applyTheme(
  root: HTMLElement,
  mode: ThemeMode,
  prefersDark: boolean,
  themeColor?: HTMLMetaElement | null,
): 'light' | 'dark' {
  const theme = effectiveTheme(mode, prefersDark);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  if (themeColor) themeColor.content = theme === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  return theme;
}

export function readBrowserThemeMode(): ThemeMode {
  try {
    return readThemeMode(window.localStorage);
  } catch {
    return 'system';
  }
}

export function saveBrowserThemeMode(mode: ThemeMode): boolean {
  try {
    return writeThemeMode(window.localStorage, mode);
  } catch {
    return false;
  }
}

export function readBrowserPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeBrowserPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // These preferences are optional; the in-memory UI state remains usable.
  }
}

export function systemThemePreference(): MediaQueryList | null {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return null;
  }
}

export function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    return window.localStorage;
  } catch {
    return UNAVAILABLE_STORAGE;
  }
}
