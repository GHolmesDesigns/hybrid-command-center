import type { SignalChannel } from './signal.ts';

export const PUBLICATION_STATES = [
  'SUBMITTING',
  'SUBMITTED',
  'CONFIRMED',
  'PARTIAL',
  'FAILED',
  'UNCONFIRMED',
  'CANCELLED',
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export interface PublishTargetPreview {
  channel: SignalChannel;
  platform: string;
  accountId: number;
  handle: string;
}

export interface PublishPreview {
  available: boolean;
  postId: string;
  planHash: string;
  caption: string;
  scheduledInstant?: string;
  timezone?: string;
  targets: PublishTargetPreview[];
  warnings: string[];
  refusals: string[];
}

export interface SignalPublication {
  id: string;
  postId: string;
  state: PublicationState;
  provider: string;
  providerPostId?: string;
  scheduledInstant: string;
  timezone: string;
  sentCaption: string;
  sentChannels: SignalChannel[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
