import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  api: vi.fn(),
}));

import { api } from './api';
import { loadAgentPresenceByLabel } from './loadAgentPresence';

describe('loadAgentPresenceByLabel', () => {
  it('maps presence rows by lowercase agent label', async () => {
    vi.mocked(api).mockResolvedValue({
      presence: [
        { agentLabel: 'Reviewer', state: 'BUSY', lastActivityAt: '2026-09-18T12:00:00.000Z' },
      ],
    });

    const map = await loadAgentPresenceByLabel();
    expect(map.reviewer).toEqual({
      state: 'BUSY',
      lastActivityAt: '2026-09-18T12:00:00.000Z',
    });
  });
});
