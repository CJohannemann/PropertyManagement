import { errorMessage } from '../lib/supabase'
import { useState } from 'react'
import {
  recordManualPayment, outstanding, money, chargeLabel, PAYMENT_METHODS,
  type ChargeWithPlace,
} from '../lib/charges'

type Props = {
  charge: ChargeWithPlace
  onRecorded: () => void
  onCancel: () => void
}

/**
 * Recording rent that arrived outside the app.
 *
 * The thing this prevents: a tenant hands over a cheque, nothing in the
 * system knows, and the charge goes overdue — billing late fees against
 * money the landlord is already holding.
 */
export function RecordPayment({ charge, onRecorded, onCancel }: Props) {
  const owed = outstanding(charge)
  // Defaults to settling the charge, which is what usually happened.
  const [amount, setAmount] = useState(String(owed.toFixed(2)))
  const [method, setMethod] = useState<string>('check')
  // Backdatable: the cheque was probably handed over before anyone sat
  // down to type it in.
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await recordManualPayment({
        chargeId: charge.id,
        amount: Number(amount),
        method,
        paidOn,
        note,
      })
      onRecorded()
    } catch (err) {
      // The database refuses an overpayment with the figure actually
      // outstanding, which is more use than anything this form could say.
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: '0.75rem' }}>
      <div className="field">
        <label htmlFor={`amt-${charge.id}`}>How much was paid?</label>
        <input
          id={`amt-${charge.id}`}
          type="number" min="0.01" max={owed} step="0.01" required
          value={amount} onChange={(e) => setAmount(e.target.value)}
        />
        <span className="muted">
          {money(owed)} outstanding on this {chargeLabel(charge.charge_type).toLowerCase()}.
          Less is fine — it records as a part payment.
        </span>
      </div>

      <div className="field">
        <label htmlFor={`method-${charge.id}`}>How did it arrive?</label>
        <select id={`method-${charge.id}`} value={method}
                onChange={(e) => setMethod(e.target.value)}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`when-${charge.id}`}>When did you receive it?</label>
        <input id={`when-${charge.id}`} type="date" required
               value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor={`note-${charge.id}`}>Reference (optional)</label>
        <input id={`note-${charge.id}`} type="text" value={note}
               placeholder="Cheque number, or where it came from"
               onChange={(e) => setNote(e.target.value)} />
        <span className="muted">
          Whatever makes this findable again in six months.
        </span>
      </div>

      {error && <p className="error-text">{error}</p>}

      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Recording…' : 'Record payment'}
      </button>
      <button className="link" type="button" onClick={onCancel}
              style={{ marginTop: '0.5rem' }} disabled={busy}>
        Cancel
      </button>
    </form>
  )
}
