/**
 * Scripted MCP agent scenarios for C134 (#384).
 *
 * Each scenario exercises a multi-step agent workflow against a fixture database. Defects D1–D5
 * each have a case that would fail on the pre-fix commit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../app.ts';
import { createDb, type Db } from '../../db.ts';
import { hashPassword } from '../../auth/password.ts';
import { setSetting } from '../../drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../../auth/service.ts';
import { CSRF_HEADER_NAME } from '../../../shared/auth.ts';
import { MCP_AGENT_LABEL_HEADER, MCP_HTTP_PATH } from '../../../shared/mcp-network.ts';
import { COORDINATION_WRITE_LIMIT_PER_MINUTE } from '../../../shared/mcp-agent-events.ts';
import { MCP_APPROVAL_BOUNDARIES } from '../../../shared/mcp-workspace-context.ts';
import { mcpToolsListPayload } from '../registry.ts';
import { readMcpResource } from '../resources.ts';
import { workspaceDataChecksum } from '../workspace-checksum.ts';
import { buildConnectionStatus } from '../connection-status.ts';
import {
  reclaimWorkSession,
  reclaimableWorkSessions,
} from '../../agent-coordination/work-sessions.ts';
import { EVAL_FIXTURE } from './fixture.ts';
import {
  EVAL_ALL_SCOPES,
  EVAL_SESSION_SECRET,
  evalCallTool,
  evalSession,
  issueEvalCredential,
  openEvalContext,
  timedScenario,
  type EvalContext,
} from './harness.ts';
import type { EvalScenarioResult } from './score.ts';

const PASSWORD = 'eval-operator-password-ok';

async function withHttpApp(
  db: Db,
  run: (helpers: {
    app: ReturnType<typeof createApp>;
    cookie: string;
    csrfToken: string;
    issueScoped: (
      label: string,
      scopes?: readonly string[],
    ) => Promise<{ bearerToken: string; credential: { id: string } }>;
  }) => Promise<{
    success: boolean;
    evidenceComplete: boolean;
    detail: string;
    payloads?: unknown[];
    defect?: EvalScenarioResult['defect'];
  }>,
) {
  const passwordHash = await hashPassword(PASSWORD);
  setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
  const app = createApp(db, {
    enforceAuth: true,
    auth: {
      sessionSecret: EVAL_SESSION_SECRET,
      operatorPasswordHash: passwordHash,
      trustedProxyHops: 0,
      secureCookies: false,
    },
  });
  const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
  const cookie = login.headers['set-cookie']?.[0] as string;
  const csrfToken = login.body.csrfToken as string;

  const issueScoped = async (label: string, scopes: readonly string[] = [...EVAL_ALL_SCOPES]) => {
    const issued = await request(app)
      .post('/api/auth/mcp-agents')
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .send({
        label,
        scopes,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    if (issued.status !== 201) {
      throw new Error(`Credential issue failed: ${issued.status} ${JSON.stringify(issued.body)}`);
    }
    return {
      bearerToken: issued.body.bearerToken as string,
      credential: issued.body.credential as { id: string },
    };
  };

  return run({ app, cookie, csrfToken, issueScoped });
}

export async function runDiscoverTask(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario('discover_task', 'Discovering the correct task', async () => {
    const session = evalSession('cursor-eval');
    const search = await evalCallTool(ctx.db, session, 'workspace_search', {
      query: 'launch caption',
    });
    const listed = await evalCallTool(ctx.db, session, 'workspace_list_tasks', {
      limit: 20,
      offset: 0,
    });
    const subject = await evalCallTool(ctx.db, session, 'workspace_get_subject_context', {
      subjectType: 'task',
      subjectId: ctx.seed.targetTaskId,
    });
    const tasks = (listed.data as { tasks?: Array<{ id: string; title: string }> })?.tasks ?? [];
    const foundInList = tasks.some((task) => task.id === ctx.seed.targetTaskId);
    const searchHits =
      (search.data as { results?: Array<{ subjectType: string; subjectId: string }> })?.results ??
      [];
    const foundInSearch = searchHits.some(
      (hit) => hit.subjectType === 'task' && hit.subjectId === ctx.seed.targetTaskId,
    );
    return {
      success:
        search.outcome === 'SUCCESS' &&
        listed.outcome === 'SUCCESS' &&
        subject.outcome === 'SUCCESS' &&
        foundInList &&
        foundInSearch,
      evidenceComplete: foundInList && foundInSearch,
      detail:
        foundInList && foundInSearch
          ? `Resolved ${EVAL_FIXTURE.targetTaskTitle} via search and list.`
          : 'Target task was not discovered.',
      payloads: [search, listed, subject],
    };
  });
}

export async function runAvoidClaimed(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario('avoid_claimed', 'Avoiding already-claimed work', async () => {
    const session = evalSession('cursor-eval');
    const claim = await evalCallTool(ctx.db, session, 'coordination_claim_handoff', {
      handoffId: ctx.seed.claimedHandoffId,
    });
    return {
      success: claim.outcome === 'REFUSED',
      evidenceComplete: claim.errorDetail?.code === 'COORDINATION_INVALID_STATE',
      detail:
        claim.outcome === 'REFUSED'
          ? 'Second agent correctly refused the claimed handoff.'
          : `Unexpected outcome: ${claim.outcome}`,
      payloads: [claim],
    };
  });
}

export async function runLostResponseRecovery(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario('lost_response', 'Recovering after a lost response (D2)', async () => {
    const session = evalSession('cursor-eval');
    await evalCallTool(ctx.db, session, 'coordination_claim_handoff', {
      handoffId: ctx.seed.openHandoffId,
    });
    const first = await evalCallTool(ctx.db, session, 'coordination_add_note', {
      handoffId: ctx.seed.openHandoffId,
      body: 'First note after claim.',
      clientRequestId: 'eval-note-1',
    });
    const replay = await evalCallTool(ctx.db, session, 'coordination_add_note', {
      handoffId: ctx.seed.openHandoffId,
      body: 'Must not duplicate.',
      clientRequestId: 'eval-note-1',
    });
    const got = await evalCallTool(ctx.db, session, 'coordination_get_handoff', {
      handoffId: ctx.seed.openHandoffId,
    });
    const notes = (got.data as { notes?: unknown[] })?.notes ?? [];
    return {
      success:
        first.outcome === 'SUCCESS' &&
        replay.outcome === 'SUCCESS' &&
        JSON.stringify(first.data) === JSON.stringify(replay.data) &&
        notes.length === 1,
      evidenceComplete: notes.length === 1,
      detail: notes.length === 1 ? 'Idempotent note replay returned one row.' : 'Note duplicated.',
      payloads: [first, replay, got],
      defect: 'D2',
    };
  });
}

export async function runStaleRevision(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario('stale_revision', 'Rejecting a stale revision (C129)', async () => {
    const session = evalSession('cursor-eval');
    const created = await evalCallTool(ctx.db, session, 'signal_create_post', {
      clientRequestId: 'eval-sig-1',
      text: 'Original caption',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const postId = (created.data as { after: { id: string } }).after.id;
    await evalCallTool(ctx.db, session, 'signal_update_post', {
      clientRequestId: 'eval-sig-1b',
      postId,
      revision: 1,
      text: 'Moved on',
    });
    const stale = await evalCallTool(ctx.db, session, 'signal_update_post', {
      clientRequestId: 'eval-sig-1c',
      postId,
      revision: 1,
      text: 'Stale write',
    });
    return {
      success:
        stale.outcome === 'REFUSED' && stale.errorDetail?.code === 'WORKSPACE_REVISION_CONFLICT',
      evidenceComplete:
        (stale.errorDetail as { currentRevision?: number } | undefined)?.currentRevision === 2,
      detail:
        stale.errorDetail?.code === 'WORKSPACE_REVISION_CONFLICT'
          ? 'Stale revision refused with WORKSPACE_REVISION_CONFLICT.'
          : `Unexpected: ${stale.outcome} ${stale.errorDetail?.code ?? ''}`,
      payloads: [created, stale],
    };
  });
}

export async function runResumeCheckpoint(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario('resume_checkpoint', 'Resuming from a checkpoint (C128)', async () => {
    const session = evalSession('cursor-eval');
    await evalCallTool(ctx.db, session, 'coordination_claim_handoff', {
      handoffId: ctx.seed.openHandoffId,
    });
    const started = await evalCallTool(ctx.db, session, 'work_start', {
      handoffId: ctx.seed.openHandoffId,
      baseRevision: 'main',
      leaseSeconds: 900,
      currentStep: 'inspect',
    });
    const sessionId = (started.data as { id: string }).id;
    const checkpoint = await evalCallTool(ctx.db, session, 'work_checkpoint', {
      sessionId,
      currentStep: 'implement',
      evidence: { changedPaths: ['server/mcp/eval/scenarios.ts'] },
      validations: [{ command: 'npm test', outcome: 'pass' }],
    });
    const resume = await evalCallTool(ctx.db, session, 'work_get_resume_context', { sessionId });
    const step = (resume.data as { currentStep?: string } | undefined)?.currentStep;
    return {
      success:
        started.outcome === 'SUCCESS' &&
        checkpoint.outcome === 'SUCCESS' &&
        resume.outcome === 'SUCCESS' &&
        step === 'implement',
      evidenceComplete: step === 'implement',
      detail:
        step === 'implement' ? 'Resume context restored the checkpoint step.' : 'Resume missed.',
      payloads: [started, checkpoint, resume],
    };
  });
}

export async function runValidationEvidence(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario(
    'validation_evidence',
    'Reporting validation evidence (D4 / C125)',
    async () => {
      const session = evalSession('cursor-eval');
      await evalCallTool(ctx.db, session, 'coordination_claim_handoff', {
        handoffId: ctx.seed.openHandoffId,
      });
      const bare = await evalCallTool(ctx.db, session, 'coordination_complete_handoff', {
        handoffId: ctx.seed.openHandoffId,
      });
      const complete = await evalCallTool(ctx.db, session, 'coordination_complete_handoff', {
        handoffId: ctx.seed.openHandoffId,
        clientRequestId: 'eval-complete-1',
        resultSummary: 'Caption drafted and checks passed.',
        outcome: 'SUCCEEDED',
        changedPaths: ['client/src/Signal.tsx'],
        validations: [{ command: 'npm run typecheck', outcome: 'pass' }],
      });
      const got = await evalCallTool(ctx.db, session, 'coordination_get_handoff', {
        handoffId: ctx.seed.openHandoffId,
      });
      const handoff = got.data as {
        state?: string;
        resultSummary?: string;
        outcome?: string;
        validations?: unknown[];
      };
      return {
        success:
          bare.outcome !== 'SUCCESS' &&
          complete.outcome === 'SUCCESS' &&
          handoff.state === 'COMPLETED' &&
          handoff.outcome === 'SUCCEEDED' &&
          Boolean(handoff.resultSummary),
        evidenceComplete: Array.isArray(handoff.validations) && handoff.validations.length === 1,
        detail:
          handoff.outcome === 'SUCCEEDED'
            ? 'Completion required classified evidence and persisted validations.'
            : 'Completion evidence missing.',
        payloads: [bare, complete, got],
        defect: 'D4',
      };
    },
  );
}

export async function runApprovalBoundary(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario(
    'approval_boundary',
    'Respecting the publish and Drive approval boundary',
    async () => {
      const session = evalSession('cursor-eval');
      const caps = await evalCallTool(ctx.db, session, 'system_capabilities', {
        sections: ['approvalBoundaries', 'tools'],
      });
      const data = caps.data as {
        approvalBoundaries?: Array<{ id: string }>;
        tools?: Array<{ name: string; class: string }>;
      };
      const boundaryIds = new Set((data.approvalBoundaries ?? []).map((b) => b.id));
      const required = MCP_APPROVAL_BOUNDARIES.map((b) => b.id);
      const hasBoundaries = required.every((id) => boundaryIds.has(id));
      const toolNames = mcpToolsListPayload().map((tool) => tool.name);
      const forbidden = toolNames.filter((name) =>
        /publish_now|submit_publish|drive_upload|drive_delete|drive_move|drive_rename/.test(name),
      );
      const before = workspaceDataChecksum(ctx.db);
      const status = buildConnectionStatus(ctx.db, {
        transport: 'stdio',
        authenticated: true,
        agentLabel: 'cursor-eval',
        grantedScopes: EVAL_ALL_SCOPES,
        now: ctx.now,
      });
      const after = workspaceDataChecksum(ctx.db);
      return {
        success:
          caps.outcome === 'SUCCESS' &&
          hasBoundaries &&
          forbidden.length === 0 &&
          status.ok &&
          before === after,
        evidenceComplete: hasBoundaries && before === after,
        detail: hasBoundaries
          ? 'Approval boundaries present; no publish/Drive write tools; checksum unchanged.'
          : 'Approval boundary missing or write tool exposed.',
        payloads: [caps, { toolNames, forbidden, checksum: before === after }],
        defect: 'D5',
      };
    },
  );
}

export async function runExpiredLease(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario('expired_lease', 'Handling an expired lease', async () => {
    const session = evalSession('cursor-eval');
    await evalCallTool(ctx.db, session, 'coordination_claim_handoff', {
      handoffId: ctx.seed.openHandoffId,
    });
    const started = await evalCallTool(ctx.db, session, 'work_start', {
      handoffId: ctx.seed.openHandoffId,
      baseRevision: 'main',
      leaseSeconds: 30,
    });
    const sessionId = (started.data as { id: string }).id;
    const later = new Date(ctx.now.getTime() + 120_000);
    const reclaimable = reclaimableWorkSessions(ctx.db, later);
    const reclaimed = reclaimWorkSession(ctx.db, sessionId, undefined, later);
    const heartbeat = await evalCallTool(
      ctx.db,
      session,
      'work_heartbeat',
      { sessionId },
      { now: later },
    );
    return {
      success:
        reclaimable.some((row) => row.id === sessionId) &&
        reclaimed.state === 'ABANDONED' &&
        heartbeat.outcome === 'FAILURE',
      evidenceComplete: reclaimed.state === 'ABANDONED',
      detail:
        reclaimed.state === 'ABANDONED'
          ? 'Expired lease reclaimed; further mutate refused.'
          : 'Lease reclaim failed.',
      payloads: [started, reclaimed, heartbeat],
    };
  });
}

export async function runUsefulHandoff(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario('useful_handoff', 'Producing a useful operator handoff', async () => {
    const poster = evalSession('planner');
    const worker = evalSession('cursor-eval');
    const posted = await evalCallTool(ctx.db, poster, 'coordination_post_handoff', {
      subjectType: 'task',
      subjectId: ctx.seed.targetTaskId,
      toAgentLabel: 'cursor-eval',
      message: 'Please finish the caption and prove it.',
      clientRequestId: 'eval-post-useful',
    });
    const handoffId = (posted.data as { id: string }).id;
    await evalCallTool(ctx.db, worker, 'coordination_claim_handoff', { handoffId });
    await evalCallTool(ctx.db, worker, 'coordination_add_note', {
      handoffId,
      body: 'Draft ready for review.',
      clientRequestId: 'eval-useful-note',
    });
    const complete = await evalCallTool(ctx.db, worker, 'coordination_complete_handoff', {
      handoffId,
      clientRequestId: 'eval-useful-complete',
      resultSummary: 'Caption ready; typecheck green.',
      outcome: 'SUCCEEDED',
      references: ['#384'],
      validations: [{ command: 'npm run typecheck', outcome: 'pass' }],
    });
    const got = await evalCallTool(ctx.db, worker, 'coordination_get_handoff', { handoffId });
    const handoff = got.data as {
      state?: string;
      resultSummary?: string;
      references?: string[];
    };
    return {
      success:
        complete.outcome === 'SUCCESS' &&
        handoff.state === 'COMPLETED' &&
        Boolean(handoff.resultSummary) &&
        Array.isArray(handoff.references),
      evidenceComplete: handoff.references?.includes('#384') === true,
      detail:
        handoff.state === 'COMPLETED'
          ? 'Operator handoff completed with summary and references.'
          : 'Handoff incomplete.',
      payloads: [posted, complete, got],
    };
  });
}

export async function runDuplicateMutations(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario(
    'duplicate_mutations',
    'Avoiding duplicate mutations after retries (C117)',
    async () => {
      const session = evalSession('cursor-eval');
      const first = await evalCallTool(ctx.db, session, 'signal_create_post', {
        clientRequestId: 'eval-dup-sig',
        text: 'Idempotent draft',
        channels: ['ig'],
        status: 'DRAFT',
      });
      const replay = await evalCallTool(ctx.db, session, 'signal_create_post', {
        clientRequestId: 'eval-dup-sig',
        text: 'Must not insert again',
        channels: ['ig'],
        status: 'DRAFT',
      });
      const count = (
        ctx.db.prepare('SELECT COUNT(*) AS n FROM signal_posts').get() as { n: number }
      ).n;
      return {
        success:
          first.outcome === 'SUCCESS' &&
          replay.outcome === 'SUCCESS' &&
          JSON.stringify(first.data) === JSON.stringify(replay.data) &&
          count === 1,
        evidenceComplete: count === 1,
        detail: count === 1 ? 'Retry replayed without a second row.' : 'Duplicate mutation landed.',
        payloads: [first, replay, { count }],
        defect: 'D2',
      };
    },
  );
}

export async function runTwoIdentities(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario(
    'two_identities',
    'Connecting from two independent remote agent identities',
    async () => {
      const a = issueEvalCredential(ctx.db, 'cursor-planning');
      const b = issueEvalCredential(ctx.db, 'codex-release');
      const sessionA = evalSession(a.label);
      const sessionB = evalSession(b.label);
      const postA = await evalCallTool(ctx.db, sessionA, 'coordination_post_handoff', {
        subjectType: 'freeform',
        message: 'From cursor-planning',
        clientRequestId: 'eval-id-a',
      });
      const postB = await evalCallTool(ctx.db, sessionB, 'coordination_post_handoff', {
        subjectType: 'freeform',
        message: 'From codex-release',
        clientRequestId: 'eval-id-b',
      });
      return {
        success:
          postA.outcome === 'SUCCESS' &&
          postB.outcome === 'SUCCESS' &&
          (postA.data as { fromAgentLabel: string }).fromAgentLabel === 'cursor-planning' &&
          (postB.data as { fromAgentLabel: string }).fromAgentLabel === 'codex-release',
        evidenceComplete: a.credentialId !== b.credentialId,
        detail: 'Two credentials posted under distinct server-bound labels.',
        payloads: [postA, postB],
      };
    },
  );
}

export async function runImpersonationRefused(db: Db): Promise<EvalScenarioResult> {
  return timedScenario(
    'impersonation',
    'Proving one credential cannot impersonate another by changing a header (D3)',
    async () =>
      withHttpApp(db, async ({ app, issueScoped }) => {
        const issued = await issueScoped('cursor-planning', [
          'coordination:read',
          'coordination:write',
        ]);
        const refused = await request(app)
          .post(MCP_HTTP_PATH)
          .set('Authorization', `Bearer ${issued.bearerToken}`)
          .set(MCP_AGENT_LABEL_HEADER, 'codex-release')
          .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const accepted = await request(app)
          .post(MCP_HTTP_PATH)
          .set('Authorization', `Bearer ${issued.bearerToken}`)
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'coordination_post_handoff',
              arguments: { subjectType: 'freeform', message: 'Bound identity.' },
            },
          });
        const payload =
          accepted.status === 200 && accepted.body.result?.content?.[0]?.text
            ? JSON.parse(accepted.body.result.content[0].text)
            : null;
        return {
          success:
            refused.status === 400 &&
            refused.body.error?.data?.code === 'COORDINATION_CREDENTIAL_LABEL_MISMATCH' &&
            payload?.fromAgentLabel === 'cursor-planning',
          evidenceComplete:
            refused.body.error?.data?.code === 'COORDINATION_CREDENTIAL_LABEL_MISMATCH',
          detail:
            refused.body.error?.data?.code === 'COORDINATION_CREDENTIAL_LABEL_MISMATCH'
              ? 'Header spoof refused; effective label stayed server-bound.'
              : 'Impersonation was not refused.',
          payloads: [refused.body, accepted.body],
          defect: 'D3',
        };
      }),
  );
}

export async function runRevokeOne(db: Db): Promise<EvalScenarioResult> {
  return timedScenario(
    'revoke_one',
    'Revoking one agent without interrupting other connected agents',
    async () =>
      withHttpApp(db, async ({ app, cookie, csrfToken, issueScoped }) => {
        const first = await issueScoped('cursor-eval-a', ['coordination:read']);
        const second = await issueScoped('cursor-eval-b', ['coordination:read']);
        const revoked = await request(app)
          .post(`/api/auth/mcp-credentials/${first.credential.id}/revoke`)
          .set('Cookie', cookie)
          .set(CSRF_HEADER_NAME, csrfToken);
        const firstCall = await request(app)
          .post(MCP_HTTP_PATH)
          .set('Authorization', `Bearer ${first.bearerToken}`)
          .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        const secondCall = await request(app)
          .post(MCP_HTTP_PATH)
          .set('Authorization', `Bearer ${second.bearerToken}`)
          .send({ jsonrpc: '2.0', id: 2, method: 'ping' });
        return {
          success: revoked.status === 200 && firstCall.status === 401 && secondCall.status === 200,
          evidenceComplete: firstCall.status === 401 && secondCall.status === 200,
          detail:
            secondCall.status === 200
              ? 'Revoked credential rejected; sibling agent still connected.'
              : 'Sibling agent interrupted.',
          payloads: [revoked.body, { first: firstCall.status, second: secondCall.status }],
        };
      }),
  );
}

export async function runRateLimitPersistence(db: Db): Promise<EvalScenarioResult> {
  return timedScenario(
    'rate_limit',
    'Network write rate limit persists across requests (D1)',
    async () =>
      withHttpApp(db, async ({ app, cookie, csrfToken, issueScoped }) => {
        const issued = await issueScoped('rate-agent', ['coordination:read', 'coordination:write']);
        let lastStatus = 0;
        let lastBody: unknown = null;
        for (let i = 0; i < COORDINATION_WRITE_LIMIT_PER_MINUTE + 1; i += 1) {
          const res = await request(app)
            .post(MCP_HTTP_PATH)
            .set('Authorization', `Bearer ${issued.bearerToken}`)
            .send({
              jsonrpc: '2.0',
              id: i + 1,
              method: 'tools/call',
              params: {
                name: 'coordination_post_handoff',
                arguments: {
                  subjectType: 'freeform',
                  message: `Rate write ${i}`,
                  clientRequestId: `eval-rate-${i}`,
                },
              },
            });
          lastStatus = res.status;
          lastBody = res.body;
        }
        const body = lastBody as {
          result?: { isError?: boolean; content?: Array<{ text: string }> };
        };
        const text = body.result?.content?.[0]?.text;
        const payload = text ? (JSON.parse(text) as { outcome?: string; error?: string }) : null;
        const refused =
          body.result?.isError === true &&
          payload?.outcome === 'REFUSED' &&
          Boolean(payload.error?.toLowerCase().includes('rate limit'));
        void cookie;
        void csrfToken;
        return {
          success: lastStatus === 200 && refused,
          evidenceComplete: refused,
          detail: refused
            ? '11th coordination write refused under the persistent per-credential ceiling.'
            : 'Rate limit did not persist across HTTP requests.',
          payloads: [payload],
          defect: 'D1',
        };
      }),
  );
}

export async function runCursorAfterRestart(): Promise<EvalScenarioResult> {
  return timedScenario(
    'cursor_restart',
    'Recovering a change cursor after a server restart (C132)',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-eval-'));
      const file = path.join(dir, 'eval.db');
      try {
        const first = createDb(file);
        const tipBody = readMcpResource(first, 'hcc://coordination/changes', {
          grantedScopes: ['coordination:read'],
        });
        const tip = JSON.parse(tipBody.text) as { cursor: string };
        const session = evalSession('cursor-eval');
        const posted = await evalCallTool(first, session, 'coordination_post_handoff', {
          subjectType: 'freeform',
          message: 'Survive restart.',
          clientRequestId: 'eval-restart-post',
        });
        const handoffId = (posted.data as { id: string }).id;
        first.close();

        const second = createDb(file);
        const pageBody = readMcpResource(
          second,
          `hcc://coordination/changes?after=${encodeURIComponent(tip.cursor)}`,
          { grantedScopes: ['coordination:read'] },
        );
        const page = JSON.parse(pageBody.text) as {
          status: string;
          changes: Array<{ kind: string; entityId: string | null }>;
        };
        second.close();
        return {
          success:
            page.status === 'ok' &&
            page.changes.some(
              (change) => change.kind === 'handoff.posted' && change.entityId === handoffId,
            ),
          evidenceComplete: page.status === 'ok',
          detail:
            page.status === 'ok'
              ? 'Cursor from before restart still reads the posted change.'
              : 'Cursor recovery failed.',
          payloads: [tip, page],
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

export async function runReadOnlyChecksumSmoke(ctx: EvalContext): Promise<EvalScenarioResult> {
  return timedScenario(
    'readonly_checksum',
    'Read-only diagnostic changes no workspace tables',
    async () => {
      const before = workspaceDataChecksum(ctx.db);
      const session = evalSession('cursor-eval');
      const status = await evalCallTool(ctx.db, session, 'system_connection_status', {});
      const caps = await evalCallTool(ctx.db, session, 'system_capabilities', {
        sections: ['workspace'],
      });
      const after = workspaceDataChecksum(ctx.db);
      return {
        success:
          status.outcome === 'SUCCESS' &&
          caps.outcome === 'SUCCESS' &&
          (status.data as { ok?: boolean }).ok === true &&
          before === after,
        evidenceComplete: before === after,
        detail:
          before === after
            ? 'Discovery and bounded read left workspace checksum unchanged.'
            : 'Checksum moved during a read-only path.',
        payloads: [status, caps, { before, after }],
      };
    },
  );
}

/** Full fixture suite — each scenario gets a fresh database except restart (owns its file). */
export async function runAllFixtureScenarios(): Promise<EvalScenarioResult[]> {
  const results: EvalScenarioResult[] = [];

  const runIsolated = async (
    name: string,
    fn: (ctx: EvalContext) => Promise<EvalScenarioResult>,
  ) => {
    const db = createDb(':memory:');
    try {
      results.push(await fn(openEvalContext(db)));
    } finally {
      db.close();
    }
  };

  await runIsolated('discover', runDiscoverTask);
  await runIsolated('avoid', runAvoidClaimed);
  await runIsolated('lost', runLostResponseRecovery);
  await runIsolated('stale', runStaleRevision);
  await runIsolated('resume', runResumeCheckpoint);
  await runIsolated('evidence', runValidationEvidence);
  await runIsolated('boundary', runApprovalBoundary);
  await runIsolated('dup', runDuplicateMutations);
  await runIsolated('lease', runExpiredLease);
  await runIsolated('handoff', runUsefulHandoff);
  await runIsolated('identities', runTwoIdentities);
  await runIsolated('checksum', runReadOnlyChecksumSmoke);

  {
    const db = createDb(':memory:');
    try {
      results.push(await runImpersonationRefused(db));
    } finally {
      db.close();
    }
  }
  {
    const db = createDb(':memory:');
    try {
      results.push(await runRevokeOne(db));
    } finally {
      db.close();
    }
  }
  {
    const db = createDb(':memory:');
    try {
      results.push(await runRateLimitPersistence(db));
    } finally {
      db.close();
    }
  }

  results.push(await runCursorAfterRestart());
  return results;
}
