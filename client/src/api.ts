import { CSRF_HEADER_NAME, type AuthStatusResponse } from '../../shared/auth.ts';

/** Latest CSRF token from `/api/auth/status` or a successful login. */
let csrfToken: string | null = null;

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  if (MUTATING.has(method) && csrfToken && path !== '/auth/login') {
    headers[CSRF_HEADER_NAME] = csrfToken;
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    method,
    credentials: 'include',
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(data.error || 'Something went wrong.'), {
      status: response.status,
      data,
    });
  return data as T;
}

export const send = <T>(path: string, method: string, body?: unknown) =>
  api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const status = await api<AuthStatusResponse>('/auth/status');
  setCsrfToken(status.csrfToken);
  return status;
}

export async function login(password: string): Promise<{ ok: true; csrfToken: string }> {
  const result = await api<{ ok: true; csrfToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  setCsrfToken(result.csrfToken);
  return result;
}

export async function logout(): Promise<void> {
  await api<{ ok: true }>('/auth/logout', { method: 'POST' });
  setCsrfToken(null);
}
