export type WaitingInboxKind = 'WORK_SESSION' | 'HANDOFF' | 'DRIVE_WRITE' | 'AGENT_ACTIVITY';
export type WaitingInboxItem = {
  id: string;
  kind: WaitingInboxKind;
  agent: string;
  waitingSince: string;
  destination: string;
  resolutionPath: string;
  detail: string;
};
export type WaitingInboxResponse = {
  items: WaitingInboxItem[];
  warnings: string[];
};
