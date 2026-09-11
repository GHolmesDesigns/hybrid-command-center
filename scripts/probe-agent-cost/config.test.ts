import { describe, expect, it } from 'vitest';
import { parseProbeArgs, renderPlan } from './config.ts';

describe('probe-agent-cost config', () => {
  it('plans by default and refuses live mode without safeguards', () => {
    const planned = parseProbeArgs(['--probe-label', 'hcc-cost-probe'], {});
    expect(planned.config?.mode).toBe('plan');
    const refused = parseProbeArgs(['--live', '--probe-label', 'hcc-cost-probe'], {});
    expect(refused.config).toBeUndefined();
    expect(refused.refusals.join(' ')).toMatch(/--yes/);
  });

  it('accepts live mode when the owner supplies key, yes, and label', () => {
    const outcome = parseProbeArgs(['--live', '--yes', '--probe-label', 'hcc-cost-probe'], {
      CURSOR_ADMIN_API_KEY: 'secret',
    });
    expect(outcome.config?.mode).toBe('live');
    expect(renderPlan(outcome.config!, outcome.notices)).toMatch(/GET \/teams\/v1\/usage/);
  });
});
