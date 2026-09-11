import type { Task } from '../../../shared/types';
import { AgentHandoffsCard } from './AgentHandoffsCard';
import { McpConnectionSetupCard } from './McpConnectionSetupCard';
import { McpHealthPanelCard } from './McpHealthPanelCard';
import { DriveWriteRequestsCard } from './DriveWriteRequestsCard';
import { PublishConfirmationRequestsCard } from './PublishConfirmationRequestsCard';
import { PageHead } from './Shell';
import { AgentDirectoryCard } from './AgentDirectoryCard';
import { Link } from 'react-router-dom';
import { AgentMemoryReviewCard } from './AgentMemoryReviewCard';
import { AgentNotificationsCard } from './AgentNotificationsCard';
import { WaitingInboxCard } from './WaitingInboxCard';
import { AgentSchedulesCard } from './AgentSchedulesCard';

/**
 * Agents module (C136 / #420): connection setup, health, and handoffs in one place.
 *
 * These cards used to live under Settings. The guided credential flow is HTTPS-only and written
 * for a non-technical operator — no PowerShell and no hand-edited config files.
 */
export function AgentsView({
  tasks,
  flash,
}: {
  tasks: Task[];
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  return (
    <div className="page">
      <PageHead
        eyebrow="Agents"
        title="Agents"
        body="Connect Cursor, Claude, or Codex to this Command Center over hosted HTTPS, confirm the connection, and review agent handoffs. Issue and rotate credentials here — you should not need a terminal or a text editor."
      />
      <p>
        <Link className="primary-btn" to="/agents/conversations">
          Open Conversations
        </Link>
      </p>
      <div className="agents-layout">
        <McpConnectionSetupCard flash={flash} />
        <AgentDirectoryCard />
        <McpHealthPanelCard flash={flash} />
        <DriveWriteRequestsCard flash={flash} />
        <PublishConfirmationRequestsCard flash={flash} />
        <AgentMemoryReviewCard flash={flash} />
        <AgentHandoffsCard tasks={tasks} flash={flash} />
        <AgentNotificationsCard flash={flash} />
        <WaitingInboxCard />
        <AgentSchedulesCard flash={flash} />
      </div>
    </div>
  );
}
