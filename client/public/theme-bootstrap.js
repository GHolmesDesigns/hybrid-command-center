/* global window, document */
(() => {
  let mode = 'system';
  try {
    const saved = window.localStorage.getItem('hcc-theme-mode');
    if (saved === 'light' || saved === 'dark') mode = saved;
  } catch {
    // Storage can be unavailable; System is the safe default.
  }

  let prefersDark = false;
  try {
    prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    // A missing media-query API is treated as a light system preference.
  }

  const theme = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === 'dark' ? '#151a18' : '#f4f3ef';
})();
