import type { EvalSmokeConfig } from './config.ts';

export type EvalSmokeClaim = {
  claim: string;
  state: 'verified' | 'failed' | 'skipped';
  evidence: string;
};

export type EvalSmokeResult = {
  claims: EvalSmokeClaim[];
  stopped?: string;
  latencyMs: number;
};

export type EvalSmokeTransport = {
  login: (password: string) => Promise<{ cookie: string; csrfToken: string }>;
  runHealthTest: (
    cookie: string,
    csrfToken: string,
  ) => Promise<{
    status: number;
    body: {
      ok?: boolean;
      workspaceChecksumUnchanged?: boolean;
      status?: { ok?: boolean; checks?: Record<string, { ok?: boolean }> };
      error?: string;
    };
  }>;
};

export async function runEvalMcpSmoke(options: {
  config: EvalSmokeConfig;
  transport: EvalSmokeTransport;
}): Promise<EvalSmokeResult> {
  const started = performance.now();
  const claims: EvalSmokeClaim[] = [];
  try {
    const session = await options.transport.login(options.config.password);
    const response = await options.transport.runHealthTest(session.cookie, session.csrfToken);
    if (response.status !== 200) {
      return {
        claims: [
          {
            claim: 'Operator diagnostic responds',
            state: 'failed',
            evidence: `HTTP ${response.status}: ${response.body.error ?? 'unexpected status'}`,
          },
        ],
        stopped: 'Diagnostic HTTP status was not 200.',
        latencyMs: Math.round(performance.now() - started),
      };
    }
    const ok = response.body.ok === true && response.body.status?.ok === true;
    const checksum = response.body.workspaceChecksumUnchanged === true;
    const checks = response.body.status?.checks ?? {};
    claims.push({
      claim: 'Discovery (tools/list and resources/list) succeeds',
      state: checks.toolsList?.ok && checks.resourcesList?.ok ? 'verified' : 'failed',
      evidence: `toolsList.ok=${String(checks.toolsList?.ok)} resourcesList.ok=${String(checks.resourcesList?.ok)}`,
    });
    claims.push({
      claim: 'One bounded resource read succeeds',
      state: checks.resourceRead?.ok ? 'verified' : 'failed',
      evidence: `resourceRead.ok=${String(checks.resourceRead?.ok)}`,
    });
    claims.push({
      claim: 'Workspace table checksums unchanged (no writes)',
      state: checksum ? 'verified' : 'failed',
      evidence: `workspaceChecksumUnchanged=${String(response.body.workspaceChecksumUnchanged)}`,
    });
    claims.push({
      claim: 'Overall diagnostic ok',
      state: ok ? 'verified' : 'failed',
      evidence: `ok=${String(response.body.ok)} status.ok=${String(response.body.status?.ok)}`,
    });
    const failed = claims.some((claim) => claim.state === 'failed');
    return {
      claims,
      ...(failed ? { stopped: 'One or more smoke claims failed.' } : {}),
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Smoke failed.';
    return {
      claims: [{ claim: 'Smoke transport', state: 'failed', evidence: message }],
      stopped: message,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
