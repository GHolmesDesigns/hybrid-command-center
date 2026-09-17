import { describe, expect, it } from 'vitest';
import {
  agentHubWakeFromTip,
  isAgentHubAssistantDeltaFrame,
  isAgentHubAssistantTurnStateFrame,
  isAgentHubWakeFrame,
  parseAgentHubClientFrame,
} from './agent-hub-live.ts';

describe('agent hub live frames', () => {
  it('parses allowed client frames', () => {
    expect(parseAgentHubClientFrame({ kind: 'ping' })).toEqual({ kind: 'ping' });
    expect(parseAgentHubClientFrame({ kind: 'subscribe', conversationId: 'thread-1' })).toEqual({
      kind: 'subscribe',
      conversationId: 'thread-1',
    });
    expect(parseAgentHubClientFrame({ kind: 'unsubscribe', conversationId: 'thread-1' })).toEqual({
      kind: 'unsubscribe',
      conversationId: 'thread-1',
    });
  });

  it('rejects unknown client frame kinds and malformed payloads', () => {
    expect(parseAgentHubClientFrame({ kind: 'wake' })).toBeNull();
    expect(parseAgentHubClientFrame({ kind: 'assistant_delta', turnId: 't' })).toBeNull();
    expect(parseAgentHubClientFrame({ kind: 'subscribe' })).toBeNull();
    expect(parseAgentHubClientFrame({ kind: 'subscribe', conversationId: '' })).toBeNull();
    expect(
      parseAgentHubClientFrame({ kind: 'subscribe', conversationId: 'x'.repeat(129) }),
    ).toBeNull();
    expect(parseAgentHubClientFrame(null)).toBeNull();
    expect(parseAgentHubClientFrame([])).toBeNull();
  });

  it('builds wake frames with monotonic seq and feeds only', () => {
    const frame = agentHubWakeFromTip(4, { feeds: ['coordination'], conversationId: 'c-1' });
    expect(frame).toEqual({
      kind: 'wake',
      seq: 4,
      feeds: ['coordination'],
      conversationId: 'c-1',
    });
    expect(agentHubWakeFromTip(1, { feeds: ['notifications'] })).toEqual({
      kind: 'wake',
      seq: 1,
      feeds: ['notifications'],
    });
    expect(isAgentHubWakeFrame(frame)).toBe(true);
    expect(isAgentHubWakeFrame({ kind: 'wake', seq: 1, feeds: ['notifications'], body: 'x' })).toBe(
      true,
    );
    expect(isAgentHubWakeFrame({ kind: 'pong' })).toBe(false);
    expect(isAgentHubWakeFrame({ kind: 'wake', seq: NaN, feeds: ['notifications'] })).toBe(false);
    expect(isAgentHubWakeFrame({ kind: 'wake', seq: 1, feeds: [] })).toBe(false);
    expect(
      isAgentHubWakeFrame({ kind: 'wake', seq: 1, feeds: ['notifications'], conversationId: 3 }),
    ).toBe(false);
    expect(isAgentHubWakeFrame(null)).toBe(false);
  });

  it('validates assistant streaming frames', () => {
    const delta = {
      kind: 'assistant_delta',
      turnId: 'turn-1',
      conversationId: 'conv-1',
      delta: 'Hello',
    };
    expect(isAgentHubAssistantDeltaFrame(delta)).toBe(true);
    expect(isAgentHubAssistantDeltaFrame({ ...delta, delta: 1 })).toBe(false);
    expect(isAgentHubAssistantDeltaFrame({ ...delta, conversationId: '' })).toBe(false);

    const state = {
      kind: 'assistant_turn_state',
      turnId: 'turn-1',
      conversationId: 'conv-1',
      state: 'started',
    };
    expect(isAgentHubAssistantTurnStateFrame(state)).toBe(true);
    expect(isAgentHubAssistantTurnStateFrame({ ...state, state: 42 })).toBe(false);
    expect(isAgentHubAssistantTurnStateFrame(null)).toBe(false);
  });
});
