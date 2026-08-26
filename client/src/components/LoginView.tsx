import { useId, useState, type FormEvent } from 'react';
import { login } from '../api';
import { BrandMark } from './Primitives';
import { DEFAULT_BRANDING } from '../../../shared/branding';
import { brandStyle } from './ui-shared';

/**
 * Single-operator login (C51). Shown only when the API reports `authRequired` and the browser
 * has no live session. Errors are generic — the server never distinguishes a wrong password
 * from a missing account.
 */
export function LoginView({ onAuthenticated }: { onAuthenticated: () => void }) {
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const branding = DEFAULT_BRANDING;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(password);
      setPassword('');
      onAuthenticated();
    } catch (err) {
      setError((err as Error).message || 'Sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-screen" style={brandStyle(branding)}>
      <main className="login-panel" aria-labelledby="login-heading">
        <div className="login-brand">
          <BrandMark branding={branding} />
          <div>
            <p className="eyebrow">Operator access</p>
            <h1 id="login-heading">{branding.title}</h1>
            <p>Sign in with the operator password to open this workspace.</p>
          </div>
        </div>
        <form className="login-form" onSubmit={submit} noValidate>
          <label htmlFor={passwordId}>
            Password
            <input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={submitting || !password}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </main>
    </div>
  );
}
