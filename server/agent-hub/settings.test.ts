import { describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { setSetting } from '../drive/service.ts';
import { AGENT_HUB_LIVE_TIPS_SETTING_KEY } from '../../shared/agent-hub-sse.ts';
import { readAgentHubLiveTips, updateAgentHubLiveTips } from './settings.ts';

describe('agent hub live tips settings', () => {
  let db: Db;

  it('defaults off and round-trips enabled state', () => {
    db = createDb(':memory:');
    expect(readAgentHubLiveTips(db)).toEqual({ enabled: false });
    expect(updateAgentHubLiveTips(db, { enabled: true })).toEqual({ liveTips: { enabled: true } });
    expect(readAgentHubLiveTips(db)).toEqual({ enabled: true });
    db.close();
  });

  it('fails closed on invalid stored JSON', () => {
    db = createDb(':memory:');
    setSetting(db, AGENT_HUB_LIVE_TIPS_SETTING_KEY, '{not-json');
    expect(readAgentHubLiveTips(db)).toEqual({ enabled: false });
    setSetting(db, AGENT_HUB_LIVE_TIPS_SETTING_KEY, JSON.stringify({ enabled: 'yes' }));
    expect(readAgentHubLiveTips(db)).toEqual({ enabled: false });
    db.close();
  });
});
