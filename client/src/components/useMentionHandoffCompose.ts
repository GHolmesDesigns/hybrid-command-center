import { useEffect, useMemo, useState } from 'react';
import { knownAgentMentionLabels } from '../../../shared/agent-mentions';

export function useMentionHandoffCompose(body: string, registeredLabels: string[]) {
  const offered = useMemo(
    () => knownAgentMentionLabels(body, registeredLabels),
    [body, registeredLabels],
  );
  const offeredKey = offered.join('\0');
  const [confirmed, setConfirmed] = useState<string[]>([]);

  useEffect(() => {
    setConfirmed(offered);
  }, [offeredKey, offered]);

  const toggle = (label: string) => {
    setConfirmed((current) =>
      current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label],
    );
  };

  return { offered, confirmed, toggle };
}
