import type { CSSProperties } from 'react';
import { resolveClientBranding } from '../../../shared/branding';
import type { SignalPost } from '../../../shared/signal';

const clientInitials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

/** A client cue is named and initialled; its palette is supportive, never the sole identifier. */
export function ClientCue({ client }: { client: SignalPost['client'] }) {
  if (!client) return null;
  const branding = resolveClientBranding(client.branding);
  return (
    <span
      className="signal-client-cue"
      style={
        {
          '--client-cue-bg': branding.background,
          '--client-cue-fg': branding.foreground,
        } as CSSProperties
      }
      title={`Client: ${client.name}`}
    >
      <span aria-hidden="true">{clientInitials(client.name)}</span>
      <span>{client.name}</span>
    </span>
  );
}
