import { useEffect } from 'react'
import { useSession } from './lib/useSession'
import { useRoute, navigate } from './lib/route'
import { supabaseConfigured } from './lib/supabase'
import { acceptInvite } from './lib/org'
import { takePendingInviteToken } from './lib/inviteLink'
import { SignIn } from './screens/SignIn'
import { SignUp } from './screens/SignUp'
import { Setup } from './screens/Setup'
import { AcceptInvite } from './screens/AcceptInvite'
import { ResetPassword } from './screens/ResetPassword'
import { Dashboard } from './screens/Dashboard'
import { NotFound } from './screens/NotFound'

export default function App() {
  const { session, checking, recovery, clearRecovery } = useSession()
  const route = useRoute()

  /**
   * The redirects the routes can't express on their own. Kept in an effect
   * rather than a navigate() mid-render, since changing history while React
   * renders is a side effect during a phase that's supposed to be pure —
   * same reasoning as FarmHand's App.tsx.
   *
   * A pending invite token (see lib/inviteLink.ts) is consumed here, right
   * after a session appears — accept_invite() needs auth.uid() set, which
   * is exactly the moment this fires. Dashboard.tsx separately sends a
   * signed-in user with zero memberships to /setup, which covers both "just
   * signed up with no invite" and "the invite token was bad" without this
   * effect needing to know the difference.
   */
  useEffect(() => {
    if (checking || recovery || !supabaseConfigured) return

    if (!session) {
      if (route === '/dashboard' || route === '/setup') {
        navigate('/login', { replace: true })
      }
      return
    }

    if (route === '/login' || route === '/signup' || route === '/') {
      const pending = takePendingInviteToken()
      if (pending) {
        acceptInvite(pending).finally(() => navigate('/dashboard', { replace: true }))
      } else {
        navigate('/dashboard', { replace: true })
      }
    }
  }, [route, session, checking, recovery])

  if (!supabaseConfigured) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Backend not configured</h1>
          <p className="muted">
            Copy .env.example to .env and fill in VITE_SUPABASE_URL /
            VITE_SUPABASE_ANON_KEY.
          </p>
        </div>
      </div>
    )
  }

  if (checking) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p className="muted">Loading…</p>
        </div>
      </div>
    )
  }

  if (recovery) {
    return <ResetPassword onDone={clearRecovery} />
  }

  switch (route) {
    case '/login':
      return session ? null : <SignIn />
    case '/signup':
      return session ? null : <SignUp />
    case '/accept-invite':
      return <AcceptInvite />
    case '/setup':
      return session ? <Setup /> : null
    case '/dashboard':
      return session ? <Dashboard /> : null
    case '/':
      return null
    default:
      return <NotFound />
  }
}
