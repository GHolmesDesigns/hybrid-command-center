import type { AgentWorkSession, AgentWorkSessionState } from '../../shared/agent-work-sessions.ts';
export class AgentWorkSessionError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'AgentWorkSessionError';
    this.status = status;
  }
}
export function leaseLive(session: Pick<AgentWorkSession, 'leaseExpiresAt'>, now: Date): boolean {
  return !!session.leaseExpiresAt && Date.parse(session.leaseExpiresAt) > now.getTime();
}
export function canMutate(
  session: Pick<AgentWorkSession, 'agentLabel' | 'state'>,
  agentLabel: string,
  allowed: AgentWorkSessionState[],
): void {
  if (session.agentLabel !== agentLabel)
    throw new AgentWorkSessionError('Only the session owner may mutate this work session.', 409);
  if (!allowed.includes(session.state))
    throw new AgentWorkSessionError(
      `Work session is ${session.state} and cannot take that action.`,
      409,
    );
}
