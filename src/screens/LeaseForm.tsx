import { useEffect, useState } from 'react'
import { createLease } from '../lib/leases'
import { fetchStateRegulation, type StateRegulation } from '../lib/regulations'

type Props = {
  unitId: string
  /** The property's state, e.g. 'KY' — drives the late-fee limits below. */
  stateCode: string
  onCreated: () => void
  onCancel: () => void
}

export function LeaseForm({ unitId, stateCode, onCreated, onCancel }: Props) {
  const [reg, setReg] = useState<StateRegulation | null | 'loading'>('loading')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rentAmount, setRentAmount] = useState('')
  const [rentDueDay, setRentDueDay] = useState('1')
  const [depositAmount, setDepositAmount] = useState('')
  const [lateFeeAutoApply, setLateFeeAutoApply] = useState(false)
  const [lateFeeType, setLateFeeType] = useState<'percent' | 'flat'>('percent')
  const [lateFeeAmount, setLateFeeAmount] = useState('')
  const [lateFeeGraceDays, setLateFeeGraceDays] = useState('')
  const [feePayer, setFeePayer] = useState<'landlord' | 'tenant'>('landlord')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchStateRegulation(stateCode)
      .then((r) => {
        setReg(r)
        // Prefill from the state's own rules rather than hardcoded numbers,
        // so this stays correct as other states get added to the table.
        if (r) {
          if (r.max_late_fee_type && r.max_late_fee_type !== 'none') {
            setLateFeeType(r.max_late_fee_type)
            if (r.max_late_fee_value !== null) setLateFeeAmount(String(r.max_late_fee_value))
          }
          setLateFeeGraceDays(String(r.min_grace_days))
          if (r.tenant_paid_processing_fee_allowed === true) setFeePayer('tenant')
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [stateCode])

  const verified = reg !== 'loading' && reg !== null
  const tenantFeeAllowed = verified && reg.tenant_paid_processing_fee_allowed === true

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createLease({
        unitId,
        startDate,
        endDate: endDate || null,
        rentAmount: Number(rentAmount),
        rentDueDay: Number(rentDueDay),
        depositAmount: Number(depositAmount || 0),
        lateFeeAutoApply,
        lateFeeType: lateFeeAutoApply ? lateFeeType : null,
        lateFeeAmount: lateFeeAutoApply && lateFeeAmount ? Number(lateFeeAmount) : null,
        lateFeeGraceDays: lateFeeGraceDays ? Number(lateFeeGraceDays) : null,
        feePayer,
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  if (reg === 'loading') return <p className="muted">Loading state rules…</p>

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '1rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>New lease</h3>

        {!verified && (
          <p className="error-text">
            No verified rent regulations on file for {stateCode.toUpperCase()}.
            Automatic late fees and tenant-paid processing fees are disabled
            until someone checks that state's rules — everything else on this
            lease still works.
          </p>
        )}

        <div className="field">
          <label htmlFor="l-start">Start date</label>
          <input id="l-start" type="date" required value={startDate}
            onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="l-end">End date (optional)</label>
          <input id="l-end" type="date" value={endDate}
            onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="l-rent">Monthly rent ($)</label>
          <input id="l-rent" type="number" min="1" step="0.01" required value={rentAmount}
            onChange={(e) => setRentAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="l-due">Rent due on day of month (1–28)</label>
          <input id="l-due" type="number" min="1" max="28" required value={rentDueDay}
            onChange={(e) => setRentDueDay(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="l-dep">Security deposit ($)</label>
          <input id="l-dep" type="number" min="0" step="0.01" value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="l-payer">Who pays the payment processing fee?</label>
          <select id="l-payer" value={feePayer}
            onChange={(e) => setFeePayer(e.target.value as 'landlord' | 'tenant')}>
            <option value="landlord">Landlord (you absorb it)</option>
            <option value="tenant" disabled={!tenantFeeAllowed}>
              Tenant {tenantFeeAllowed ? '' : '(not confirmed allowed in this state)'}
            </option>
          </select>
          {feePayer === 'tenant' && (
            <span className="muted">
              This must also be disclosed in the signed lease document, not
              only shown at checkout.
            </span>
          )}
        </div>

        <div className="field">
          <label>
            <input type="checkbox" checked={lateFeeAutoApply} disabled={!verified}
              onChange={(e) => setLateFeeAutoApply(e.target.checked)} />
            {' '}Automatically apply a late fee
          </label>
          {verified && reg.source_citation && (
            <span className="muted">
              {reg.state_code} limit:{' '}
              {reg.max_late_fee_type === 'none'
                ? 'no cap on file'
                : `${reg.max_late_fee_value}${reg.max_late_fee_type === 'percent' ? '% of rent' : ' dollars'}`}
              , minimum {reg.min_grace_days}-day grace ({reg.source_citation}).
            </span>
          )}
        </div>

        {lateFeeAutoApply && (
          <>
            <div className="field">
              <label htmlFor="l-lftype">Late fee type</label>
              <select id="l-lftype" value={lateFeeType}
                onChange={(e) => setLateFeeType(e.target.value as 'percent' | 'flat')}>
                <option value="percent">Percent of rent</option>
                <option value="flat">Flat amount</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="l-lfamt">
                Late fee {lateFeeType === 'percent' ? '(%)' : '($)'}
              </label>
              <input id="l-lfamt" type="number" min="0" step="0.01" required
                value={lateFeeAmount} onChange={(e) => setLateFeeAmount(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="l-lfgrace">Days late before it applies</label>
              <input id="l-lfgrace" type="number" min={verified ? reg.min_grace_days : 0}
                required value={lateFeeGraceDays}
                onChange={(e) => setLateFeeGraceDays(e.target.value)} />
            </div>
          </>
        )}

        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Create lease'}
        </button>
        <button className="link" type="button" onClick={onCancel} style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}
