import { BUFFER_PROVIDER } from './buffer.ts';

/** Whether the provider receives an explicit instant or posts immediately. */
export const PUBLISH_TIMINGS = ['scheduled', 'now'] as const;
export type PublishTiming = (typeof PUBLISH_TIMINGS)[number];

export const PUBLISH_TIMING_LABEL: Record<PublishTiming, string> = {
  scheduled: 'Scheduled',
  now: 'Publish now',
};

/**
 * Post Bridge documents `scheduled_at: null` as immediate on create (`docs/post-bridge-api-surface.md`
 * §12), but no owner-run §14 row verifies the exact immediate-create shape yet. Production stays
 * closed until that evidence is recorded and this flag is flipped in the same change.
 */
export const POST_BRIDGE_PUBLISH_NOW_EVIDENCE = {
  enabled: false,
  reason:
    'Publish now is not enabled for Post Bridge: the owner-run immediate-create probe has not recorded a verified §14 result for this provider.',
} as const;

/**
 * Buffer's immediate-publish contract is not wired or verified. C87 pins `customScheduled` only;
 * enabling Publish now for Buffer requires a dated probe result and a write-mode change together.
 */
export const BUFFER_PUBLISH_NOW_EVIDENCE = {
  enabled: false,
  reason:
    'Publish now is not enabled for Buffer: the exact immediate-create GraphQL shape has not been verified for the connected channels.',
} as const;

/** Test and E2E API runs set `PUBLISH_NOW_EVIDENCE=1`. The web client also checks `VITE_PUBLISH_NOW_EVIDENCE`. */
export const publishNowEvidenceEnabled = (): boolean =>
  typeof process !== 'undefined' && process.env?.PUBLISH_NOW_EVIDENCE === '1';

/** Whether immediate publishing is production-enabled for one provider id. */
export const publishNowEnabledForProvider = (provider: string): boolean => {
  if (publishNowEvidenceEnabled()) return true;
  if (provider === 'post-bridge') return POST_BRIDGE_PUBLISH_NOW_EVIDENCE.enabled;
  if (provider === BUFFER_PROVIDER) return BUFFER_PUBLISH_NOW_EVIDENCE.enabled;
  return false;
};

/** The refusal when a provider's immediate-create contract is not verified, if any. */
export const publishNowRefusalForProvider = (provider: string): string | undefined => {
  if (publishNowEnabledForProvider(provider)) return undefined;
  if (provider === 'post-bridge') return POST_BRIDGE_PUBLISH_NOW_EVIDENCE.reason;
  if (provider === BUFFER_PROVIDER) return BUFFER_PUBLISH_NOW_EVIDENCE.reason;
  return `Publish now is not enabled for ${provider}.`;
};

/** Plan-level refusals for an immediate send over the resolved targets. */
export const publishNowPlanRefusals = (targets: readonly { provider?: string }[]): string[] => {
  const refusals: string[] = [];
  const providers = new Set(targets.map((target) => target.provider ?? 'post-bridge'));
  if (providers.size > 1)
    refusals.push(
      'Publish now cannot mix providers in one send. Choose accounts from one provider, or publish in separate steps.',
    );
  for (const provider of providers) {
    const refusal = publishNowRefusalForProvider(provider);
    if (refusal) refusals.push(refusal);
  }
  return refusals;
};

/** Warnings shown on every immediate preview before confirmation. */
export const PUBLISH_NOW_WARNINGS = [
  'Publishing now is irreversible — the provider posts immediately and there is no scheduled instant.',
  'Confirm only when you mean to send now, not at the planned date and time.',
] as const;
