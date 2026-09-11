import { Handshake } from 'lucide-react';

export function MentionHandoffPreview({
  offered,
  confirmed,
  onToggle,
}: {
  offered: string[];
  confirmed: string[];
  onToggle: (label: string) => void;
}) {
  if (offered.length === 0) return null;
  return (
    <fieldset className="mention-handoff-preview">
      <legend>
        <Handshake aria-hidden="true" /> Confirm handoffs
      </legend>
      <p className="field-hint">Each confirmed @mention opens a handoff to that agent.</p>
      <ul>
        {offered.map((label) => (
          <li key={label}>
            <label>
              <input
                type="checkbox"
                checked={confirmed.includes(label)}
                onChange={() => onToggle(label)}
                aria-label={`Open handoff to @${label}`}
              />
              Open handoff to @{label}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function MessageLinkedHandoffs({
  handoffs,
}: {
  handoffs: Array<{ id: string; toAgentLabel: string; state: string }>;
}) {
  if (handoffs.length === 0) return null;
  return (
    <ul className="message-linked-handoffs">
      {handoffs.map((handoff) => (
        <li key={handoff.id}>
          <Handshake aria-hidden="true" />
          <span>
            Handoff to @{handoff.toAgentLabel} · {handoff.state}
          </span>
        </li>
      ))}
    </ul>
  );
}
