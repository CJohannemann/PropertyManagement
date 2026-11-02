import { useState } from 'react'
import { supabase, describeError } from '../lib/supabase'
import { navigate } from '../lib/route'
import { authLinkError, describeLinkError, sendPasswordReset } from '../lib/authLinks'
import { ConfirmCode } from './ConfirmCode'

export function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Signing in to an account whose email was never confirmed. GoTrue says
  // "Email not confirmed" and nothing more, which left no way forward.
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const linkError = authLinkError()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) {
      if (/not confirmed/i.test(error.message)) {
        setUnconfirmed(true)
        setError(null)
      } else {
        setError(describeError(error))
      }
    }
    // On success, App.tsx's session effect handles where to go next.
  }

  async function reset(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await sendPasswordReset(email)
      setResetSent(true)
    } catch (err) {
      setError(describeError(err as Error))
    }
    setBusy(false)
  }

  if (unconfirmed) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Confirm your email</h1>
          <p className="muted">
            Your account exists, but <strong>{email}</strong> hasn't been
            confirmed yet. Enter the 6-digit code from the confirmation
            email — or send a new one.
          </p>
          <ConfirmCode initialEmail={email} />
          <button className="link" onClick={() => setUnconfirmed(false)} style={{ marginTop: '0.5rem' }}>
            ← Back to sign in
          </button>
        </div>
      </div>
    )
  }

  if (resetting) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Reset your password</h1>
          {resetSent ? (
            <p className="muted">
              If <strong>{email}</strong> has an account, a reset link is on
              its way. Open it on this device to choose a new password.
            </p>
          ) : (
            <form onSubmit={reset}>
              <div className="field">
                <label htmlFor="reset-email">Email</label>
                <input id="reset-email" type="email" autoComplete="email" required value={email}
                  onChange={(e) => setEmail(e.target.value)} />
              </div>
              {error && <p className="error-text">{error}</p>}
              <button className="primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a reset link'}
              </button>
            </form>
          )}
          <button className="link" style={{ marginTop: '1rem' }}
            onClick={() => { setResetting(false); setResetSent(false); setError(null) }}>
            ← Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Sign in</h1>
        {linkError && <p className="error-text">{describeLinkError(linkError)}</p>}
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <button className="link" style={{ marginTop: '0.75rem' }}
          onClick={() => { setResetting(true); setError(null) }}>
          Forgot your password?
        </button>
        <p className="muted" style={{ marginTop: '1rem' }}>
          Don't have an account?{' '}
          <button className="link" onClick={() => navigate('/signup')}>
            Sign up
          </button>
        </p>
      </div>
    </div>
  )
}
