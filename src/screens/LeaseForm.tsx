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

/**
 * The end date of a standard 12-month term: a lease starting 2026-09-01
 * runs through 2027-08-31, not 2027-09-01 — the last day of the twelfth
 * month, not the first day of the thirteenth.
 *
 * Built in UTC and from the date's own parts rather than by parsing the
 * string as local time, which shifts the day backwards for anyone west of
 * UTC and would quietly hand them a lease ending a day early. A start of
 * Feb 29 lands on Feb 28 the following year, which is the right answer.
 */
function oneYearTerm(startIso: string): string {
  const [y, m, d] = startIso.split('-').map(Number)
  if (!y || !m || !d) return ''
  const end = new Date(Date.UTC(y + 1, m - 1, d))
  end.setUTCDate(end.getUTCDate() - 1)
  return end.toISOString().slice(0, 10)
}

export function LeaseForm({ unitId, stateCode, onCreated, onCancel }: Props) {
  const [reg, setReg] = useState<StateRegulation | null | 'loading'>('loading')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  // Once the end date has been set by hand, changing the start date must
  // not silently overwrite it — the auto-fill is a convenience, and
  // clobbering a deliberate entry is worse than not filling it at all.
  const [endDateEdited, setEndDateEdited] = useState(false)
  const [rentAmount, setRentAmount] = useState('')
  const [rentDueDay, setRentDueDay] = useState('1')
  const [depositAmount, setDepositAmount] = useState('')
  const [petDeposit, setPetDeposit] = useState('')
  const [otherDeposit, setOtherDeposit] = useState('')
  const [otherDepositLabel, setOtherDepositLabel] = useState('')
  const [nonrefundableFee, setNonrefundableFee] = useState('')
  const [nonrefundableFeeLabel, setNonrefundableFeeLabel] = useState('')
  const [proratedRent, setProratedRent] = useState('')
  const [nsfFee, setNsfFee] = useState('')
  const [lateFeeAutoApply, setLateFeeAutoApply] = useState(false)
  const [lateFeeType, setLateFeeType] = useState<'percent' | 'flat'>('percent')
  const [lateFeeAmount, setLateFeeAmount] = useState('')
  const [lateFeeGraceDays, setLateFeeGraceDays] = useState('')
  const [lateFeeDailyAmount, setLateFeeDailyAmount] = useState('')
  const [lateFeeDailyStartDays, setLateFeeDailyStartDays] = useState('')
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
      // Empty stays null rather than becoming 0: "no pet deposit agreed"
      // and "a pet deposit of zero" read the same on screen but the first
      // should not put a $0 line on the lease document.
      const num = (s: string) => (s.trim() === '' ? null : Number(s))
      const text = (s: string) => (s.trim() === '' ? null : s.trim())

      await createLease({
        unitId,
        startDate,
        endDate: endDate || null,
        rentAmount: Number(rentAmount),
        rentDueDay: Number(rentDueDay),
        depositAmount: Number(depositAmount || 0),
        petDepositAmount: num(petDeposit),
        otherDepositAmount: num(otherDeposit),
        otherDepositLabel: text(otherDepositLabel),
        nonrefundableFeeAmount: num(nonrefundableFee),
        nonrefundableFeeLabel: text(nonrefundableFeeLabel),
        proratedRentAmount: num(proratedRent),
        nsfFeeAmount: num(nsfFee),
        lateFeeAutoApply,
        lateFeeType: lateFeeAutoApply ? lateFeeType : null,
        lateFeeAmount: lateFeeAutoApply ? num(lateFeeAmount) : null,
        lateFeeGraceDays: num(lateFeeGraceDays),
        lateFeeDailyAmount: lateFeeAutoApply ? num(lateFeeDailyAmount) : null,
        lateFeeDailyStartDays: lateFeeAutoApply ? num(lateFeeDailyStartDays) : null,
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
            onChange={(e) => {
              const v = e.target.value
              setStartDate(v)
              if (!endDateEdited) setEndDate(v ? oneYearTerm(v) : '')
            }} />
        </div>
        <div className="field">
          <label htmlFor="l-end">End date (optional)</label>
          <input id="l-end" type="date" value={endDate}
            onChange={(e) => { setEndDateEdited(true); setEndDate(e.target.value) }} />
          <span className="muted">
            Defaults to a 12-month term. Clear it for a month-to-month lease.
          </span>
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
          <label htmlFor="l-prorated">Prorated first month ($)</label>
          <input id="l-prorated" type="number" min="0" step="0.01" value={proratedRent}
            onChange={(e) => setProratedRent(e.target.value)} />
          <span className="muted">
            For a term starting mid-month. Billed once, dated the start date.
          </span>
        </div>

        <h4 style={{ margin: '1.5rem 0 0.5rem' }}>Deposits and fees</h4>
        <p className="muted" style={{ marginTop: 0 }}>
          Anything entered here is billed once at move-in, alongside the
          prorated rent. Leave blank if it doesn't apply.
        </p>

        <div className="field">
          <label htmlFor="l-dep">Security deposit ($)</label>
          <input id="l-dep" type="number" min="0" step="0.01" value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="l-petdep">Pet deposit ($)</label>
          <input id="l-petdep" type="number" min="0" step="0.01" value={petDeposit}
            onChange={(e) => setPetDeposit(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="l-othdep">Other deposit ($)</label>
          <input id="l-othdep" type="number" min="0" step="0.01" value={otherDeposit}
            onChange={(e) => setOtherDeposit(e.target.value)} />
        </div>
        {otherDeposit.trim() !== '' && (
          <div className="field">
            <label htmlFor="l-othdeplbl">What is the other deposit for?</label>
            <input id="l-othdeplbl" type="text" value={otherDepositLabel}
              onChange={(e) => setOtherDepositLabel(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="l-nrfee">Non-refundable fee ($)</label>
          <input id="l-nrfee" type="number" min="0" step="0.01" value={nonrefundableFee}
            onChange={(e) => setNonrefundableFee(e.target.value)} />
        </div>
        {nonrefundableFee.trim() !== '' && (
          <div className="field">
            <label htmlFor="l-nrfeelbl">What is the fee for?</label>
            <input id="l-nrfeelbl" type="text" placeholder="e.g. Move-in fee"
              value={nonrefundableFeeLabel}
              onChange={(e) => setNonrefundableFeeLabel(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="l-nsf">Returned payment (NSF) fee ($)</label>
          <input id="l-nsf" type="number" min="0" step="0.01" value={nsfFee}
            onChange={(e) => setNsfFee(e.target.value)} />
          <span className="muted">
            Stated on the lease. Charged only if a payment is returned, not up front.
          </span>
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
            <div className="field">
              <label htmlFor="l-lfdaily">Additional daily fee ($ per day)</label>
              <input id="l-lfdaily" type="number" min="0" step="0.01"
                value={lateFeeDailyAmount}
                onChange={(e) => setLateFeeDailyAmount(e.target.value)} />
              <span className="muted">
                Optional, charged on top of the one-off fee for each day the
                rent stays unpaid. Stops accruing once it's paid.
              </span>
            </div>
            {lateFeeDailyAmount.trim() !== '' && (
              <div className="field">
                <label htmlFor="l-lfdailystart">Daily fee starts this many days late</label>
                <input id="l-lfdailystart" type="number" min="0" required
                  value={lateFeeDailyStartDays}
                  onChange={(e) => setLateFeeDailyStartDays(e.target.value)} />
                <span className="muted">
                  That day is itself charged — "starts at 6" means the first
                  daily charge lands on day 6.
                </span>
              </div>
            )}
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
