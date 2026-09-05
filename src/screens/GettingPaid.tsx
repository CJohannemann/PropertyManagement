import { useEffect, useState } from 'react'
import {
  fetchConnectStatus, createOnboardingLink, stripeConfigured,
  type ConnectStatus,
} from '../lib/payments'

type Props = { organizationId: string }

/**
 * Connecting the landlord's Stripe account, so tenants have somewhere to
 * send rent.
 *
 * No bank or tax details are collected here — the button hands off to
 * Stripe, which collects all of that itself and sends back an account id.
 */
export function GettingPaid({ organizationId }: Props) {
  const [status, setStatus] = useState<ConnectStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!stripeConfigured) return
    fetchConnectStatus(organizationId)
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [organizationId])

  async function startOnboarding() {
    setBusy(true); setError(null)
    try {
      const { url } = await createOnboardingLink(organizationId)
      // A full navigation, not a new tab: Stripe sends the landlord back
      // to this app when they finish, and a popup would strand that return
      // in a window they've likely already closed.
      window.location.href = url
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (!stripeConfigured) return null
  if (error) {
    return (
      <div className="card-list">
        <div><p className="error-text" style={{ margin: 0 }}>{error}</p></div>
      </div>
    )
  }
  if (!status) return <p className="muted">Checking your payment setup…</p>

  // The finished state. Deliberately quiet — there is nothing to do here
  // once it works, and a loud green panel every time you open the
  // dashboard is noise.
  if (status.connected && status.chargesEnabled && status.payoutsEnabled) {
    return (
      <div className="card-list">
        <div>
          <strong>Online rent payments are on</strong>
          <div className="muted">
            Tenants can pay by bank transfer, and the money goes to the bank
            account you gave Stripe. Transfers take a few business days to
            arrive.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="card-list">
      <div>
        <strong>{status.connected ? 'Finish setting up payments' : 'Get paid online'}</strong>

        {!status.connected && (
          <p className="muted">
            Let tenants pay rent by bank transfer straight into your account.
            Stripe collects your bank and ID details directly — they are
            never stored here.
          </p>
        )}

        {status.connected && status.pendingVerification && (
          <p className="muted">
            Stripe is checking the details you gave them. This usually takes
            a few minutes, sometimes a day or two.
          </p>
        )}

        {status.connected && status.requirementsDue.length > 0 && (
          <p className="muted">
            Stripe still needs a few more details before you can be paid.
          </p>
        )}

        {status.connected && !status.payoutsEnabled && status.chargesEnabled && (
          <p className="muted">
            You can take payments, but Stripe can't pay out to your bank
            yet — usually a missing bank account or ID check.
          </p>
        )}

        <button className="primary" onClick={startOnboarding} disabled={busy}>
          {busy
            ? 'Opening Stripe…'
            : status.connected ? 'Continue with Stripe' : 'Set up payments with Stripe'}
        </button>
      </div>
    </div>
  )
}
