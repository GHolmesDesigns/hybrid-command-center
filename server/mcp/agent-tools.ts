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
    default:
      throw new Error(`Unknown agent tool: ${tool}.`);
  }
}
