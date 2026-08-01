/**
 * AuthPage.jsx — login for the demo account.
 *
 * Registration is gone: this build serves one shared, pre-indexed corpus, so
 * the only account is the demo one. Its credentials are printed on the card and
 * pre-filled in the fields — the visitor just hits Log in.
 */

import { useState } from 'react';
import { login, setToken } from '../api.js';

const DEMO_EMAIL    = 'demo@gmail.com';
const DEMO_PASSWORD = 'demo123';

export default function AuthPage({ onAuth }) {
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const { token, user } = await login(email.trim(), password);
      setToken(token);
      onAuth(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="wordmark">OpenCrawl</h1>
        <p className="auth-sub">Demo — log in to the shared demo account.</p>
        <p className="auth-demo-hint">
          Email {DEMO_EMAIL} · password {DEMO_PASSWORD}
        </p>

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <div className="auth-actions">
          <button className="btn" type="submit" disabled={busy}>
            Log in
          </button>
        </div>
      </form>
    </div>
  );
}
