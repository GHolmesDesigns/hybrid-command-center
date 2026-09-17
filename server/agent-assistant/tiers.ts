import type { AssistantPendingApproval } from '../../shared/command-ai-assistant.ts';

export const blockingConfirmTools = new Set([
  'workspace_delete_task',
  'workspace_delete_project',
  'workspace_merge_clients_commit',
  'workspace_create_project',
]);

export const inlineApproveTools = new Set([
  'workspace_create_task',
  'workspace_update_task',
  'workspace_update_project',
  'workspace_add_checklist_item',
  'workspace_update_checklist_item',
  'workspace_remove_checklist_item',
  'workspace_add_dependency',
  'workspace_remove_dependency',
]);

export type ApprovalTier = 'blocking' | 'inline' | 'untiered';

export function approvalTierFor(toolName: string): ApprovalTier {
  if (blockingConfirmTools.has(toolName)) return 'blocking';
  if (inlineApproveTools.has(toolName)) return 'inline';
  return 'untiered';
}

export function isWriteTool(handler: string | undefined): boolean {
  return handler === 'workspace_write' || handler === 'integration_write';
}

export type PendingApprovalTier = AssistantPendingApproval['tier'];
