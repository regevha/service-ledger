import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../auth';

export function LoginScreen({ notice }: { notice: string | null }) {
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <div className="masthead">
        <span className="mark" /> ServiceLedger
      </div>
      <form className="section login-form" onSubmit={(e) => void handleSubmit(e)}>
        <div className="section-title">Sign in</div>
        {notice && <div className="banner banner-warn">{notice}</div>}
        {error && (
          <div className="banner banner-crit" role="alert">
            {error}
          </div>
        )}
        <label className="schema-form-label">
          Username
          <input
            type="text"
            className="text-input"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="schema-form-label">
          Password
          <input
            type="password"
            className="text-input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="cta-row">
          <button type="submit" className="btn primary" disabled={busy || !username.trim() || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
