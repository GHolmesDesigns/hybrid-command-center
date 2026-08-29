/**
 * Shared helpers for the MCP agent evaluation suite (C134 / #384).
 */
import type { Db } from '../../db.ts';
import type { McpAgentScope } from '../../../shared/mcp-agent-registry.ts';
import { createMcpAgentCredential } from '../../auth/mcp-agent-credentials.ts';
import { createMcpSession, type McpSession } from '../session.ts';
import { callMcpTool, type McpToolDispatchOptions } from '../dispatch.ts';
import type { McpToolCallResult } from '../coordination.ts';
import { approxTokensFromPayloads, type EvalScenarioResult } from './score.ts';
import { EVAL_NOW, seedEvalFixture, type EvalFixtureSeed } from './fixture.ts';

export const EVAL_SESSION_SECRET = 'eval-session-secret-at-least-32-chars!!';
export const EVAL_ALL_SCOPES: readonly McpAgentScope[] = [
  'coordination:read',
  'coordination:write',
  'workspace:read',
  'workspace:write',
];

export type EvalContext = {
  db: Db;
  seed: EvalFixtureSeed;
  now: Date;
};

export function openEvalContext(db: Db, now: Date = EVAL_NOW): EvalContext {
  return { db, seed: seedEvalFixture(db, now), now };
}

export function evalSession(label: string): McpSession {
  return createMcpSession({ agentLabel: label });
}

export function issueEvalCredential(
  db: Db,
  label: string,
  scopes: readonly McpAgentScope[] = EVAL_ALL_SCOPES,
  now: Date = EVAL_NOW,
): { rawToken: string; credentialId: string; label: string } {
  const issued = createMcpAgentCredential(db, {
    label,
    scopes,
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    sessionSecret: EVAL_SESSION_SECRET,
    now: now.getTime(),
  });
  return {
    rawToken: issued.rawToken,
    credentialId: issued.credential.id,
    label: issued.credential.label,
  };
}

export async function evalCallTool(
  db: Db,
  session: McpSession,
  tool: string,
  args: unknown,
  options: Partial<McpToolDispatchOptions> = {},
): Promise<McpToolCallResult> {
  return callMcpTool(db, session, tool, args, {
    grantedScopes: options.grantedScopes ?? EVAL_ALL_SCOPES,
    now: options.now ?? EVAL_NOW,
    transport: options.transport ?? 'stdio',
    authenticated: options.authenticated ?? true,
    workspaceReadDeps: options.workspaceReadDeps,
    workspaceWriteDeps: options.workspaceWriteDeps,
    integrationDeps: options.integrationDeps,
  });
}

export async function timedScenario(
  id: string,
  title: string,
  run: () => Promise<{
    success: boolean;
    evidenceComplete: boolean;
    detail: string;
    payloads?: unknown[];
    defect?: EvalScenarioResult['defect'];
  }>,
): Promise<EvalScenarioResult> {
  const started = performance.now();
  const outcome = await run();
  const latencyMs = Math.round(performance.now() - started);
  return {
    id,
    title,
    defect: outcome.defect,
    success: outcome.success,
    evidenceComplete: outcome.evidenceComplete,
    latencyMs,
    approxTokens: approxTokensFromPayloads(...(outcome.payloads ?? [])),
    detail: outcome.detail,
  };
}
