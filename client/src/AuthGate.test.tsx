import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './components/AuthGate';
import { LoginView } from './components/LoginView';
import * as api from './api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AuthGate', () => {
  beforeEach(() => {
    api.setCsrfToken(null);
  });

  it('renders children when auth is not required', async () => {
    vi.spyOn(api, 'fetchAuthStatus').mockResolvedValue({
      authRequired: false,
      authenticated: false,
      csrfToken: null,
    });

    render(
      <AuthGate>
        <p>Workspace open</p>
      </AuthGate>,
    );

    expect(await screen.findByText('Workspace open')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Command Center|Operator/i })).not.toBeInTheDocument();
  });

  it('shows the login screen when a session is required and missing', async () => {
    vi.spyOn(api, 'fetchAuthStatus').mockResolvedValue({
      authRequired: true,
      authenticated: false,
      csrfToken: null,
    });

    render(
      <AuthGate>
        <p>Workspace open</p>
      </AuthGate>,
    );

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByText('Workspace open')).not.toBeInTheDocument();
  });

  it('opens the workspace after a successful login', async () => {
    const status = vi
      .spyOn(api, 'fetchAuthStatus')
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: false,
        csrfToken: null,
      })
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: true,
        csrfToken: 'csrf-after-login',
      });
    vi.spyOn(api, 'login').mockResolvedValue({ ok: true, csrfToken: 'csrf-after-login' });

    render(
      <AuthGate>
        <p>Workspace open</p>
      </AuthGate>,
    );

    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'operator-password-ok' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Workspace open')).toBeInTheDocument();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('surfaces a reachable error with a retry control', async () => {
    vi.spyOn(api, 'fetchAuthStatus')
      .mockRejectedValueOnce(new Error('API unreachable'))
      .mockResolvedValueOnce({
        authRequired: false,
        authenticated: false,
        csrfToken: null,
      });

    render(
      <AuthGate>
        <p>Workspace open</p>
      </AuthGate>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('API unreachable');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Workspace open')).toBeInTheDocument();
  });
});

describe('LoginView', () => {
  it('shows a generic error when sign-in fails', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new Error('Invalid credentials.'));
    const onAuthenticated = vi.fn();

    render(<LoginView onAuthenticated={onAuthenticated} />);

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong-password!!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials.');
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

describe('api CSRF helpers', () => {
  beforeEach(() => {
    api.setCsrfToken(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends credentials and the CSRF header on mutations once a token is known', async () => {
    api.setCsrfToken('csrf-token-1');
    await api.send('/clients', 'POST', { name: 'Covered' });

    expect(fetch).toHaveBeenCalledWith(
      '/api/clients',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          'x-csrf-token': 'csrf-token-1',
        }),
      }),
    );
  });
});
