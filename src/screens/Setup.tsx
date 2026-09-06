import { errorMessage, supabase } from '../lib/supabase'
import { useEffect, useState } from 'react'
import { createOrganization, acceptInvite } from '../lib/org'
import { navigate } from '../lib/route'
import { peekPendingInviteToken, clearPendingInviteToken } from '../lib/inviteLink'

/**
 * First-run screen for an account that belongs to no organization.
 *
 * Two very different people land here, and until now the screen only
 * addressed one of them. Dashboard.tsx sends anyone with no membership to
 * /setup, which is right for a landlord setting up their own account — and
 * wrong for an invited tenant whose invite silently failed to be accepted.
 * They were shown a form to name an organization, and create_organization()
 * answered "this account is not permitted to create an organization"
 * (db/migrations/003_restrict_org_creation.sql), which is true, unhelpful,
 * and the end of the road.
 *
 * So: if an invite is still pending, offer to finish it. If creating an
 * organization is refused, say what to do about it.
 */
export function Setup() {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notPermitted, setNotPermitted] = useState(false)
  const [myEmail, setMyEmail] = useState<string | null>(null)
  const [pendingToken] = useState(peekPendingInviteToken)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Shown only in the refusal message below, so the person can tell whoever
  // runs the server which address to permit — and can spot that they signed
  // up under a different one than they were invited at.
  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => setMyEmail(data.user?.email ?? null))
  }, [])

  async function finishInvite() {
    if (!pendingToken) return
    setBusy(true)
    setInviteError(null)
    try {
      await acceptInvite(pendingToken)
      clearPendingInviteToken()
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setInviteError(errorMessage(err))
      setBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createOrganization(name)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      const message = errorMessage(err)
      // Matched on the message because that is all the function returns —
      // it raises deliberately vaguely, so an anonymous signup cannot probe
      // which addresses are on the allowlist. The vagueness is for a
      // stranger; the person reading this screen still needs a next step.
      if (message.includes('not permitted to create an organization')) {
        setNotPermitted(true)
      } else {
        setError(message)
      }
      setBusy(false)
    }
  }

  if (pendingToken) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Finish accepting your invite</h1>
          <p className="muted" style={{ marginBottom: '1rem' }}>
            Your account is ready, but it isn't connected to the account
            that invited you yet.
          </p>
          {inviteError && (
            <>
              <p className="error-text">{inviteError}</p>
              <p className="muted">
                Ask whoever invited you to send a new link — invites expire
                after seven days and can only be used once.
              </p>
            </>
          )}
          <button className="primary" onClick={finishInvite} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect my account'}
          </button>
        </div>
      </div>
    )
  }

  if (notPermitted) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>This account isn't set up yet</h1>
          <p className="muted">
            {myEmail ? <><strong>{myEmail}</strong> can't</> : "This account can't"}
            {' '}create an organization of its own.
          </p>
          <p className="muted">
            If you were invited — as a tenant, or to help manage
            properties — open the invite link that was sent to you. That
            link is what joins this account to the right organization, and
            signing up on its own doesn't do it. Check the address above is
            the one your invite went to.
          </p>
          <p className="muted">
            If you're setting up your own rentals here, ask whoever runs
            this server to allow{myEmail ? ` ${myEmail}` : ' your address'}.
          </p>
          <button className="link" onClick={() => setNotPermitted(false)}>
            ← Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Name your organization</h1>
        <p className="muted" style={{ marginBottom: '1rem' }}>
          This is the account your properties, staff, and tenants will all
          live under — e.g. your name or the name of your rental business.
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="org-name">Organization name</label>
            <input
              id="org-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create organization'}
          </button>
        </form>
      </div>
    </div>
  )
}
