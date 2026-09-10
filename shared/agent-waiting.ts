export const WAITING_INBOX_KINDS = [
  'WORK_SESSION',
  'HANDOFF',
  'DRIVE_WRITE',
  'AGENT_ACTIVITY',
] as const;
export type WaitingInboxKind = (typeof WAITING_INBOX_KINDS)[number];
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
