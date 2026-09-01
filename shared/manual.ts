export const MANUAL_FILENAME = 'hybrid-command-center-manual.html';
export const MANUAL_ROUTE = '/api/manual';

/** Builds the only in-app manual URL, keeping its version visible and testable. */
export const manualUrlForVersion = (version: string): string =>
  `${MANUAL_ROUTE}/${encodeURIComponent(version)}`;
