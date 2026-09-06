import { useState } from 'react'
import { supabase, describeError } from '../lib/supabase'
import { navigate } from '../lib/route'
import {
  getUrlInviteToken, peekPendingInviteToken, inviteUrlFor,
} from '../lib/inviteLink'

export function SignUp() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Set once the account exists but the address still needs confirming. */
  const [confirmSent, setConfirmSent] = useState(false)

  // Storage as well as the URL. AcceptInvite sends an invited visitor here
  // with navigate('/signup'), and navigate() builds a path with no query
  // string — so the token this screen was reached *because of* is not in
  // the address bar. Reading only the URL meant the invited copy below
  // never once rendered, and the confirmation email had nothing to aim at.
  const token = getUrlInviteToken() ?? peekPendingInviteToken()
  const invited = token !== null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      // Where the confirmation email lands. Pointed at the invite link
      // rather than the site root so the token comes back in the URL: the
      // mail is usually opened on a different device or browser from the
      // one that signed up, where nothing this app stored locally exists.
      // GOTRUE_URI_ALLOW_LIST is APP_URL/**, which covers this path.
      options: token ? { emailRedirectTo: inviteUrlFor(token) } : undefined,
    })
    setBusy(false)
    if (error) {
      setError(describeError(error))
      return
    }
    // GOTRUE_MAILER_AUTOCONFIRM is off, so a successful signUp returns a
    // user and NO session — there is nothing for App.tsx's session effect
    // to react to. Without this the screen simply went quiet, leaving
    // someone who had done everything right with no idea an email was on
    // its way. If confirmation is ever turned off, a session comes back
    // instead and that effect takes over as before.
    if (!data.session) setConfirmSent(true)
  }

  if (confirmSent) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Confirm your email</h1>
          <p className="muted">
            We've sent a message to <strong>{email}</strong>. Open it and
            follow the link to finish{invited ? ' accepting your invite' : ''}.
          </p>
          <p className="muted">
            The link opens this app again{invited
              ? ' and puts you straight into your landlord\'s account.'
              : '.'} You can close this page.
          </p>
          <p className="muted">
            Nothing arrived? Check the spam folder{invited
              ? ', or ask whoever invited you to send a fresh link'
              : ''}.
          </p>
        </div>
      </div>
    )
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
            {invited && (
              <span className="muted">
                Use the address your invite was sent to.
              </span>
            )}
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
