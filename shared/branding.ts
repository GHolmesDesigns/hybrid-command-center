/** Default sidebar branding. Override at runtime via Settings, or edit these defaults in code. */
export const APP_VERSION = '2.3.2';

export interface Branding {
  mark: string;
  title: string;
  subtitle: string;
  tagline: string;
}

export const DEFAULT_BRANDING: Branding = {
  mark: 'HC',
  title: 'Hybrid',
  subtitle: 'Command Center',
  tagline: 'Private to this device',
};

export const BRANDING_SETTING_KEY = 'branding';
