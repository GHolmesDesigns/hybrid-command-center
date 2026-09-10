import type { Db } from './db.ts';
import { isStaleOpenHandoff } from '../shared/agent-coordination.ts';
import { liveWaitingWorkSessions } from './agent-coordination/work-sessions.ts';
import type { WaitingInboxItem, WaitingInboxResponse } from '../shared/agent-waiting.ts';

export function buildWaitingInbox(db: Db, now = new Date()): WaitingInboxResponse {
  const items: WaitingInboxItem[] = [];
  const warnings: string[] = [];
  try {
    for (const session of liveWaitingWorkSessions(db, {}, now))
      items.push({
        id: session.id,
        kind: 'WORK_SESSION',
        agent: session.agentLabel,
        waitingSince: session.waitingSince ?? session.updatedAt,
        destination: 'Live work session',
        resolutionPath: '/agents#agent-work-sessions',
        detail: session.currentStep ?? session.state,
      });
  } catch {
    warnings.push('Live work sessions are unavailable.');
  }
  try {
    const rows = db
      .prepare("SELECT * FROM agent_handoffs WHERE state='OPEN' ORDER BY created_at ASC, id ASC")
      .all() as any[];
    for (const row of rows)
      if (isStaleOpenHandoff({ ...row, createdAt: row.created_at, state: row.state } as any, now))
        items.push({
          id: row.id,
          kind: 'HANDOFF',
          agent: row.from_agent_label,
          waitingSince: row.created_at,
          destination: 'Stale handoff',
          resolutionPath: '/agents#agent-handoffs',
          detail: row.message,
        });
  } catch {
    warnings.push('Agent handoffs are unavailable.');
  }
  try {
    const rows = db
      .prepare(
        "SELECT id,agent_label,created_at,confirmation FROM drive_write_requests WHERE status='PENDING' ORDER BY created_at ASC, id ASC",
      )
      .all() as any[];
    for (const row of rows)
      items.push({
        id: row.id,
        kind: 'DRIVE_WRITE',
        agent: row.agent_label,
        waitingSince: row.created_at,
        destination: 'Drive write approval',
        resolutionPath: '/agents#drive-write-requests',
        detail: row.confirmation,
      });
  } catch {
    warnings.push('Drive write requests are unavailable.');
  }
  items.sort(
    (a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || a.id.localeCompare(b.id),
  );
  return { items, warnings };
}
