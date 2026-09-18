import { isAgentActivityStale } from '../../../shared/agent-summaries';
import { AgentBadge, type AgentBadgePresence, type AgentBadgeProfile } from './AgentBadge';

export function ThreadParticipantPresence({
  participants,
  agentProfiles,
  presenceByLabel,
}: {
  participants: string[];
  agentProfiles: Record<string, AgentBadgeProfile>;
  presenceByLabel: Record<string, AgentBadgePresence>;
}) {
  const agents = participants.filter((label) => label !== 'operator');
  if (agents.length === 0) return null;

  return (
    <ul className="thread-participant-presence" aria-label="Thread participants">
      {agents.map((label) => {
        const profileKey = label.toLowerCase();
        const profile = agentProfiles[profileKey] ?? {
          label,
          displayName: label,
          trustLevel: 'UNVERIFIED',
        };
        const presence = presenceByLabel[profileKey] ?? null;
        const online =
          presence &&
          !isAgentActivityStale(presence.lastActivityAt ?? null) &&
          presence.state !== 'OFFLINE';
        return (
          <li key={label} className={online ? 'online' : 'offline'}>
            <AgentBadge compact profile={profile} presence={presence} />
            <span className="thread-participant-state">{online ? 'Online' : 'Offline'}</span>
          </li>
        );
      })}
    </ul>
  );
}
