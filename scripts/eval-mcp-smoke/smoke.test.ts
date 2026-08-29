import { describe, expect, it } from 'vitest';
import { parseEvalSmokeArgs } from './config.ts';
import { renderEvalSmokeMatrix, renderEvalSmokePlan } from './report.ts';
import { runEvalMcpSmoke, type EvalSmokeTransport } from './smoke.ts';

const baseConfig = {
  mode: 'live' as const,
  baseUrl: 'https://hcc.example.com',
  password: 'secret',
};

describe('eval MCP smoke config', () => {
  it('plans by default and refuses live without --yes or password', () => {
    const plan = parseEvalSmokeArgs(['--base-url', 'https://hcc.example.com'], {});
    expect(plan.config?.mode).toBe('plan');

    const noYes = parseEvalSmokeArgs(['--live', '--base-url', 'https://hcc.example.com'], {
      HCC_EVAL_SMOKE_PASSWORD: 'x',
    });
    expect(noYes.config).toBeUndefined();
    expect(noYes.refusals.some((item) => /--yes/.test(item))).toBe(true);

    const noPassword = parseEvalSmokeArgs(
      ['--live', '--yes', '--base-url', 'https://hcc.example.com'],
      {},
    );
    expect(noPassword.config).toBeUndefined();
    expect(noPassword.refusals.some((item) => /HCC_EVAL_SMOKE_PASSWORD/.test(item))).toBe(true);
  });

  it('accepts a live configuration with password from the environment', () => {
    const live = parseEvalSmokeArgs(['--live', '--yes', '--base-url', 'https://hcc.example.com/'], {
      HCC_EVAL_SMOKE_PASSWORD: 'operator-secret',
    });
    expect(live.config).toEqual({
      mode: 'live',
      baseUrl: 'https://hcc.example.com',
      password: 'operator-secret',
    });
  });

  it('refuses unknown args, missing values, and unsafe URLs', () => {
    expect(parseEvalSmokeArgs(['oops'], {}).refusals[0]).toMatch(/Unknown argument/);
    expect(
      parseEvalSmokeArgs(['--base-url'], {}).refusals.some((item) => /no value/.test(item)),
    ).toBe(true);
    expect(
      parseEvalSmokeArgs(['--base-url', 'ftp://hcc.example.com'], {}).refusals.some((item) =>
        /http: or https:/.test(item),
      ),
    ).toBe(true);
    expect(
      parseEvalSmokeArgs(['--base-url', 'https://user:pass@hcc.example.com'], {}).refusals.some(
        (item) => /credentials/.test(item),
      ),
    ).toBe(true);
    expect(
      parseEvalSmokeArgs(['--base-url', 'https://hcc.example.com?x=1'], {}).refusals.some((item) =>
        /query/.test(item),
      ),
    ).toBe(true);
    expect(
      parseEvalSmokeArgs(['--base-url', 'https://hcc.example.com#frag'], {}).refusals.some((item) =>
        /hash/.test(item),
      ),
    ).toBe(true);
    expect(
      parseEvalSmokeArgs(['--base-url', 'not a url'], {}).refusals.some((item) =>
        /not a valid URL/.test(item),
      ),
    ).toBe(true);
    expect(parseEvalSmokeArgs([], {}).refusals.some((item) => /exactly once/.test(item))).toBe(
      true,
    );
    expect(
      parseEvalSmokeArgs(['--password', 'leak'], {}).refusals.some((item) =>
        /Unknown argument/.test(item),
      ),
    ).toBe(true);
    expect(parseEvalSmokeArgs(['--help'], {}).refusals.length).toBeGreaterThan(0);
    expect(parseEvalSmokeArgs(['--base-url', 'http://127.0.0.1:8787'], {}).config?.baseUrl).toBe(
      'http://127.0.0.1:8787',
    );
  });
});

