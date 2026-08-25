import { afterEach, describe, expect, it } from 'vitest';
import {
  BUFFER_PUBLISH_NOW_EVIDENCE,
  POST_BRIDGE_PUBLISH_NOW_EVIDENCE,
  publishNowEnabledForProvider,
  publishNowEvidenceEnabled,
  publishNowPlanRefusals,
  publishNowRefusalForProvider,
} from './publish-now.ts';

describe('publish now evidence', () => {
  const previous = process.env.PUBLISH_NOW_EVIDENCE;

  afterEach(() => {
    if (previous === undefined) delete process.env.PUBLISH_NOW_EVIDENCE;
    else process.env.PUBLISH_NOW_EVIDENCE = previous;
  });

  it('stays closed in production until evidence is recorded', () => {
    delete process.env.PUBLISH_NOW_EVIDENCE;
    expect(POST_BRIDGE_PUBLISH_NOW_EVIDENCE.enabled).toBe(false);
    expect(BUFFER_PUBLISH_NOW_EVIDENCE.enabled).toBe(false);
    expect(publishNowEvidenceEnabled()).toBe(false);
    expect(publishNowRefusalForProvider('post-bridge')).toBe(
      POST_BRIDGE_PUBLISH_NOW_EVIDENCE.reason,
    );
    expect(publishNowRefusalForProvider('buffer')).toBe(BUFFER_PUBLISH_NOW_EVIDENCE.reason);
    expect(publishNowEnabledForProvider('buffer')).toBe(false);
    expect(publishNowEnabledForProvider('unknown')).toBe(false);
  });

  it('opens when the test override is set', () => {
    process.env.PUBLISH_NOW_EVIDENCE = '1';
    expect(publishNowEvidenceEnabled()).toBe(true);
    expect(publishNowEnabledForProvider('post-bridge')).toBe(true);
    expect(publishNowRefusalForProvider('post-bridge')).toBeUndefined();
  });

  it('refuses mixed providers and unknown providers', () => {
    delete process.env.PUBLISH_NOW_EVIDENCE;
    expect(
      publishNowPlanRefusals([{ provider: 'post-bridge' }, { provider: 'buffer' }]).some(
        (refusal) => refusal.includes('cannot mix providers'),
      ),
    ).toBe(true);
    expect(publishNowRefusalForProvider('other')).toContain('other');
  });
});
