import { describe, expect, it } from 'vitest';
import { approvalTierFor, blockingConfirmTools, inlineApproveTools, isWriteTool } from './tiers.ts';

describe('assistant approval tiers', () => {
  it('assigns blocking confirm tools from policy', () => {
    for (const tool of [
      'workspace_delete_task',
      'workspace_delete_project',
      'workspace_merge_clients_commit',
      'workspace_create_project',
    ]) {
      expect(blockingConfirmTools.has(tool)).toBe(true);
      expect(approvalTierFor(tool)).toBe('blocking');
    }
  });

  it('assigns inline approve tools from policy', () => {
    for (const tool of [
      'workspace_create_task',
      'workspace_update_task',
      'workspace_add_checklist_item',
    ]) {
      expect(inlineApproveTools.has(tool)).toBe(true);
      expect(approvalTierFor(tool)).toBe('inline');
    }
  });

  it('fails closed on untiered writes', () => {
    expect(approvalTierFor('signal_create_post')).toBe('untiered');
  });

  it('covers every inline tool in the tier map', () => {
    for (const tool of inlineApproveTools) {
      expect(approvalTierFor(tool)).toBe('inline');
    }
  });

  it('recognizes MCP write handlers', () => {
    expect(isWriteTool('workspace_write')).toBe(true);
    expect(isWriteTool('integration_write')).toBe(true);
    expect(isWriteTool('workspace_read')).toBe(false);
  });
});
