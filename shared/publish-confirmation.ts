/** Publish confirmation requests are domain-specific approval records, not a general gate. */
export const PUBLISH_CONFIRMATION_STATUSES = [
  'PENDING',
  'EXECUTING',
  'APPROVED',
  'DENIED',
  'FAILED',
  'EXPIRED',
  'PROVIDER_UNCERTAIN',
] as const;
export type PublishConfirmationStatus = (typeof PUBLISH_CONFIRMATION_STATUSES)[number];

export const PUBLISH_CONFIRMATION_TIMINGS = ['scheduled', 'now'] as const;
export type PublishConfirmationTiming = (typeof PUBLISH_CONFIRMATION_TIMINGS)[number];

export const PUBLISH_CONFIRMATION_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
export const PUBLISH_CONFIRMATION_PENDING_LIMIT = 20;
