/**
 * MCP agent audit vocabulary (MCP-C106 contract; first used by C111 coordination tools).
 *
 * Append-only rows for local MCP mutation tool calls. Retention and the sole INSERT live in
 * `server/mcp/events.ts`. Coordination writes also share the rolling rate-limit constant here so
 * the MCP layer and tests cannot diverge from `docs/agent-coordination-plan.md` §5.6.
 */
import { z } from 'zod';
import { agentLabelSchema } from './agent-coordination.ts';

export const MCP_AGENT_EVENT_OUTCOMES = ['SUCCESS', 'REFUSED', 'FAILURE'] as const;
export type McpAgentEventOutcome = (typeof MCP_AGENT_EVENT_OUTCOMES)[number];

/** Newest rows kept; same append-only discipline as `integration_events`, higher bound per C105. */
export const MCP_AGENT_EVENT_LIMIT = 500;

/** Coordination post/claim/complete/cancel/note combined, per MCP session. */
export const COORDINATION_WRITE_LIMIT_PER_MINUTE = 10;

export const COORDINATION_WRITE_TOOLS = [
  'coordination_post_handoff',
  'coordination_claim_handoff',
  'coordination_complete_handoff',
  'coordination_cancel_handoff',
  'coordination_add_note',
  'work_start',
  'work_heartbeat',
  'work_checkpoint',
  'work_request_input',
  'work_mark_blocked',
  'work_release',
  'work_complete',
] as const;
export type CoordinationWriteTool = (typeof COORDINATION_WRITE_TOOLS)[number];

/** Class-L workspace/Signal/settings writes (C130). Share the coordination write budget. */
export const WORKSPACE_WRITE_TOOLS = [
  'workspace_create_task',
  'workspace_update_task',
  'workspace_add_checklist_item',
  'workspace_update_checklist_item',
  'workspace_remove_checklist_item',
  'workspace_add_dependency',
  'workspace_remove_dependency',
  'workspace_create_project',
  'workspace_update_project',
  'workspace_delete_task',
  'workspace_delete_project',
  'signal_create_post',
  'signal_update_post',
  'signal_set_slot',
  'signal_update_variants',
  'signal_update_publish_targets',
  'signal_assign_posts',
  'signal_duplicate_post',
  'signal_ack_alert',
  'settings_update_branding',
  'settings_update_view_defaults',
] as const;
export type WorkspaceWriteTool = (typeof WORKSPACE_WRITE_TOOLS)[number];

export const COORDINATION_READ_TOOLS = [
  'coordination_list_handoffs',
  'coordination_get_handoff',
  'work_get_resume_context',
] as const;
export type CoordinationReadTool = (typeof COORDINATION_READ_TOOLS)[number];

export const COORDINATION_TOOLS = [
  ...COORDINATION_READ_TOOLS,
  ...COORDINATION_WRITE_TOOLS,
] as const;
export type CoordinationTool = (typeof COORDINATION_TOOLS)[number];

/**
 * Integration-write tools (C131 / MCP-C108) — inventory, analytics, buffer, Drive sync, Signal
 * import commit, and Drive media resolve/recheck. Separate rolling budget from coordination.
 */
export const INTEGRATION_WRITE_LIMIT_PER_MINUTE = 6;

export const INTEGRATION_WRITE_TOOLS = [
  'import_signal_commit',
  'signal_resolve_drive_media',
  'signal_resolve_drive_media_batch',
  'signal_recheck_post_media',
  'signal_recheck_variant_media',
  'drive_sync',
  'signal_refresh_provider_inventory',
  'signal_refresh_analytics_window',
  'signal_refresh_buffer_accounts',
] as const;
export type IntegrationWriteTool = (typeof INTEGRATION_WRITE_TOOLS)[number];

/** Class-L preview commits that share the coordination write budget (C131). */
export const INTEGRATION_LOCAL_WRITE_TOOLS = [
  'workspace_merge_clients_commit',
  'import_playbook_commit',
] as const;
export type IntegrationLocalWriteTool = (typeof INTEGRATION_LOCAL_WRITE_TOOLS)[number];

export const INTEGRATION_READ_TOOLS = [
  'workspace_merge_clients_preview',
  'import_playbook_preview',
  'import_signal_preview',
  'files_browse_project',
  'integration_list_activity',
] as const;
export type IntegrationReadTool = (typeof INTEGRATION_READ_TOOLS)[number];

/** Agent Drive writes are requests only; an operator must approve every request. */
export const DRIVE_WRITE_REQUEST_TOOLS = ['drive_request_write'] as const;
export type DriveWriteRequestTool = (typeof DRIVE_WRITE_REQUEST_TOOLS)[number];

export const COORDINATION_INBOX_URI = 'hcc://coordination/inbox?state=open';

export const mcpAgentEventOutcomeSchema = z.enum(MCP_AGENT_EVENT_OUTCOMES);

export interface McpAgentEvent {
  id: string;
  at: string;
  agentLabel: string | null;
  tool: string;
  outcome: McpAgentEventOutcome;
  entityType: string | null;
  entityId: string | null;
  summary: string;
}

/** Optional agent label from MCP init / env — empty becomes null (reads still work). */
export function normalizeOptionalAgentLabel(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return agentLabelSchema.parse(trimmed);
}
