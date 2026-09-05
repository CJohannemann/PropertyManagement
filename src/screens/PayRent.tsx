import { errorMessage } from '../lib/supabase'
import { useEffect, useState } from 'react'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import {
  createPaymentIntent, stripeFor, centsToMoney, stripeConfigured,
  type PaymentBreakdown, type PaymentIntentResponse,
} from '../lib/payments'
import { chargeLabel, type ChargeWithPlace } from '../lib/charges'

type Props = { charge: ChargeWithPlace; onDone: () => void }

/**
 * Paying one rent charge by bank transfer.
 *
 * The amount is never sent from here — only the charge id. The server
 * works out what is outstanding and what the fee is, so there is nothing
 * on this screen a tampered client could use to pay less than it owes.
 */
export function PayRent({ charge, onDone }: Props) {
  const [intent, setIntent] = useState<PaymentIntentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    createPaymentIntent(charge.id)
      .then(setIntent)
      .catch((e) => setError(errorMessage(e)))
  }, [charge.id])

  if (!stripeConfigured) {
    return (
      <div className="card-list" style={{ marginTop: '1rem' }}>
        <div>
          <p style={{ marginTop: 0 }}>Online payment isn't set up on this site yet.</p>
          <button className="link" onClick={onDone}>Back</button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card-list" style={{ marginTop: '1rem' }}>
        <div>
          <p className="error-text" style={{ marginTop: 0 }}>{error}</p>
          <button className="link" onClick={onDone}>Back</button>
        </div>
      </div>
    )
  }

  if (!intent) return <p className="muted">Getting your payment ready…</p>

  return (
    <Elements
      stripe={stripeFor(intent.stripeAccount)}
      options={{ clientSecret: intent.clientSecret }}
    >
      <PayRentForm charge={charge} breakdown={intent.breakdown} onDone={onDone} />
    </Elements>
  )
}

function PayRentForm({
  charge, breakdown, onDone,
}: { charge: ChargeWithPlace; breakdown: PaymentBreakdown; onDone: () => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return
    setBusy(true); setError(null)

    const { error: submitError } = await elements.submit()
    if (submitError) {
      setError(submitError.message ?? 'Check the details above.')
      setBusy(false)
      return
    }

    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/dashboard` },
      // ACH doesn't need a redirect, so staying on the page keeps the
      // "it's on its way" message below in front of the tenant instead of
      // bouncing them through a reload.
      redirect: 'if_required',
    })

    if (confirmError) {
      setError(confirmError.message ?? 'That payment could not be started.')
      setBusy(false)
      return
    }

    // Deliberately not "paid". The bank has accepted the instruction; the
    // money has not moved yet, and the ledger won't say paid until Stripe
    // confirms settlement days from now. Telling a tenant their rent is
    // paid at this moment would be a lie they might act on.
    setSent(true)
    setBusy(false)
  }

  if (sent) {
    return (
      <div className="card-list" style={{ marginTop: '1rem' }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Payment started</h3>
          <p>
            Your bank is sending {centsToMoney(breakdown.totalCents)} to your
            landlord. Bank transfers usually take a few business days to
            clear, and this charge will show as paid once it does.
          </p>
          <p className="muted">
            Leave the money in your account until then — if the transfer
            bounces, the rent goes back to being owed.
          </p>
          <button className="primary" onClick={onDone}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '1rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>
          Pay {chargeLabel(charge.charge_type)}
        </h3>

        <div className="muted" style={{ marginBottom: '1rem' }}>
          {charge.leases?.units?.properties?.name}
          {charge.leases?.units?.label ? ` · ${charge.leases.units.label}` : ''}
          {' · due '}{charge.due_date}
        </div>

        {/* Itemised rather than one total: when the lease passes the
            processing fee to the tenant, they should see it named, not
            discover their rent is mysteriously a few dollars more. */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{chargeLabel(charge.charge_type)}</span>
            <span>{centsToMoney(breakdown.rentCents)}</span>
          </div>
          {breakdown.feeCents > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="muted">Bank transfer fee</span>
              <span className="muted">{centsToMoney(breakdown.feeCents)}</span>
            </div>
          )}
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontWeight: 600, marginTop: '0.5rem',
          }}>
            <span>Total</span>
            <span>{centsToMoney(breakdown.totalCents)}</span>
          </div>
        </div>

        <PaymentElement />

        {error && <p className="error-text" style={{ marginTop: '1rem' }}>{error}</p>}

        <p className="muted" style={{ marginTop: '1rem' }}>
          Paid by bank transfer. It takes a few business days to reach your
          landlord.
        </p>

        <button className="primary" type="submit" disabled={!stripe || busy}>
          {busy ? 'Starting…' : `Pay ${centsToMoney(breakdown.totalCents)}`}
        </button>
        <button className="link" type="button" onClick={onDone}
          style={{ marginTop: '0.5rem' }} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}
