import type { Db } from '../db.ts';
import { assistantReady, assistantEncryptionSecret, readCommandAiAssistant } from './settings.ts';
import {
  cancelTurn,
  getTurnState,
  listPendingApprovals,
  respondToApproval,
  runAssistantTurn,
} from './turn.ts';
import type { AssistantPendingApproval, AssistantTurnState } from '../../shared/command-ai-assistant.ts';
import type { CommandAiPageContext } from '../../shared/agent-conversations.ts';
import type { StubAssistantOptions } from './providers/stub.ts';

export type StartTurnOptions = {
  operatorSessionHash: string;
  encryptionSecret?: string;
  stubMode?: boolean;
  stubOptions?: StubAssistantOptions;
  sessionSecret?: string;
  pageContext?: CommandAiPageContext;
};

const turnQueue = new Set<string>();

export function startTurnAfterOperatorMessage(
  db: Db,
  conversationId: string,
  options: StartTurnOptions,
): void {
  if (!assistantReady(db)) return;
  if (turnQueue.has(conversationId)) return;
  turnQueue.add(conversationId);
  const encryptionSecret = options.encryptionSecret ?? assistantEncryptionSecret();
  void runAssistantTurn(db, {
    conversationId,
    operatorSessionHash: options.operatorSessionHash,
    encryptionSecret,
    stubMode: options.stubMode,
    stubOptions: options.stubOptions,
    sessionSecret: options.sessionSecret,
    pageContext: options.pageContext,
  })
    .catch(() => {
      // runAssistantTurn persists its own failure messages
    })
    .finally(() => {
      turnQueue.delete(conversationId);
    });
}

export {
  cancelTurn,
  getTurnState,
  listPendingApprovals,
  respondToApproval,
};

export function assistantSettingsSummary(db: Db) {
  const assistant = readCommandAiAssistant(db);
  return { assistant, ready: assistantReady(db) };
}

export type { AssistantPendingApproval, AssistantTurnState };
