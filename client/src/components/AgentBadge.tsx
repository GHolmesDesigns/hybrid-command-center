import { initials } from './formatting';
import { isAgentActivityStale, type PresenceState } from '../../../shared/agent-summaries';
import { AGENT_IDENTITY_PROVENANCE_LABEL } from '../../../shared/agent-coordination';
import type { AgentIdentityProvenance } from '../../../shared/agent-coordination';

export type AgentBadgeProfile = {
  label: string;
  displayName: string;
  trustLevel: string;
};

export type AgentBadgePresence = {
  state: PresenceState | string;
  lastActivityAt: string | null;
};

const PRESENCE_LABEL: Record<string, string> = {
  AVAILABLE: 'Available',
  BUSY: 'Busy',
  AWAY: 'Away',
  OFFLINE: 'Offline',
};

export function AgentBadge({
  profile,
  presence,
  provenance,
  operator = false,
  compact = false,
}: {
  profile?: AgentBadgeProfile | null;
  presence?: AgentBadgePresence | null;
  provenance?: AgentIdentityProvenance;
  operator?: boolean;
  compact?: boolean;
}) {
  if (operator) {
    return (
      <div className={`agent-badge ${compact ? 'compact' : ''}`}>
        <span className="agent-badge-mark operator" aria-hidden="true">
          OP
        </span>
        <div className="agent-badge-copy">
          <strong>You</strong>
          {!compact && <span className="agent-badge-meta">Operator</span>}
        </div>
      </div>
    );
  }

  const label = profile?.label ?? 'unknown';
  const displayName = profile?.displayName ?? label;
  const stale = presence ? isAgentActivityStale(presence.lastActivityAt ?? null) : true;
  const state = stale || !presence ? 'unknown' : presence.state;
  const stateLabel =
    state === 'unknown' ? 'Presence unknown' : (PRESENCE_LABEL[String(state)] ?? String(state));
  const trustLabel =
    profile?.trustLevel === 'VERIFIED' ? 'Verified agent' : 'Unverified agent';
  const provenanceLabel = provenance ? AGENT_IDENTITY_PROVENANCE_LABEL[provenance] : null;

  return (
    <div className={`agent-badge ${compact ? 'compact' : ''}`}>
      <span
        className={`agent-badge-mark presence-${String(state).toLowerCase()}`}
        aria-hidden="true"
        title={stateLabel}
      >
        {initials(displayName)}
      </span>
      <div className="agent-badge-copy">
        <strong>{displayName}</strong>
        {!compact && (
          <span className="agent-badge-meta">
            @{label} · {stateLabel} · {trustLabel}
            {provenanceLabel ? ` · ${provenanceLabel}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}
