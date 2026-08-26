import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchAuthStatus } from '../api';
import { LoginView } from './LoginView';
import { BrandMark } from './Primitives';
import { DEFAULT_BRANDING } from '../../../shared/branding';
import { brandStyle } from './ui-shared';

type GateState =
  { kind: 'loading' } | { kind: 'ready' } | { kind: 'login' } | { kind: 'error'; message: string };

/**
 * Asks `/api/auth/status` before mounting the app. Loopback reports `authRequired: false` and
 * proceeds immediately; a hosted bind that needs a session shows the login screen until one
 * exists, then remounts the app so the first data fetch carries the CSRF token.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  const check = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const status = await fetchAuthStatus();
      if (!status.authRequired || status.authenticated) {
        setState({ kind: 'ready' });
        return;
      }
      setState({ kind: 'login' });
    } catch (error) {
      setState({
        kind: 'error',
        message: (error as Error).message || 'Could not reach the command center.',
      });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (state.kind === 'loading') {
    return (
      <div className="splash" style={brandStyle(DEFAULT_BRANDING)}>
        <BrandMark branding={DEFAULT_BRANDING} />
        <p>Organizing your command center…</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="splash" style={brandStyle(DEFAULT_BRANDING)}>
        <BrandMark branding={DEFAULT_BRANDING} />
        <p role="alert">{state.message}</p>
        <button type="button" onClick={() => void check()}>
          Try again
        </button>
      </div>
    );
  }

  if (state.kind === 'login') {
    return <LoginView onAuthenticated={() => void check()} />;
  }

  return <>{children}</>;
}
