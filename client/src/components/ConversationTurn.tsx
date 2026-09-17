import { useState } from 'react';
import { Lightbulb, Sparkles } from 'lucide-react';
import { ASSISTANT_AGENT_LABEL } from '../../../shared/mcp-agent-registry';
import type {
  ConversationSenderKind,
  MessageLinkedHandoff,
} from '../../../shared/agent-conversations';
import type { AgentIdentityProvenance } from '../../../shared/agent-coordination';
import { AgentBadge, type AgentBadgePresence, type AgentBadgeProfile } from './AgentBadge';
import { MessageLinkedHandoffs } from './MentionHandoffCompose';
import { formatDateTime } from './formatting';

export type ConversationTurnMessage = {
  id: string;
  senderLabel: string;
  senderKind?: ConversationSenderKind;
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
  const assistant =
    message.senderKind === 'assistant' ||
    message.senderLabel.toLowerCase() === ASSISTANT_AGENT_LABEL;
  const profileKey = message.senderLabel.toLowerCase();
  const profile = operator || assistant ? null : (agentProfiles[profileKey] ?? null);
  const presence = operator || assistant ? null : (presenceByLabel[profileKey] ?? null);
  const thought = message.thoughtSummary?.trim() || fallbackThought?.trim() || null;
  const [thoughtOpen, setThoughtOpen] = useState(false);

  return (
    <article
      className={`conversation-turn ${operator ? 'operator-turn' : assistant ? 'assistant-turn' : 'agent-turn'}`}
      aria-label={`Message from ${operator ? 'you' : assistant ? 'Command AI' : message.senderLabel}`}
    >
      {assistant ? (
        <div className="agent-badge assistant-badge">
          <span className="agent-badge-mark assistant" aria-hidden="true">
            <Sparkles />
          </span>
          <div className="agent-badge-copy">
            <strong>Command AI</strong>
            <span className="agent-badge-meta">In-app assistant · VERIFIED</span>
          </div>
        </div>
      ) : (
        <AgentBadge
          operator={operator}
          profile={
            profile ?? {
              label: message.senderLabel,
              displayName: message.senderLabel,
              trustLevel: 'UNVERIFIED',
            }
          }
          presence={presence}
          provenance={message.provenance}
        />
      )}
      {thought && !operator && !assistant && (
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
        {message.provenance && !operator && !assistant && (
          <span className={`provenance ${message.provenance.toLowerCase()}`}>
            {message.provenance}
          </span>
        )}
        <time dateTime={message.sentAt}>{formatDateTime(message.sentAt)}</time>
      </div>
      <MessageLinkedHandoffs handoffs={message.linkedHandoffs ?? []} />
    </article>
  );
}
