import { CSRF_HEADER_NAME } from '../../shared/auth.ts';
import type { EvalSmokeTransport } from './smoke.ts';

export function fetchEvalSmokeTransport(baseUrl: string): EvalSmokeTransport {
  return {
    async login(password) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        throw new Error(`Login failed with HTTP ${response.status}.`);
      }
      const body = (await response.json()) as { csrfToken?: string };
      const cookie = response.headers.getSetCookie?.()?.[0] ?? response.headers.get('set-cookie');
      if (!cookie || !body.csrfToken) {
        throw new Error('Login did not return a session cookie and CSRF token.');
      }
      return { cookie, csrfToken: body.csrfToken };
    },
    async runHealthTest(cookie, csrfToken) {
      const response = await fetch(`${baseUrl}/api/mcp/health/test`, {
        method: 'POST',
        headers: {
          cookie,
          [CSRF_HEADER_NAME]: csrfToken,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      const body = (await response.json()) as {
        ok?: boolean;
        workspaceChecksumUnchanged?: boolean;
        status?: { ok?: boolean; checks?: Record<string, { ok?: boolean }> };
        error?: string;
      };
      return { status: response.status, body };
    },
  };
}
