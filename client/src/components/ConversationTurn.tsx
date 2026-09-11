import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import type { MessageLinkedHandoff } from '../../../shared/agent-conversations';
import type { AgentIdentityProvenance } from '../../../shared/agent-coordination';
import { AgentBadge, type AgentBadgePresence, type AgentBadgeProfile } from './AgentBadge';
import { MessageLinkedHandoffs } from './MentionHandoffCompose';
import { formatDateTime } from './formatting';

export type ConversationTurnMessage = {
  id: string;
  senderLabel: string;
  sentAt: string;
  body: string;
  thoughtSummary?: string | null;
  provenance?: AgentIdentityProvenance;
  linkedHandoffs?: MessageLinkedHandoff[];
};

export function ConversationTurn({
  message,
  agentProfiles,
  presenceByLabel,
  fallbackThought,
}: {
  message: ConversationTurnMessage;
  agentProfiles: Record<string, AgentBadgeProfile>;
  presenceByLabel: Record<string, AgentBadgePresence>;
  /** Activity summary shown when the message has no stored thought summary. */
  fallbackThought?: string | null;
}) {
  const operator = message.senderLabel === 'operator';
  const profileKey = message.senderLabel.toLowerCase();
  const profile = operator ? null : (agentProfiles[profileKey] ?? null);
  const presence = operator ? null : (presenceByLabel[profileKey] ?? null);
  const thought = message.thoughtSummary?.trim() || fallbackThought?.trim() || null;
  const [thoughtOpen, setThoughtOpen] = useState(false);

  return (
    <article
      className={`conversation-turn ${operator ? 'operator-turn' : 'agent-turn'}`}
      aria-label={`Message from ${operator ? 'you' : message.senderLabel}`}
    >
      <AgentBadge
        operator={operator}
        profile={profile ?? { label: message.senderLabel, displayName: message.senderLabel, trustLevel: 'UNVERIFIED' }}
        presence={presence}
        provenance={message.provenance}
      />
      {thought && !operator && (
        <div className="conversation-thought">
          <button
            type="button"
            className="conversation-thought-toggle"
            aria-expanded={thoughtOpen}
            onClick={() => setThoughtOpen((open) => !open)}
          >
            <Lightbulb aria-hidden="true" />
            Thought
          </button>
          {thoughtOpen && <p className="conversation-thought-body">{thought}</p>}
        </div>
      )}
      <div className="conversation-turn-body">
        <p>{message.body}</p>
        {message.provenance && !operator && (
          <span className={`provenance ${message.provenance.toLowerCase()}`}>{message.provenance}</span>
        )}
        <time dateTime={message.sentAt}>{formatDateTime(message.sentAt)}</time>
      </div>
      <MessageLinkedHandoffs handoffs={message.linkedHandoffs ?? []} />
    </article>
  );
}
