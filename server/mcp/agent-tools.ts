import type { Db } from '../db.ts';
import { buildAppHealth } from '../app-health.ts';
import {
  getPresence,
  listNotifications,
  listPresence,
  listSummaries,
  markNotificationRead,
  notify,
  setPresence,
} from '../agent-summaries.ts';
import { notificationListSchema, summaryListSchema } from '../../shared/agent-summaries.ts';
import type { McpSession } from './session.ts';
import type { McpToolCallResult } from './coordination.ts';
import { redactToolResult } from './redact.ts';
import {
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  postMessage,
  setConversationState,
} from '../agent-conversations.ts';
import {
  conversationListSchema,
  createConversationSchema,
  messageListSchema,
} from '../../shared/agent-conversations.ts';
import {
  approveMemory,
  archiveMemory,
  correctMemory,
  deleteMemory,
  getMemory,
  listMemory,
  suggestMemory,
} from '../agent-memory.ts';
import { agentMemoryListSchema } from '../../shared/agent-memory.ts';

const success = (data: unknown): McpToolCallResult => ({
  outcome: 'SUCCESS',
  data: redactToolResult(data),
});

export function callAgentTool(
  db: Db,
  session: McpSession,
  tool: string,
  rawArgs: unknown,
  options: { authRequired: boolean; now: Date },
): McpToolCallResult {
  if (!session.agentLabel && (tool === 'agent_get_presence' || tool === 'agent_set_presence')) {
    return { outcome: 'REFUSED', error: 'This tool requires an authenticated agent label.' };
  }
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  switch (tool) {
    case 'conversation_list':
      return success(
        listConversations(db, session.agentLabel ?? null, conversationListSchema.parse(args)),
      );
    case 'conversation_create':
      if (!session.agentLabel)
        return { outcome: 'REFUSED', error: 'This tool requires an authenticated agent label.' };
      return success(
        createConversation(
          db,
          createConversationSchema.parse(args),
          session.agentLabel,
          options.now,
        ),
      );
    case 'conversation_get':
      return success(getConversation(db, (args as { id: string }).id, session.agentLabel ?? null));
    case 'conversation_list_messages':
      return success(
        listMessages(
          db,
          (args as { id: string }).id,
          session.agentLabel ?? null,
          messageListSchema.parse({
            limit: (args as { limit?: number }).limit,
            cursor: (args as { cursor?: string }).cursor,
            direction: (args as { direction?: 'forward' | 'before' }).direction,
          }),
        ),
      );
    case 'conversation_post_message':
      if (!session.agentLabel)
        return { outcome: 'REFUSED', error: 'This tool requires an authenticated agent label.' };
      return success(
        postMessage(
          db,
          (args as { id: string }).id,
          session.agentLabel,
          {
            body: (args as { body: string }).body,
            confirmHandoffs: (args as { confirmHandoffs?: string[] }).confirmHandoffs,
            clientRequestId: (args as { clientRequestId?: string }).clientRequestId,
          },
          options.now,
        ),
      );
    case 'conversation_archive':
      if (!session.agentLabel)
        return { outcome: 'REFUSED', error: 'This tool requires an authenticated agent label.' };
      return success(
        setConversationState(
          db,
          (args as { id: string }).id,
          session.agentLabel,
          'ARCHIVED',
          options.now,
        ),
      );
    case 'agent_health_dashboard':
      return success(buildAppHealth(db, { authRequired: options.authRequired, now: options.now }));
    case 'agent_get_presence':
      return success(getPresence(db, session.agentLabel!));
    case 'agent_set_presence':
      return success(setPresence(db, session.agentLabel!, args, options.now));
    case 'agent_list_presence':
      return success(listPresence(db, args));
    case 'agent_list_summaries':
      return success(listSummaries(db, summaryListSchema.parse(args), options.now));
    case 'agent_list_notifications':
      return success(listNotifications(db, notificationListSchema.parse(args)));
    case 'agent_create_notification':
      return success(
        notify(
          db,
          args as {
            incidentKey: string;
            kind: string;
            agentLabel: string;
            title: string;
            body: string;
          },
          options.now,
        ),
      );
    case 'agent_mark_notification_read':
      return success(markNotificationRead(db, (args as { id: string }).id, options.now));
    case 'memory_suggest':
      if (!session.agentLabel)
        return { outcome: 'REFUSED', error: 'This tool requires an authenticated agent label.' };
      return success(suggestMemory(db, args, session.agentLabel, options.now));
    case 'memory_list':
      return success(listMemory(db, agentMemoryListSchema.parse(args)));
    case 'memory_get':
      return success(getMemory(db, (args as { id: string }).id));
    case 'memory_approve':
      return success(
        approveMemory(
          db,
          (args as { id: string }).id,
          session.agentLabel ?? 'operator',
          options.now,
        ),
      );
    case 'memory_correct': {
      const { id, ...patch } = args as { id: string; [key: string]: unknown };
      return success(correctMemory(db, id, patch, session.agentLabel ?? 'operator', options.now));
    }
    case 'memory_archive':
      return success(archiveMemory(db, (args as { id: string }).id, options.now));
    case 'memory_delete':
      deleteMemory(db, (args as { id: string }).id);
      return success({ ok: true });
    default:
      throw new Error(`Unknown agent tool: ${tool}.`);
  }
}