describe('eval MCP smoke runner', () => {
  it('verifies discovery, bounded read, and unchanged checksums', async () => {
    const transport: EvalSmokeTransport = {
      login: async () => ({ cookie: 'sid=1', csrfToken: 'csrf' }),
      runHealthTest: async () => ({
        status: 200,
        body: {
          ok: true,
          workspaceChecksumUnchanged: true,
          status: {
            ok: true,
            checks: {
              toolsList: { ok: true },
              resourcesList: { ok: true },
              resourceRead: { ok: true },
            },
          },
        },
      }),
    };
    const result = await runEvalMcpSmoke({ config: baseConfig, transport });
    expect(result.stopped).toBeUndefined();
    expect(result.claims.every((claim) => claim.state === 'verified')).toBe(true);
    const matrix = renderEvalSmokeMatrix(result, new Date('2026-08-29T16:00:00.000Z'));
    expect(matrix).toContain('Production smoke matrix');
    expect(renderEvalSmokePlan(baseConfig)).toContain('read-only diagnostic');
    expect(renderEvalSmokePlan({ ...baseConfig, mode: 'plan' })).toContain(
      'Nothing will be contacted',
    );
  });

  it('stops when the checksum moves', async () => {
    const transport: EvalSmokeTransport = {
      login: async () => ({ cookie: 'sid=1', csrfToken: 'csrf' }),
      runHealthTest: async () => ({
        status: 200,
        body: {
          ok: true,
          workspaceChecksumUnchanged: false,
          status: {
            ok: true,
            checks: {
              toolsList: { ok: true },
              resourcesList: { ok: true },
              resourceRead: { ok: true },
            },
          },
        },
      }),
    };
    const result = await runEvalMcpSmoke({ config: baseConfig, transport });
    expect(result.stopped).toBeTruthy();
    expect(result.claims.find((claim) => /checksum/i.test(claim.claim))?.state).toBe('failed');
    expect(renderEvalSmokeMatrix(result, new Date('2026-08-29T16:00:00.000Z'))).toContain(
      'Stopped:',
    );
  });

  it('stops on a non-200 diagnostic and on transport failure', async () => {
    const badStatus = await runEvalMcpSmoke({
      config: baseConfig,
      transport: {
        login: async () => ({ cookie: 'sid=1', csrfToken: 'csrf' }),
        runHealthTest: async () => ({
          status: 401,
          body: { error: 'Unauthorized' },
        }),
      },
    });
    expect(badStatus.stopped).toMatch(/not 200/);
    expect(badStatus.claims[0]?.state).toBe('failed');

    const thrown = await runEvalMcpSmoke({
      config: baseConfig,
      transport: {
        login: async () => {
          throw new Error('network down');
        },
        runHealthTest: async () => ({ status: 200, body: {} }),
      },
    });
    expect(thrown.stopped).toBe('network down');
    expect(thrown.claims[0]?.evidence).toBe('network down');

    const nonError = await runEvalMcpSmoke({
      config: baseConfig,
      transport: {
        login: async () => {
          throw 'boom';
        },
        runHealthTest: async () => ({ status: 200, body: {} }),
      },
    });
    expect(nonError.stopped).toBe('Smoke failed.');

    const failedChecks = await runEvalMcpSmoke({
      config: baseConfig,
      transport: {
        login: async () => ({ cookie: 'sid=1', csrfToken: 'csrf' }),
        runHealthTest: async () => ({
          status: 200,
          body: {
            ok: false,
            workspaceChecksumUnchanged: true,
            status: {
              ok: false,
              checks: {
                toolsList: { ok: false },
                resourcesList: { ok: true },
                resourceRead: { ok: false },
              },
            },
          },
        }),
      },
    });
    expect(failedChecks.stopped).toBeTruthy();
    expect(failedChecks.claims.some((claim) => claim.state === 'failed')).toBe(true);
  });

  it('escapes pipe characters in the matrix', () => {
    const matrix = renderEvalSmokeMatrix(
      {
        claims: [{ claim: 'A | B', state: 'verified', evidence: 'x | y' }],
        latencyMs: 12,
      },
      new Date('2026-08-29T16:00:00.000Z'),
    );
    expect(matrix).toContain('A \\| B');
    expect(matrix).toContain('x \\| y');
  });
});
