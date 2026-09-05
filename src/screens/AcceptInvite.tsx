import { errorMessage } from '../lib/supabase'
import { useEffect, useState } from 'react'
import { useSession } from '../lib/useSession'
import { acceptInvite } from '../lib/org'
import { navigate } from '../lib/route'
import { getUrlInviteToken, storePendingInviteToken } from '../lib/inviteLink'

/**
 * Landing screen for an invite link (?token=...). If the visitor is
 * already signed in, accepts the invite immediately. Otherwise stores the
 * token and sends them to sign up or log in first — App.tsx's session
 * effect picks the token back up and accepts it once they're authenticated,
 * since accept_invite() requires auth.uid() to already be set.
 */
export function AcceptInvite() {
  const { session, checking } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const token = getUrlInviteToken()

  useEffect(() => {
    if (checking) return
    if (!token) {
      setError('This invite link is missing its token.')
      return
    }
    if (!session) {
      storePendingInviteToken(token)
      return
    }
    acceptInvite(token)
      .then(() => {
        setDone(true)
        navigate('/dashboard', { replace: true })
      })
      .catch((err) => setError(errorMessage(err)))
  }, [checking, session, token])

  if (done) return null

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Accepting invite</h1>
        {error && <p className="error-text">{error}</p>}
        {!error && !session && (
          <>
            <p className="muted" style={{ marginBottom: '1rem' }}>
              Create an account or sign in to accept this invite.
            </p>
            <button className="primary" onClick={() => navigate('/signup')}>
              Create account
            </button>
            <p className="muted" style={{ marginTop: '0.75rem' }}>
              Already have an account?{' '}
              <button className="link" onClick={() => navigate('/login')}>
                Sign in
              </button>
            </p>
          </>
        )}
        {!error && session && <p className="muted">Just a moment…</p>}
      </div>
    </div>
  )
}
