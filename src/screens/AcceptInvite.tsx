import { errorMessage } from '../lib/supabase'
import { useEffect, useState } from 'react'
import { useSession } from '../lib/useSession'
import { acceptInvite } from '../lib/org'
import { navigate } from '../lib/route'
import {
  getUrlInviteToken, peekPendingInviteToken, storePendingInviteToken,
  clearPendingInviteToken,
} from '../lib/inviteLink'

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
  // The URL first, then whatever was stashed on the way through sign-up.
  // The fallback matters when the confirmation email is opened somewhere
  // that strips the query string, and when someone reaches this screen a
  // second time without the original link to hand.
  const token = getUrlInviteToken() ?? peekPendingInviteToken()

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
        // Only on success. A failure here can be a dropped connection as
        // easily as a spent invite, and throwing the token away would turn
        // the first into the second.
        clearPendingInviteToken()
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
        {error && (
          <>
            <p className="error-text">{error}</p>
            <p className="muted">
              Ask whoever invited you to send a new link — invites expire
              after seven days and can only be used once.
            </p>
            {session && (
              <button className="link" onClick={() => navigate('/dashboard')}>
                Go to the app
              </button>
            )}
          </>
        )}
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
