import type { AgentBadgeProfile } from './AgentBadge';

function typingLabel(labels: string[], agentProfiles: Record<string, AgentBadgeProfile>): string {
  const names = labels.map((label) => agentProfiles[label]?.displayName ?? label);
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)} are typing…`;
}

export function ThreadTypingIndicator({
  typingLabels,
  agentProfiles,
}: {
  typingLabels: string[];
  agentProfiles: Record<string, AgentBadgeProfile>;
}) {
  if (typingLabels.length === 0) return null;
  return (
    <p className="thread-typing-indicator" role="status" aria-live="polite">
      {typingLabel(typingLabels, agentProfiles)}
    </p>
  );
}
