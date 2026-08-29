import { afterEach, describe, expect, it } from 'vitest';
import {
  notifyMcpResourceUpdated,
  onMcpResourceUpdated,
  resetMcpResourceNotifierForTests,
  setMcpResourceUpdateBridge,
} from './resource-notifier.ts';

describe('resource-notifier', () => {
  afterEach(() => {
    resetMcpResourceNotifierForTests();
  });

  it('fans out to the bridge and listeners, ignoring empty URIs and broken handlers', () => {
    const tips: string[] = [];
    setMcpResourceUpdateBridge((uri) => {
      tips.push(`bridge:${uri}`);
      throw new Error('bridge boom');
    });
    const stop = onMcpResourceUpdated((uri) => {
      tips.push(`listen:${uri}`);
      throw new Error('listener boom');
    });
    notifyMcpResourceUpdated('  ');
    notifyMcpResourceUpdated('hcc://coordination/inbox?state=open');
    stop();
    expect(tips).toEqual([
      'bridge:hcc://coordination/inbox?state=open',
      'listen:hcc://coordination/inbox?state=open',
    ]);
  });
});
