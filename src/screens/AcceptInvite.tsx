import { errorMessage } from '../lib/supabase'
import { useEffect, useState } from 'react'
import { useSession } from '../lib/useSession'
import { acceptInvite } from '../lib/org'
import { navigate } from '../lib/route'
import {
  getUrlInviteToken, peekPendingInviteToken, storePendingInviteToken,
  clearPendingInviteToken,
} from '../lib/inviteLink'
import { authLinkError, describeLinkError } from '../lib/authLinks'
import { ConfirmCode } from './ConfirmCode'

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
  // Arriving from a confirmation email whose link no longer works. Before
  // this was read, that visitor was offered "Create account" for the
  // account they had just created.
  const linkError = authLinkError()
  const [enteringCode, setEnteringCode] = useState(linkError !== null)
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
        {!error && !session && enteringCode && (
          <>
            <p className={linkError ? 'error-text' : 'muted'}>
              {linkError
                ? describeLinkError(linkError)
                : 'Enter the email you signed up with and the 6-digit code from your confirmation email.'}
            </p>
            <ConfirmCode />
            <p className="muted" style={{ marginTop: '1rem' }}>
              Haven't created an account yet?{' '}
              <button className="link" onClick={() => navigate('/signup')}>Create one</button>
            </p>
          </>
        )}
        {!error && !session && !enteringCode && (
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
            <p className="muted" style={{ marginTop: '0.25rem' }}>
              Created one but haven't confirmed it?{' '}
              <button className="link" onClick={() => setEnteringCode(true)}>
                Enter your code
              </button>
            </p>
          </>
        )}
        {!error && session && <p className="muted">Just a moment…</p>}
      </div>
    </div>
  )
}
