import { useState } from 'react'
import { supabase, describeError } from '../lib/supabase'
import { navigate } from '../lib/route'
import { getUrlInviteToken } from '../lib/inviteLink'

export function SignUp() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const invited = getUrlInviteToken() !== null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signUp({ email, password })
    setBusy(false)
    if (error) setError(describeError(error))
    // On success, App.tsx's session effect handles where to go next —
    // accepting a pending invite, or /setup for a brand-new account.
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>{invited ? 'Create your account' : 'Sign up'}</h1>
        {invited && (
          <p className="muted" style={{ marginBottom: '1rem' }}>
            You've been invited to a property management account. Create a
            password to accept it.
          </p>
        )}
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
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="muted" style={{ marginTop: '1rem' }}>
          Already have an account?{' '}
          <button className="link" onClick={() => navigate('/login')}>
            Sign in
          </button>
        </p>
      </div>
    </div>
  )
}
